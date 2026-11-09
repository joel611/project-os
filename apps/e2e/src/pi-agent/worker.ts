import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { AgentRuntime } from "@project-os/core";
import { Effect, ManagedRuntime } from "effect";
import { durableAgentRuntime, PiAgent } from "../../../coordinator/src/pi-agent.ts";

// Bundled and run inside workerd by pi-agent.test.ts. It is the real PiAgent with its model
// swapped for pi-ai's faux provider, behind a Worker that reaches it the way production does.

const textOf = (m: Message | undefined) =>
  !m
    ? ""
    : typeof m.content === "string"
      ? m.content
      : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** "create project X" asks for the admin tool; any other prompt gets the call number and history size. */
const makeAnswer = () => {
  let modelCalls = 0;
  return (context: { readonly messages: readonly Message[] }) => {
    modelCalls += 1;
    const last = context.messages.at(-1);
    if (last?.role === "toolResult")
      return fauxAssistantMessage([fauxText(`tool said: ${textOf(last)}`)]);
    const create = /create project (\w+)/.exec(textOf(last));
    if (create) {
      return fauxAssistantMessage(
        [fauxToolCall("create_project", { name: create[1], createChannel: false })],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([
      fauxText(`call ${modelCalls}, history ${context.messages.length}`),
    ]);
  };
};

export class TestAgent extends PiAgent {
  protected override chat() {
    const faux = fauxProvider();
    const answer = makeAnswer();
    faux.setResponses(Array.from({ length: 40 }, () => answer));
    const models = createModels();
    models.setProvider(faux.provider);
    const m = faux.getModel();
    return { models, model: { provider: m.provider, modelId: m.id } };
  }
}

interface Env {
  readonly PI_AGENT: DurableObjectNamespace<PiAgent>;
}

export default {
  async fetch(request: Request, env: Env) {
    const input = (await request.json()) as {
      sessionId: string;
      prompt: string;
      requestId?: string;
    };
    const runtime = ManagedRuntime.make(durableAgentRuntime(env.PI_AGENT));
    const result = await runtime.runPromise(
      AgentRuntime.use((r) => r.respond(input)).pipe(
        Effect.match({
          onSuccess: (text) => ({ ok: true, text }),
          onFailure: (e) => ({ ok: false, message: e.message }),
        }),
      ),
    );
    return Response.json(result);
  },
};
