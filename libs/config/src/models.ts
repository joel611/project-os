/** Where keys are read from. Default: `process.env`. */
type Source = Readonly<Record<string, string | undefined>>;

/** A model as `provider/model`: the provider is everything before the first `/`. */
export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/** The Coordinator's models, from env (apps/site/guide/setup.md, "Models"). */
export interface ModelConfig {
  /** `DEFAULT_MODEL` (required): chat, and every model below that isn't set. */
  readonly default: ModelRef;
  /** `CHANNEL_DIGEST_MODEL`, else the default. */
  readonly channelDigest: ModelRef;
  /** `DECISION_MODEL`: the intent classifier. Never falls back to the default. */
  readonly decision: ModelRef;
}

export const DEFAULT_MODEL_EXAMPLE = "openrouter/anthropic/claude-sonnet-4.5";

/** Pinned, not `~typesafe/jev-latest` (apps/site/reference/architecture.md §8.6). */
export const DEFAULT_DECISION_MODEL = "openrouter/typesafe/jev-1.14";

/** Old model vars and the var that replaced each. Setting one stops the Coordinator. */
const RENAMED: Readonly<Record<string, string>> = {
  CHAT_MODEL_ID: "DEFAULT_MODEL",
  CHAT_MODEL_PROVIDER: "DEFAULT_MODEL",
  CHANNEL_DIGEST_MODEL_ID: "CHANNEL_DIGEST_MODEL",
  CHANNEL_DIGEST_MODEL_PROVIDER: "CHANNEL_DIGEST_MODEL",
  JEV_MODEL_ID: "DECISION_MODEL",
};

/** Throws when an old model var is set, naming the var that replaced it. */
export const assertNoRenamedModelVars = (source: Source): void => {
  const old = Object.keys(RENAMED).filter((key) => source[key]);
  if (old.length === 0) return;
  throw new Error(
    old
      .map((key) => `${key} was renamed to ${RENAMED[key]}`)
      .concat(`Set it as one provider/model string, e.g. ${DEFAULT_MODEL_EXAMPLE}`)
      .join("; "),
  );
};

/** Parses `provider/model`; `key` names the var in the error. */
export const parseModelRef = (key: string, raw: string): ModelRef => {
  const value = raw.trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`${key} must be provider/model (e.g. ${DEFAULT_MODEL_EXAMPLE}), got "${raw}"`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
};

/** Reads the model vars, failing fast on a missing `DEFAULT_MODEL` or an old var name. */
export const modelConfig = (source: Source = process.env): ModelConfig => {
  assertNoRenamedModelVars(source);
  const raw = source.DEFAULT_MODEL?.trim();
  if (!raw) {
    throw new Error(
      `Missing env var DEFAULT_MODEL (provider/model, e.g. ${DEFAULT_MODEL_EXAMPLE})`,
    );
  }
  const fallback = parseModelRef("DEFAULT_MODEL", raw);
  const optional = (key: string) => {
    const value = source[key]?.trim();
    return value ? parseModelRef(key, value) : undefined;
  };
  return {
    default: fallback,
    channelDigest: optional("CHANNEL_DIGEST_MODEL") ?? fallback,
    decision: optional("DECISION_MODEL") ?? parseModelRef("DECISION_MODEL", DEFAULT_DECISION_MODEL),
  };
};

/** `provider/model`, as Pi's `--model` takes it. */
export const formatModelRef = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`;
