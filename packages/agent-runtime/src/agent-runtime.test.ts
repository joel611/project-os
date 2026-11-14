import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentRuntime, AgentRuntimeError } from "@project-os/core";
import {
  ADMIN_SESSION_INSTRUCTIONS,
  PROJECT_SESSION_INSTRUCTIONS,
} from "@project-os/system-prompts";
import { Context, Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  type AdminActions,
  makeAgentRuntime,
  openLocalStorage,
  type AgentRuntimeOptions,
} from "./index.ts";

const setup = () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const m = faux.getModel();
  return { faux, models, model: { provider: m.provider, modelId: m.id } };
};

/** Run several effects against one scoped layer so the Harness stays open between them. */
const withRuntime = <A>(
  options: AgentRuntimeOptions,
  body: (
    call: (i: {
      sessionId: string;
      prompt: string;
      requestId?: string;
    }) => Effect.Effect<string, AgentRuntimeError>,
  ) => Effect.Effect<A, AgentRuntimeError>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(makeAgentRuntime(options));
        const rt = Context_get(ctx);
        return yield* body((i) => rt.respond(i));
      }),
    ),
  );

const Context_get = (ctx: Context.Context<AgentRuntime>) => Context.get(ctx, AgentRuntime);

const textOf = (m: Message | undefined) =>
  !m
    ? ""
    : typeof m.content === "string"
      ? m.content
      : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("AgentRuntime (Pi Durable)", () => {
  it("composes a reply from the model answer", async () => {
    const { faux, models, model } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Your ticket is done.")])]);

    const text = await withRuntime({ storage: new MemoryStorage(), models, model }, (call) =>
      call({ sessionId: "project:p1", prompt: "Compose a reply" }),
    );

    expect(text).toBe("Your ticket is done.");
  });

  it("gives project and admin sessions the Coordinator's instructions", async () => {
    const { faux, models, model } = setup();
    const transcripts: string[] = [];
    const answer = (c: { messages: readonly Message[] }) => {
      transcripts.push(JSON.stringify(c.messages));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    faux.setResponses([(c) => answer(c), (c) => answer(c)]);

    await withRuntime({ storage: new MemoryStorage(), models, model }, (call) =>
      Effect.gen(function* () {
        yield* call({ sessionId: "project:a", prompt: "hi" });
        yield* call({ sessionId: "admin:chan", prompt: "hi" });
      }),
    );

    expect(transcripts[0]).toContain(JSON.stringify(PROJECT_SESSION_INSTRUCTIONS).slice(1, -1));
    expect(transcripts[1]).toContain(JSON.stringify(ADMIN_SESSION_INSTRUCTIONS).slice(1, -1));
  });

  it("keeps one conversation per session id", async () => {
    const { faux, models, model } = setup();
    const seen: number[] = [];
    const answer = (context: { messages: readonly Message[] }) => {
      seen.push(context.messages.length);
      return fauxAssistantMessage([fauxText(`n=${context.messages.length}`)]);
    };
    faux.setResponses([(c) => answer(c), (c) => answer(c), (c) => answer(c)]);

    await withRuntime({ storage: new MemoryStorage(), models, model }, (call) =>
      Effect.gen(function* () {
        yield* call({ sessionId: "project:a", prompt: "one" });
        yield* call({ sessionId: "project:a", prompt: "two" });
        yield* call({ sessionId: "project:b", prompt: "other" });
      }),
    );

    // The first message of every conversation is its instructions.
    expect(seen).toEqual([2, 4, 2]);
  });

  it("creates one conversation for concurrent first messages and ignores thinking blocks", async () => {
    const { faux, models, model } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("hmm"), fauxText("a")]),
      fauxAssistantMessage([fauxText("b")]),
    ]);

    const texts = await withRuntime({ storage: new MemoryStorage(), models, model }, (call) =>
      Effect.all([call({ sessionId: "s", prompt: "1" }), call({ sessionId: "s", prompt: "2" })], {
        concurrency: "unbounded",
      }),
    );

    expect(texts).toEqual(["a", "b"]);
  });

  it("wraps a non-Error open failure", async () => {
    const { models, model } = setup();
    const storage = new Proxy(
      {},
      {
        get() {
          throw "boom";
        },
      },
    ) as never;
    const err = await Effect.runPromise(
      Effect.flip(Effect.scoped(Layer.build(makeAgentRuntime({ storage, models, model })))),
    );
    expect(err.message).toBe("boom");
  });

  it("does not answer a re-delivered requestId twice", async () => {
    const { faux, models, model } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("once")])]);

    const [a, b] = await withRuntime({ storage: new MemoryStorage(), models, model }, (call) =>
      Effect.gen(function* () {
        const first = yield* call({ sessionId: "s", prompt: "hi", requestId: "ext-1" });
        const second = yield* call({ sessionId: "s", prompt: "hi", requestId: "ext-1" });
        return [first, second] as const;
      }),
    );

    expect([a, b]).toEqual(["once", "once"]);
    expect(faux.state.callCount).toBe(1);
  });

  it("fails with AgentRuntimeError when the model errors", async () => {
    const { models, model } = setup(); // no scripted responses -> faux error
    const err = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            const ctx = yield* Layer.build(
              makeAgentRuntime({ storage: new MemoryStorage(), models, model }),
            );
            return yield* Context_get(ctx).respond({ sessionId: "s", prompt: "hi" });
          }),
        ),
      ),
    );
    expect(err).toBeInstanceOf(AgentRuntimeError);
  });

  it("restart: reopening the storage keeps the conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-"));
    tmpDirs.push(dir);
    const file = join(dir, "pi.sqlite");
    const { faux, models, model } = setup();
    let lastContext: readonly Message[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxText("first")]),
      (c) => {
        lastContext = c.messages;
        return fauxAssistantMessage([fauxText("second")]);
      },
    ]);

    await withRuntime({ storage: await openLocalStorage(file), models, model }, (call) =>
      call({ sessionId: "project:p1", prompt: "remember me" }),
    );
    const text = await withRuntime(
      { storage: await openLocalStorage(file), models, model },
      (call) => call({ sessionId: "project:p1", prompt: "again" }),
    );

    expect(text).toBe("second");
    expect(lastContext.map(textOf).filter(Boolean)).toEqual(["remember me", "first", "again"]);
  });

  describe("admin tools", () => {
    const actions = () => {
      const calls: Array<[string, unknown]> = [];
      const record =
        (name: string) =>
        async (args: unknown): Promise<string> => {
          calls.push([name, args]);
          return `${name} ok`;
        };
      const a: AdminActions = {
        createProject: record("create_project"),
        addSource: record("add_source"),
        listSources: record("list_sources"),
        updateSource: record("update_source"),
        setDefaultChannel: record("set_default_channel"),
        ticketStatus: record("ticket_status"),
      };
      return { calls, a };
    };

    it("exposes the Coordinator actions to admin sessions only", async () => {
      const { faux, models, model } = setup();
      const { calls, a } = actions();
      const offered: boolean[] = [];
      const spy = (c: { messages: readonly Message[] }) => {
        offered.push(JSON.stringify(c.messages).includes("set_default_channel"));
      };
      faux.setResponses([
        (c) => {
          spy(c);
          return fauxAssistantMessage(
            [
              fauxToolCall("create_project", { name: "Acme", createChannel: false }),
              fauxToolCall("add_source", {
                projectId: "p1",
                type: "discord_channel",
                externalId: "c1",
                alias: "chat",
              }),
              fauxToolCall("list_sources", { projectId: "p1" }),
              fauxToolCall("update_source", { projectId: "p1", alias: "chat", newAlias: "team" }),
              fauxToolCall("set_default_channel", { projectId: "p1", externalId: "c1" }),
              fauxToolCall("ticket_status", { ticketId: "t1" }),
            ],
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage([fauxText("Done.")]),
        (c) => {
          spy(c);
          return fauxAssistantMessage([fauxText("project reply")]);
        },
      ]);

      const [admin, project] = await withRuntime(
        { storage: new MemoryStorage(), models, model, adminActions: a },
        (call) =>
          Effect.gen(function* () {
            const x = yield* call({ sessionId: "admin:chan", prompt: "set up Acme" });
            const y = yield* call({ sessionId: "project:p1", prompt: "compose" });
            return [x, y] as const;
          }),
      );

      expect(admin).toBe("Done.");
      expect(project).toBe("project reply");
      expect(calls).toEqual([
        ["create_project", { name: "Acme", createChannel: false }],
        [
          "add_source",
          { projectId: "p1", type: "discord_channel", externalId: "c1", alias: "chat" },
        ],
        ["list_sources", { projectId: "p1" }],
        ["update_source", { projectId: "p1", alias: "chat", newAlias: "team" }],
        ["set_default_channel", { projectId: "p1", externalId: "c1" }],
        ["ticket_status", { ticketId: "t1" }],
      ]);
      expect(offered).toEqual([true, false]);
    });

    it("returns an action failure to the model as an error result", async () => {
      const { faux, models, model } = setup();
      const failing: AdminActions = {
        createProject: async () => {
          throw new Error("name taken");
        },
        addSource: async () => "",
        listSources: async () => "",
        updateSource: async () => "",
        setDefaultChannel: async () => "",
        ticketStatus: async () => "",
      };
      let toolResult = "";
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("create_project", { name: "Acme" })], {
          stopReason: "toolUse",
        }),
        (c) => {
          toolResult = textOf(c.messages.find((m) => m.role === "toolResult"));
          return fauxAssistantMessage([fauxText("could not")]);
        },
      ]);

      const text = await withRuntime(
        { storage: new MemoryStorage(), models, model, adminActions: failing },
        (call) => call({ sessionId: "admin:c", prompt: "make Acme" }),
      );

      expect(text).toBe("could not");
      expect(toolResult).toContain("name taken");
    });
  });
});
