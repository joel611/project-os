import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { formatModelRef, modelConfig, parseModelRef } from "./models.ts";

const sonnet = { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" };
const jev = { provider: "openrouter", modelId: "typesafe/jev-1.14" };

describe("modelConfig", () => {
  it("falls back to DEFAULT_MODEL, and pins the decision model to Jev", () => {
    expect(modelConfig({ DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4.5" })).toEqual({
      default: sonnet,
      channelDigest: sonnet,
      decision: jev,
    });
  });

  it("reads the overrides", () => {
    const config = modelConfig({
      DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
      CHANNEL_DIGEST_MODEL: " openrouter/google/gemini-2.5-flash ",
      DECISION_MODEL: "openrouter/typesafe/jev-2",
    });
    expect(config.channelDigest).toEqual({
      provider: "openrouter",
      modelId: "google/gemini-2.5-flash",
    });
    expect(config.decision).toEqual({ provider: "openrouter", modelId: "typesafe/jev-2" });
  });

  it("treats empty overrides as unset", () => {
    const config = modelConfig({
      DEFAULT_MODEL: "a/b",
      CHANNEL_DIGEST_MODEL: "",
      DECISION_MODEL: " ",
    });
    expect(config.channelDigest).toEqual({ provider: "a", modelId: "b" });
    expect(config.decision).toEqual(jev);
  });

  it("requires DEFAULT_MODEL", () => {
    expect(() => modelConfig({})).toThrow("Missing env var DEFAULT_MODEL");
    expect(() => modelConfig({ DEFAULT_MODEL: "  " })).toThrow("Missing env var DEFAULT_MODEL");
  });

  it("names the replacement when an old var is set", () => {
    expect(() =>
      modelConfig({ DEFAULT_MODEL: "a/b", CHAT_MODEL_ID: "x", JEV_MODEL_ID: "y" }),
    ).toThrow(
      "CHAT_MODEL_ID was renamed to DEFAULT_MODEL; JEV_MODEL_ID was renamed to DECISION_MODEL; Set it as one provider/model string",
    );
  });

  it("reads process.env by default", () => {
    process.env.DEFAULT_MODEL = "a/b";
    expect(modelConfig().default).toEqual({ provider: "a", modelId: "b" });
    delete process.env.DEFAULT_MODEL;
  });
});

describe("parseModelRef", () => {
  it("splits at the first slash", () => {
    expect(parseModelRef("K", "openrouter/a/b")).toEqual({
      provider: "openrouter",
      modelId: "a/b",
    });
  });

  it.each(["sonnet", "/a", "openrouter/"])("rejects %j", (raw) => {
    expect(() => parseModelRef("CHANNEL_DIGEST_MODEL", raw)).toThrow(
      `CHANNEL_DIGEST_MODEL must be provider/model`,
    );
  });
});

describe("formatModelRef", () => {
  it("joins provider and model", () => {
    expect(formatModelRef(sonnet)).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  it("is undone by parseModelRef for any provider and slash-separated model id", () => {
    const part = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,10}$/);
    const modelId = fc.array(part, { minLength: 1, maxLength: 3 }).map((p) => p.join("/"));
    fc.assert(
      fc.property(part, modelId, (provider, id) => {
        const ref = { provider, modelId: id };
        expect(parseModelRef("K", formatModelRef(ref))).toEqual(ref);
      }),
    );
  });
});
