import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Sidekick, SidekickError, type SidekickToken } from "@project-os/core";
import { Context, Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeAgentRuntime } from "./index.ts";

// The Sidekick's Pi session against a fake GitHub and Google Drive on localhost: the model is
// scripted, the tools and the HTTP calls they make are real.

interface Seen {
  readonly path: string;
  readonly authorization: string | null;
}

const seen: Seen[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  seen.length = 0;
  for (const s of servers.splice(0)) s.stop(true);
});

const fakeApis = () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname + url.search,
        authorization: req.headers.get("authorization"),
      });
      if (url.pathname.startsWith("/drive/files")) {
        return Response.json({ files: [{ id: "f1", name: "Roadmap" }] });
      }
      if (url.pathname === "/repos/acme/web/commits") return new Response("x".repeat(9_000));
      if (url.pathname === "/repos/acme/web/releases") {
        return Response.json([{ tag_name: "v1.2.0", published_at: "2026-11-01T00:00:00Z" }]);
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://localhost:${server.port}`;
  return { github: base, drive: `${base}/drive` };
};

const textOf = (m: Message | undefined) =>
  !m
    ? ""
    : typeof m.content === "string"
      ? m.content
      : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

const setup = () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const m = faux.getModel();
  return { faux, models, model: { provider: m.provider, modelId: m.id } };
};

const ok = (accessToken: string): SidekickToken => ({ ok: true, accessToken });

const withSidekick = <A>(
  options: Parameters<typeof makeAgentRuntime>[0],
  body: (sidekick: Context.Service.Shape<typeof Sidekick>) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(makeAgentRuntime(options));
        return yield* body(Context.get(ctx, Sidekick));
      }),
    ),
  );

/** The model calls `tools` in one step, sees their results, then answers with `answer`. */
const script = (
  faux: ReturnType<typeof setup>["faux"],
  tools: ReadonlyArray<ReturnType<typeof fauxToolCall>>,
  onResults: (results: string[]) => void,
  answer: string,
) =>
  faux.setResponses([
    fauxAssistantMessage([...tools], { stopReason: "toolUse" }),
    (c) => {
      onResults(c.messages.filter((m) => m.role === "toolResult").map(textOf));
      return fauxAssistantMessage([fauxText(answer)]);
    },
  ]);

describe("Sidekick (Pi Durable)", () => {
  it("reads GitHub and Drive with the requester's token and answers from what came back", async () => {
    const { faux, models, model } = setup();
    let results: string[] = [];
    script(
      faux,
      [
        fauxToolCall("github_get", { path: "/repos/acme/web/releases" }),
        fauxToolCall("drive_list", { folderId: "dir1", nameContains: "Road'map" }),
        fauxToolCall("drive_list", {}),
      ],
      (r) => (results = r),
      "Latest release is v1.2.0.",
    );

    const asked: string[] = [];
    const text = await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) =>
        sidekick.answer({
          ticketId: "t1",
          prompt: "what was the last release?",
          token: async (provider) => {
            asked.push(provider);
            return ok(`tok-${provider}`);
          },
        }),
    );

    expect(text).toBe("Latest release is v1.2.0.");
    expect(asked.sort()).toEqual(["github", "google", "google"]);
    expect(seen.find((s) => s.path === "/repos/acme/web/releases")?.authorization).toBe(
      "Bearer tok-github",
    );
    const drive = seen.find((s) => s.path.includes("dir1"));
    expect(drive?.authorization).toBe("Bearer tok-google");
    expect(new URL(`http://x${drive!.path}`).searchParams.get("q")).toBe(
      "trashed = false and 'dir1' in parents and name contains 'Road\\'map'",
    );
    expect(results.some((r) => r.includes("v1.2.0"))).toBe(true);
    expect(results.some((r) => r.includes("Roadmap"))).toBe(true);
  });

  it("tells the model when the account isn't linked, and calls nothing", async () => {
    const { faux, models, model } = setup();
    let results: string[] = [];
    script(
      faux,
      [fauxToolCall("github_get", { path: "/repos/acme/web" })],
      (r) => (results = r),
      "Please run /connect.",
    );

    await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) =>
        sidekick.answer({
          ticketId: "t1",
          prompt: "repo status?",
          token: async () => ({ ok: false, message: "not linked" }),
        }),
    );

    expect(results).toEqual(["Not connected: not linked"]);
    expect(seen).toEqual([]);
  });

  it.each([
    "/user/emails",
    "/repos/../user/emails",
    "/repos/%2e%2e/user/emails",
    "/orgs",
    "//evil.test/repos/a/b",
    "https://evil.test/repos/a/b",
  ])("refuses a GitHub path outside the read-only allowlist: %s", async (path) => {
    const { faux, models, model } = setup();
    let results: string[] = [];
    script(faux, [fauxToolCall("github_get", { path })], (r) => (results = r), "no");

    await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) => sidekick.answer({ ticketId: "t1", prompt: "x", token: async () => ok("tok") }),
    );

    expect(results[0]).toMatch(/^Refused/);
    expect(seen).toEqual([]);
  });

  it("passes a provider error to the model instead of failing the turn", async () => {
    const { faux, models, model } = setup();
    let results: string[] = [];
    script(
      faux,
      [fauxToolCall("github_get", { path: "/repos/acme/missing" })],
      (r) => (results = r),
      "That repo doesn't exist.",
    );

    const text = await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) => sidekick.answer({ ticketId: "t1", prompt: "x", token: async () => ok("tok") }),
    );

    expect(text).toBe("That repo doesn't exist.");
    expect(results[0]).toContain("github responded 404");
  });

  it("keeps one conversation per ticket, with the Sidekick's instructions", async () => {
    const { faux, models, model } = setup();
    const transcripts: string[] = [];
    const answer = (text: string) => (c: { messages: readonly Message[] }) => {
      transcripts.push(JSON.stringify(c.messages));
      return fauxAssistantMessage([fauxText(text)]);
    };
    faux.setResponses([answer("one"), answer("two")]);

    await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) =>
        Effect.gen(function* () {
          const token = async () => ok("tok");
          yield* sidekick.answer({ ticketId: "t1", prompt: "first", requestId: "m1", token });
          yield* sidekick.answer({ ticketId: "t1", prompt: "second", requestId: "m2", token });
        }),
    );

    expect(transcripts[0]).toContain("Sidekick of a project assistant");
    expect(transcripts[0]).toContain("first");
    expect(transcripts[1]).toContain("first");
    expect(transcripts[1]).toContain("second");
  });

  it("cuts a huge response short and says how big it was", async () => {
    const { faux, models, model } = setup();
    let results: string[] = [];
    script(
      faux,
      [fauxToolCall("github_get", { path: "/repos/acme/web/commits" })],
      (r) => (results = r),
      "lots",
    );

    await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) => sidekick.answer({ ticketId: "t1", prompt: "x", token: async () => ok("tok") }),
    );

    expect(results[0]).toContain("[truncated, 9000 characters in all]");
    expect(results[0]!.length).toBeLessThan(8_100);
  });

  it("fails with SidekickError when the model can't answer", async () => {
    const { faux, models, model } = setup();
    faux.setResponses([]);

    const err = await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) =>
        Effect.flip(sidekick.answer({ ticketId: "t1", prompt: "x", token: async () => ok("t") })),
    );

    expect(err).toBeInstanceOf(SidekickError);
  });

  it("does not answer a re-delivered request twice", async () => {
    const { faux, models, model } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("once")])]);

    const answers = await withSidekick(
      { storage: new MemoryStorage(), models, model, sidekickEndpoints: fakeApis() },
      (sidekick) =>
        Effect.gen(function* () {
          const input = {
            ticketId: "t1",
            prompt: "x",
            requestId: "m1",
            token: async () => ok("t"),
          };
          return [yield* sidekick.answer(input), yield* sidekick.answer(input)];
        }),
    );

    expect(answers).toEqual(["once", "once"]);
  });
});
