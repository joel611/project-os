// Reads a person's Gmail inbox, read-only. Plain `fetch` and plain data: the Coordinator wraps
// it in the `EmailSource` port, so this package depends on nothing but the wire types.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Mail Gmail files away from the inbox proper: never read. */
const SKIPPED_LABELS = new Set([
  "SPAM",
  "TRASH",
  "DRAFT",
  "SENT",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
]);

export interface GmailMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly fromName: string | null;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: string;
}

/** `reconnect` when the token is refused or lacks the scope: the person has to link Gmail again. */
export class GmailError extends Error {
  constructor(
    message: string,
    readonly reconnect: boolean,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

interface Part {
  readonly mimeType?: string;
  readonly body?: { readonly data?: string };
  readonly parts?: ReadonlyArray<Part>;
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

interface FullMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds?: ReadonlyArray<string>;
  readonly internalDate?: string;
  readonly payload?: Part;
}

const decode = (data: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
  );

const stripHtml = (html: string): string =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");

const find = (part: Part, mime: string): string | undefined => {
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = find(child, mime);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The readable text of a message: its plain-text part, else its HTML part with tags removed. */
export const bodyOf = (payload: Part): string => {
  const plain = find(payload, "text/plain");
  if (plain !== undefined) return plain;
  const html = find(payload, "text/html");
  return html === undefined ? "" : stripHtml(html);
};

/** `Dana <dana@x.test>`, `"Dana, A" <dana@x.test>` or a bare address. */
export const parseFrom = (value: string): { name: string | null; address: string } => {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (!match) return { name: null, address: value.trim() };
  const name = match[1]!.trim();
  return { name: name === "" ? null : name, address: match[2]!.trim() };
};

const header = (payload: Part, name: string): string =>
  payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";

export interface GmailReader {
  /**
   * Without a cursor, reads nothing and returns the mailbox's present as the cursor. With one,
   * returns the inbox mail added since, at most about `limit`, and a cursor just past it.
   */
  readonly sync: (input: {
    readonly token: string;
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<{ readonly messages: ReadonlyArray<GmailMessage>; readonly cursor: string }>;
}

export const createGmailReader = (
  options: { readonly fetch?: (input: string, init?: RequestInit) => Promise<Response> } = {},
): GmailReader => {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  /** The JSON answer, or null when Gmail has nothing there (404). */
  const get = async <T>(token: string, path: string): Promise<T | null> => {
    const response = await doFetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      throw new GmailError(`Gmail refused the token (${response.status})`, true);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new GmailError(`Gmail answered ${response.status}`, false);
    return (await response.json()) as T;
  };

  const profile = async (token: string) => {
    const body = await get<{ historyId: string }>(token, "/profile");
    if (!body) throw new GmailError("Gmail has no profile for this account", false);
    return body.historyId;
  };

  return {
    sync: async ({ token, cursor, limit }) => {
      if (cursor === null) return { messages: [], cursor: await profile(token) };

      const ids: string[] = [];
      let next = cursor;
      let page: string | undefined;
      let done = false;
      while (!done) {
        const query = new URLSearchParams({
          startHistoryId: cursor,
          historyTypes: "messageAdded",
          labelId: "INBOX",
          maxResults: "100",
          ...(page ? { pageToken: page } : {}),
        });
        const body = await get<{
          history?: ReadonlyArray<{
            id: string;
            messagesAdded?: ReadonlyArray<{ message: { id: string } }>;
          }>;
          nextPageToken?: string;
          historyId?: string;
        }>(token, `/history?${query}`);
        // Too old for Gmail to remember: start again from now, losing what came in between.
        if (!body) return { messages: [], cursor: await profile(token) };
        for (const record of body.history ?? []) {
          if (ids.length >= limit) {
            done = true;
            break;
          }
          for (const added of record.messagesAdded ?? []) {
            if (!ids.includes(added.message.id)) ids.push(added.message.id);
          }
          next = record.id;
        }
        page = body.nextPageToken;
        if (!page && !done) {
          next = body.historyId ?? next;
          done = true;
        }
      }

      const messages: GmailMessage[] = [];
      for (const id of ids) {
        const message = await get<FullMessage>(token, `/messages/${id}?format=full`);
        // Deleted since it arrived.
        if (!message?.payload) continue;
        if (message.labelIds?.some((l) => SKIPPED_LABELS.has(l))) continue;
        const from = parseFrom(header(message.payload, "from"));
        messages.push({
          messageId: message.id,
          threadId: message.threadId,
          fromName: from.name,
          fromAddress: from.address,
          subject: header(message.payload, "subject"),
          body: bodyOf(message.payload),
          receivedAt: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
        });
      }
      return { messages, cursor: next };
    },
  };
};
