const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bya29\.[A-Za-z0-9._-]{20,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

export const redact = (text: string, secrets: readonly string[] = []): string => {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_, prefix: unknown) =>
      typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]",
    );
  }
  return out;
};

/** The last `maxChars` of what a session printed, with credentials redacted as it grows. */
export const createTail = (secrets: readonly string[] = [], maxChars = 4000) => {
  let text = "";
  return {
    push: (chunk: string) => {
      text = redact(text + chunk, secrets).slice(-maxChars);
    },
    read: () => text,
  };
};
