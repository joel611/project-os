/** Longest body kept, after redaction. */
export const EMAIL_BODY_MAX = 8000;

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

const mask = (kind: string) => `[redacted ${kind}]`;

/** Secrets and personal numbers, each with the label it is replaced by. Order matters. */
const PATTERNS: ReadonlyArray<readonly [RegExp, (match: string, ...groups: string[]) => string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    () => mask("key"),
  ],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, () => mask("token")],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, () => mask("token")],
  [/\bgithub_pat_\w{20,}/g, () => mask("token")],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => mask("token")],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => mask("token")],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => mask("token")],
  [/\bAIza[\w-]{30,}/g, () => mask("token")],
  [/\bya29\.[\w-]{20,}/g, () => mask("token")],
  [/\bBearer\s+[\w.~+/=-]{12,}/gi, () => `Bearer ${mask("token")}`],
  // "password: hunter2", "api key = abc", "your PIN is 4821".
  [
    /\b(pass(?:word|code|wd)?|pwd|pin|secret|token|api[ _-]?key|access[ _-]?key|credentials?)(\s*(?:[:=]|\bis\b)\s*)(?!\[redacted)\S+/gi,
    (_m: string, key: string, sep: string) => `${key}${sep}${mask("secret")}`,
  ],
  // One-time codes: "verification code: 482913", "your OTP is 1234".
  [
    /\b(code|otp|one[- ]time (?:code|password))(\W{1,15}?)(\d{4,8})\b/gi,
    (_m: string, key: string, sep: string) => `${key}${sep}${mask("code")}`,
  ],
  [/\b\d{3}-\d{2}-\d{4}\b/g, () => mask("number")],
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, () => mask("number")],
  // Card numbers: 13 to 19 digits in groups, and only when they pass the Luhn check.
  [/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, "")) ? mask("card") : m)],
  // Phone and account numbers: nine or more digits once spaces and punctuation are ignored.
  [/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? mask("number") : m)],
  // Tracking and sign-in links carry their secrets in the query string.
  [/(https?:\/\/[^\s?#<>"')]+)[?#][^\s<>"')]*/g, (_m: string, url: string) => url],
  // Addresses in the text: keep the domain, which says who it is about.
  [/\b[\w.+-]+@([\w-]+(?:\.[\w-]+)+)\b/g, (_m: string, domain: string) => `[email]@${domain}`],
];

/** A quoted earlier message: "> text" lines, and the "On ... wrote:" line above them. */
const QUOTED = /^(?:>.*|On .{5,120} wrote:|-{2,}\s*Original Message\s*-{2,})$/gim;

/**
 * Cleans an email body before anything is stored or sent to a model: drops quoted replies and
 * masks secrets, one-time codes, card/phone/account numbers, query strings on links, and the
 * address part of email addresses. Cut at `EMAIL_BODY_MAX` characters.
 */
export const redactEmailBody = (body: string): string => {
  let text = body.replace(/\r\n?/g, "\n").replace(QUOTED, "");
  for (const [pattern, replace] of PATTERNS) {
    text = text.replace(pattern, replace as (substring: string, ...args: string[]) => string);
  }
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > EMAIL_BODY_MAX ? `${text.slice(0, EMAIL_BODY_MAX - 1)}…` : text;
};
