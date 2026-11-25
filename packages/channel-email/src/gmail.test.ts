import { describe, expect, it } from "vite-plus/test";
import { bodyOf, createGmailReader, GmailError, parseFrom } from "./gmail.ts";

const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  labelIds: ["INBOX"],
  internalDate: String(Date.parse("2026-11-24T10:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: '"Dana, A" <dana@acme.test>' },
      { name: "Subject", value: `Subject ${id}` },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64(`plain ${id}`) } },
      { mimeType: "text/html", body: { data: b64(`<p>html ${id}</p>`) } },
    ],
  },
  ...over,
});

/** A fake Gmail: routes by path, records the calls. */
const gmail = (routes: Record<string, () => Response>) => {
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    calls.push(`${input} ${(init?.headers as Record<string, string>)?.authorization}`);
    const url = new URL(input);
    const hit = Object.entries(routes).find(([path]) => `${url.pathname}`.endsWith(path));
    return hit ? hit[1]() : new Response("", { status: 500 });
  };
  return { calls, reader: createGmailReader({ fetch }) };
};

describe("createGmailReader", () => {
  it("starts at the mailbox's present without reading mail", async () => {
    const g = gmail({ "/profile": () => json({ historyId: "100" }) });
    expect(await g.reader.sync({ token: "tok", cursor: null, limit: 10 })).toEqual({
      messages: [],
      cursor: "100",
    });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toContain("Bearer tok");
  });

  it("reads inbox mail added since the cursor, skipping promotions, spam and deleted mail", async () => {
    const g = gmail({
      "/history": () =>
        json({
          history: [
            { id: "101", messagesAdded: [{ message: { id: "a" } }, { message: { id: "a" } }] },
            { id: "102", messagesAdded: [{ message: { id: "b" } }, { message: { id: "gone" } }] },
            { id: "103", messagesAdded: [{ message: { id: "promo" } }] },
            { id: "104" },
          ],
          historyId: "110",
        }),
      "/messages/a": () => json(message("a")),
      "/messages/b": () =>
        json(
          message("b", {
            payload: {
              ...message("b").payload,
              parts: [
                {
                  mimeType: "text/html",
                  body: { data: b64("<style>x{}</style><p>Hi &amp; bye<br>there</p>") },
                },
              ],
            },
          }),
        ),
      "/messages/gone": () => new Response("", { status: 404 }),
      "/messages/promo": () =>
        json(message("promo", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] })),
    });
    const out = await g.reader.sync({ token: "t", cursor: "100", limit: 10 });
    expect(out.cursor).toBe("110");
    expect(out.messages.map((m) => m.messageId)).toEqual(["a", "b"]);
    expect(out.messages[0]).toEqual({
      messageId: "a",
      threadId: "t-a",
      fromName: "Dana, A",
      fromAddress: "dana@acme.test",
      subject: "Subject a",
      body: "plain a",
      receivedAt: "2026-11-24T10:00:00.000Z",
    });
    expect(out.messages[1]!.body).toContain("Hi & bye");
    expect(g.calls.filter((c) => c.includes("/history"))).toHaveLength(1);
    expect(g.calls[0]).toContain("startHistoryId=100");
  });

  it("stops at the limit and puts the cursor after the last record it read", async () => {
    const g = gmail({
      "/history": () =>
        json({
          history: [
            { id: "101", messagesAdded: [{ message: { id: "a" } }] },
            { id: "102", messagesAdded: [{ message: { id: "b" } }] },
            { id: "103", messagesAdded: [{ message: { id: "c" } }] },
          ],
          historyId: "110",
        }),
      "/messages/a": () => json(message("a")),
      "/messages/b": () => json(message("b")),
    });
    const out = await g.reader.sync({ token: "t", cursor: "100", limit: 2 });
    expect(out.messages.map((m) => m.messageId)).toEqual(["a", "b"]);
    expect(out.cursor).toBe("102");
  });

  it("follows history pages and keeps the cursor when nothing is new", async () => {
    let page = 0;
    const g = gmail({
      "/history": () => {
        page++;
        return page === 1
          ? json({
              history: [{ id: "101", messagesAdded: [{ message: { id: "a" } }] }],
              nextPageToken: "n",
            })
          : json({});
      },
      "/messages/a": () => json(message("a")),
    });
    const out = await g.reader.sync({ token: "t", cursor: "100", limit: 10 });
    expect(out.messages).toHaveLength(1);
    expect(out.cursor).toBe("101");
    expect(g.calls.some((c) => c.includes("pageToken=n"))).toBe(true);
  });

  it("starts over from now when Gmail no longer has the history", async () => {
    const g = gmail({
      "/history": () => new Response("", { status: 404 }),
      "/profile": () => json({ historyId: "900" }),
    });
    expect(await g.reader.sync({ token: "t", cursor: "1", limit: 10 })).toEqual({
      messages: [],
      cursor: "900",
    });
  });

  it("tells a refused token (reconnect) from a Gmail outage", async () => {
    const refused = gmail({ "/profile": () => new Response("", { status: 403 }) });
    const err = await refused.reader.sync({ token: "t", cursor: null, limit: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect(err.reconnect).toBe(true);

    const down = gmail({ "/profile": () => new Response("", { status: 503 }) });
    const outage = await down.reader.sync({ token: "t", cursor: null, limit: 1 }).catch((e) => e);
    expect(outage.reconnect).toBe(false);

    const missing = gmail({ "/profile": () => new Response("", { status: 404 }) });
    const noProfile = await missing.reader
      .sync({ token: "t", cursor: null, limit: 1 })
      .catch((e) => e);
    expect(noProfile.reconnect).toBe(false);
  });

  it("uses the global fetch when none is given", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => json({ historyId: "7" })) as unknown as typeof fetch;
    try {
      expect(await createGmailReader().sync({ token: "t", cursor: null, limit: 1 })).toEqual({
        messages: [],
        cursor: "7",
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("copes with a message that has no headers or date", async () => {
    const before = Date.now();
    const g = gmail({
      "/history": () =>
        json({ history: [{ id: "101", messagesAdded: [{ message: { id: "a" } }] }] }),
      "/messages/a": () => json({ id: "a", threadId: "t", payload: { mimeType: "text/plain" } }),
    });
    const out = await g.reader.sync({ token: "t", cursor: "100", limit: 10 });
    expect(out.cursor).toBe("101");
    expect(out.messages[0]).toMatchObject({
      fromName: null,
      fromAddress: "",
      subject: "",
      body: "",
    });
    expect(Date.parse(out.messages[0]!.receivedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("parseFrom and bodyOf", () => {
  it("parses names and bare addresses", () => {
    expect(parseFrom("Dana <d@x.test>")).toEqual({ name: "Dana", address: "d@x.test" });
    expect(parseFrom("<d@x.test>")).toEqual({ name: null, address: "d@x.test" });
    expect(parseFrom(" d@x.test ")).toEqual({ name: null, address: "d@x.test" });
  });

  it("finds the plain part in nested parts, and is empty without text", () => {
    expect(
      bodyOf({
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain", body: { data: b64("deep") } }],
          },
        ],
      }),
    ).toBe("deep");
    expect(bodyOf({ mimeType: "application/pdf" })).toBe("");
  });
});
