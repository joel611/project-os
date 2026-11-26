import { AgentRuntimeEcho, makeSidekickRecording } from "@project-os/testing";
import { Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { type AgentInput, piAi } from "./pi-ai.ts";

const build = (env: Record<string, string>) => {
  const inputs: AgentInput[] = [];
  const ai = piAi(env, (input) => {
    inputs.push(input);
    return Layer.merge(AgentRuntimeEcho, makeSidekickRecording().layer);
  });
  return { inputs, run: () => ai({ adminActions: {} as never }) };
};

const MODEL = "openrouter/anthropic/claude-sonnet-4.5";

describe("piAi", () => {
  it("hands the platform's agent runtime the default model and the admin actions", () => {
    const { inputs, run } = build({ DEFAULT_MODEL: MODEL });
    run();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.model).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
    });
    expect(inputs[0]!.adminActions).toBeDefined();
  });

  it.each([
    [{ DEFAULT_MODEL: "openrouter/no/such-model" }, "Unknown DEFAULT_MODEL"],
    [{ DEFAULT_MODEL: MODEL, DECISION_MODEL: "openrouter/no/such" }, "Unknown DECISION_MODEL"],
    [{ DEFAULT_MODEL: MODEL, CHANNEL_DIGEST_MODEL: "openrouter/no/such" }, "Channel Digest model"],
  ])("fails at startup for a model the catalog lacks: %o", (env, message) => {
    expect(build(env).run).toThrow(message);
  });
});
