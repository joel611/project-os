import type { EmailItem, EmailLabel, Requester } from "@project-os/contracts";
import {
  EmailClassifier,
  EmailClassifierError,
  EmailRepository,
  EmailSource,
  EmailSourceError,
  type EmailProjectChoice,
  type MailMessage,
  type Mailbox,
} from "@project-os/core";
import { Effect, Layer } from "effect";

const keyOf = (o: Requester) => `${o.channelType}:${o.id}`;

export const EmailRepositoryInMemory = Layer.sync(EmailRepository, () => {
  const mailboxes = new Map<string, Mailbox>();
  const emails = new Map<string, EmailItem>();
  const newestFirst = (list: EmailItem[]) =>
    [...list].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return {
    mailbox: (owner) => Effect.sync(() => mailboxes.get(keyOf(owner)) ?? null),
    saveMailbox: (mailbox) => Effect.sync(() => void mailboxes.set(keyOf(mailbox.owner), mailbox)),
    enabledMailboxes: Effect.sync(() => [...mailboxes.values()].filter((m) => m.enabled)),
    insert: (email) =>
      Effect.sync(() => {
        const taken = [...emails.values()].some(
          (e) => keyOf(e.owner) === keyOf(email.owner) && e.messageId === email.messageId,
        );
        if (!taken) emails.set(email.id, email);
        return !taken;
      }),
    get: (id) => Effect.sync(() => emails.get(id) ?? null),
    update: (id, patch) =>
      Effect.sync(() => {
        const row = emails.get(id);
        if (row) emails.set(id, { ...row, ...patch });
      }),
    listUnassigned: (owner) =>
      Effect.sync(() =>
        newestFirst(
          [...emails.values()].filter(
            (e) => keyOf(e.owner) === keyOf(owner) && e.status === "unassigned",
          ),
        ),
      ),
    examples: (limit) =>
      Effect.sync(() =>
        newestFirst(
          [...emails.values()].filter((e) => e.status === "assigned" && e.assignedBy === "person"),
        ).slice(0, limit),
      ),
    removeOlder: ({ waitingBefore, filedBefore }) =>
      Effect.sync(() => {
        let removed = 0;
        for (const [id, e] of emails) {
          const cutoff = e.status === "assigned" ? filedBefore : waitingBefore;
          if (e.receivedAt < cutoff) {
            emails.delete(id);
            removed++;
          }
        }
        return removed;
      }),
  };
});

/**
 * A mailbox source driven by the test: `deliver` queues mail for an owner, which the next sync
 * returns. The first sync (no cursor) reads nothing, like the real one. `fail` makes syncs fail.
 */
export const makeEmailSourceFake = () => {
  const queued = new Map<
    string,
    Array<MailMessage & { readonly labels?: ReadonlyArray<string> }>
  >();
  let failure: { message: string; reconnect: boolean } | undefined;
  let labels: ReadonlyArray<EmailLabel> = [];
  const syncs: Array<{ label: string }> = [];
  let counter = 0;
  return {
    /** Queues mail for an owner. With `labels` on it, a sync for one label reads it only if listed. */
    deliver: (
      owner: Requester,
      ...messages: Array<MailMessage & { readonly labels?: ReadonlyArray<string> }>
    ) => {
      queued.set(keyOf(owner), [...(queued.get(keyOf(owner)) ?? []), ...messages]);
    },
    fail: (next: { message: string; reconnect: boolean } | undefined) => {
      failure = next;
    },
    /** The labels `EmailSource.labels` offers. */
    setLabels: (next: ReadonlyArray<EmailLabel>) => {
      labels = next;
    },
    /** The label each sync asked for. */
    syncs,
    layer: Layer.succeed(EmailSource, {
      sync: ({ owner, label, cursor, limit }) =>
        Effect.suspend(() => {
          syncs.push({ label });
          if (failure) return Effect.fail(new EmailSourceError(failure));
          if (cursor === null) return Effect.succeed({ messages: [], cursor: `h${++counter}` });
          const all = queued.get(keyOf(owner)) ?? [];
          const wanted = (m: { readonly labels?: ReadonlyArray<string> }) =>
            label === "all" || (m.labels?.includes(label) ?? false);
          const messages = all.filter(wanted).slice(0, limit);
          // Mail with another label stays in the mailbox, unread, as it would in Gmail.
          queued.set(
            keyOf(owner),
            all.filter((m) => !messages.includes(m) && (label === "all" || !wanted(m))),
          );
          return Effect.succeed({ messages, cursor: `h${++counter}` });
        }),
      labels: () =>
        Effect.suspend(() =>
          failure ? Effect.fail(new EmailSourceError(failure)) : Effect.succeed(labels),
        ),
    }),
  };
};

export type EmailClassifyCall = Parameters<typeof EmailClassifier.Service.classify>[0];

/**
 * A classifier that needs no model: an email whose subject or body mentions a project's name
 * (case-insensitive) belongs to it, with confidence `confidence`; otherwise `projectId: null`.
 * Records each call; `fail` makes every call fail.
 */
export const makeEmailClassifierFake = (options?: {
  readonly confidence?: number;
  readonly fail?: string;
}) => {
  const calls: EmailClassifyCall[] = [];
  return {
    calls,
    layer: Layer.succeed(EmailClassifier, {
      classify: (input) =>
        Effect.suspend(() => {
          calls.push(input);
          if (options?.fail !== undefined) {
            return Effect.fail(new EmailClassifierError({ message: options.fail }));
          }
          const text = `${input.subject}\n${input.body}`.toLowerCase();
          const hit = input.projects.find(
            (p: EmailProjectChoice) =>
              text.includes(p.name.toLowerCase()) ||
              p.examples.some((e) => input.from.includes(e.from)),
          );
          return Effect.succeed({
            projectId: hit?.id ?? null,
            confidence: hit ? (options?.confidence ?? 0.95) : 0.3,
          });
        }),
    }),
  };
};
