import {
  type EmailAssignedBy,
  type EmailDigestSource,
  type EmailItem,
  GMAIL_WEB,
  type MyEmail,
  type Requester,
} from "@project-os/contracts";
import { Data, Effect } from "effect";
import {
  ChannelDigester,
  Clock,
  EmailClassifier,
  EmailRepository,
  EmailSource,
  IdGenerator,
  KeyValueStore,
  MemoryRepository,
  type Mailbox,
  ProjectRepository,
} from "../ports/index.ts";
import { audit, COORDINATOR } from "./audit.ts";
import { redactEmailBody } from "./email-redact.ts";
import { writeMemory } from "./memory.ts";

/** `createdBy` on memory entries the Email Digest saves. */
export const EMAIL_DIGEST_AUTHOR = "email-digest";

/** Auto-file only when the classifier is at least this sure. */
export const EMAIL_AUTO_ASSIGN_THRESHOLD = 0.9;

export interface EmailDigestConfig {
  /** Most mail one mailbox adds per run; the rest is read on the next one. */
  readonly maxPerSync: number;
  readonly threshold: number;
  /** Waiting and dismissed emails older than this are dropped. */
  readonly waitingRetentionMs: number;
  /** Filed emails (kept for what they teach the classifier) older than this are dropped. */
  readonly filedRetentionMs: number;
}

export const DEFAULT_EMAIL_DIGEST: EmailDigestConfig = {
  maxPerSync: 25,
  threshold: EMAIL_AUTO_ASSIGN_THRESHOLD,
  waitingRetentionMs: 30 * 24 * 60 * 60_000,
  filedRetentionMs: 365 * 24 * 60 * 60_000,
};

/** How many hand-filed emails the classifier may learn from, and how many it sees per project. */
const EXAMPLES_TOTAL = 60;
const EXAMPLES_PER_PROJECT = 5;
const KNOWN_TITLES = 50;
const TITLE_MAX = 80;
const QUOTE_MAX = 500;
const EXCERPT_MAX = 240;

export class EmailNotFound extends Data.TaggedError("EmailNotFound")<{
  readonly emailId: string;
}> {}

export class EmailDigestFailed extends Data.TaggedError("EmailDigestFailed")<{
  readonly message: string;
}> {}

const same = (a: Requester, b: Requester) => a.channelType === b.channelType && a.id === b.id;
const keyOf = (owner: Requester) => `${owner.channelType}:${owner.id}`;
const fromLine = (e: Pick<EmailItem, "fromName" | "fromAddress">) =>
  e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const emptyMailbox = (owner: Requester): Mailbox => ({
  owner,
  enabled: false,
  label: null,
  cursor: null,
  lastSyncAt: null,
  needsReconnect: false,
});

/** Switching a mailbox on needs a choice of what to read: `all` or one Gmail label. */
export class EmailLabelRequired extends Data.TaggedError("EmailLabelRequired")<{
  readonly message: string;
}> {}

/**
 * Switches a person's mailbox on or off. Turning it on needs a `label` (`all`, or one Gmail label
 * id), and starts reading from now. Sent again while on, a label changes what is read.
 */
export const setMailboxEnabled = (owner: Requester, enabled: boolean, label?: string) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const mailbox = (yield* repo.mailbox(owner)) ?? emptyMailbox(owner);
    const chosen = label ?? mailbox.label;
    if (enabled && chosen === null) {
      return yield* new EmailLabelRequired({
        message: "Choose which Gmail label to read: all mail, or one label",
      });
    }
    yield* repo.saveMailbox({
      ...mailbox,
      enabled,
      label: chosen,
      // A fresh start: mail from before it was switched on is not read.
      ...(enabled ? { needsReconnect: false } : {}),
      ...(enabled && (!mailbox.enabled || mailbox.label === null) ? { cursor: null } : {}),
    });
  });

/** The Gmail labels a person may pick from. */
export const listEmailLabels = (owner: Requester) =>
  Effect.flatMap(EmailSource, (source) => source.labels(owner));

/** `GET /me/email`: the person's mailbox state and the emails waiting for a project. */
export const getMyEmail = (owner: Requester, available: boolean) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const mailbox = yield* repo.mailbox(owner);
    const waiting = yield* repo.listUnassigned(owner);
    const projects = yield* (yield* ProjectRepository).list;
    const result: MyEmail = {
      available,
      enabled: mailbox?.enabled ?? false,
      label: mailbox?.label ?? null,
      needsReconnect: mailbox?.needsReconnect ?? false,
      lastSyncAt: mailbox?.lastSyncAt ?? null,
      projects: projects
        .filter((p) => p.status === "active")
        .map((p) => ({ id: p.id, name: p.name })),
      unassigned: waiting.map((e) => ({
        id: e.id,
        fromName: e.fromName,
        fromAddress: e.fromAddress,
        subject: e.subject,
        excerpt: clip(e.body.replace(/\s+/g, " "), EXCERPT_MAX),
        receivedAt: e.receivedAt,
        suggestedProjectId: e.suggestedProjectId,
        confidence: e.confidence,
      })),
    };
    return result;
  });

/** Writes what an email says to the project's memory, then drops its body. */
const fileEmail = (email: EmailItem, projectId: string, by: EmailAssignedBy) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const project = yield* (yield* ProjectRepository).get(projectId);
    const known = (yield* (yield* MemoryRepository).list(projectId, { limit: KNOWN_TITLES })).map(
      (m) => m.title,
    );
    const points = yield* (yield* ChannelDigester)
      .digest({
        projectName: project.name,
        projectContext: project.customInstructions,
        known,
        messages: [
          {
            id: email.messageId,
            sender: fromLine(email),
            content: `Email subject: ${email.subject}\n\n${email.body}`,
            sentAt: email.receivedAt,
          },
        ],
      })
      .pipe(Effect.mapError((e) => new EmailDigestFailed({ message: e.message })));

    const source: EmailDigestSource = {
      source: "email_digest",
      from: fromLine(email),
      subject: email.subject,
      receivedAt: email.receivedAt,
      quote: clip(email.body, QUOTE_MAX),
      assignedBy: by,
      // No account index or address: Project Memory is shared, and this must not name the owner.
      url: `${GMAIL_WEB}mail/#all/${email.threadId}`,
    };
    for (const point of points) {
      yield* writeMemory({
        projectId,
        type: point.type,
        title: point.title.slice(0, TITLE_MAX),
        content: point.content,
        workerId: EMAIL_DIGEST_AUTHOR,
        sourceMetadata: source,
      });
    }
    // The body served its purpose; what was worth keeping is in memory.
    yield* repo.update(email.id, { status: "assigned", projectId, assignedBy: by, body: "" });
    yield* audit({
      kind: "digest_event",
      action: by === "classifier" ? "email_filed" : "email_assigned",
      actor: COORDINATOR,
      projectId,
      summary: `Filed 1 email${by === "person" ? " (assigned by hand)" : ""}, saved ${points.length} to Project Memory`,
      payload: { messages: 1, saved: points.map((p) => p.title.slice(0, TITLE_MAX)), email: true },
    });
    return points.length;
  });

/**
 * A person files a waiting email under a project (`projectId`) or dismisses it (null). Only the
 * owner's own emails: anything else is `EmailNotFound`.
 */
export const assignEmail = (owner: Requester, emailId: string, projectId: string | null) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const email = yield* repo.get(emailId);
    if (!email || !same(email.owner, owner) || email.status !== "unassigned") {
      return yield* new EmailNotFound({ emailId });
    }
    if (projectId === null) {
      yield* repo.update(emailId, { status: "dismissed", body: "" });
      return { saved: 0 };
    }
    return { saved: yield* fileEmail(email, projectId, "person") };
  });

const projectChoices = Effect.gen(function* () {
  const projects = yield* (yield* ProjectRepository).list;
  const examples = yield* (yield* EmailRepository).examples(EXAMPLES_TOTAL);
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.customInstructions,
    examples: examples
      .filter((e) => e.projectId === p.id)
      .slice(0, EXAMPLES_PER_PROJECT)
      .map((e) => ({ from: e.fromAddress, subject: e.subject })),
  }));
});

/** Reads one mailbox: stores new mail redacted, classifies it, files the sure ones. */
const syncMailbox = (mailbox: Mailbox, config: EmailDigestConfig) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const now = (yield* Effect.flatMap(Clock, (c) => c.now)).toISOString();
    const read = yield* (yield* EmailSource)
      .sync({
        owner: mailbox.owner,
        label: mailbox.label!,
        cursor: mailbox.cursor,
        limit: config.maxPerSync,
      })
      .pipe(
        Effect.catchTag("EmailSourceError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(`email sync failed for ${keyOf(mailbox.owner)}`, e.message);
            if (e.reconnect) yield* repo.saveMailbox({ ...mailbox, needsReconnect: true });
            return undefined;
          }),
        ),
      );
    if (!read) return 0;

    let stored = 0;
    for (const message of read.messages) {
      const id = yield* Effect.flatMap(IdGenerator, (g) => g.next);
      const email: EmailItem = {
        id,
        owner: mailbox.owner,
        messageId: message.messageId,
        threadId: message.threadId,
        fromName: message.fromName,
        fromAddress: message.fromAddress,
        subject: clip(message.subject, 300),
        body: redactEmailBody(message.body),
        receivedAt: message.receivedAt,
        status: "unassigned",
        projectId: null,
        assignedBy: null,
        suggestedProjectId: null,
        confidence: null,
      };
      if (!(yield* repo.insert(email))) continue;
      stored++;
      yield* classifyAndFile(email, config);
    }
    yield* repo.saveMailbox({
      ...mailbox,
      cursor: read.cursor,
      lastSyncAt: now,
      needsReconnect: false,
    });
    return stored;
  });

const classifyAndFile = (email: EmailItem, config: EmailDigestConfig) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const projects = yield* projectChoices;
    if (projects.length === 0) return;
    const answer = yield* (yield* EmailClassifier)
      .classify({
        from: fromLine(email),
        subject: email.subject,
        body: email.body,
        projects,
      })
      .pipe(
        Effect.catchTag("EmailClassifierError", (e) =>
          Effect.as(Effect.logWarning(`email classify failed: ${e.message}`), undefined),
        ),
      );
    // Without an answer the email just waits for the person.
    if (!answer) return;
    yield* repo.update(email.id, {
      suggestedProjectId: answer.projectId,
      confidence: answer.confidence,
    });
    if (answer.projectId !== null && answer.confidence >= config.threshold) {
      yield* fileEmail(email, answer.projectId, "classifier").pipe(
        // A failed digest leaves it waiting, with the suggestion, for the person to assign.
        Effect.catchTags({
          EmailDigestFailed: (e) => Effect.logWarning(`email digest failed: ${e.message}`),
          ProjectNotFound: () => Effect.logWarning("email classified to a project that is gone"),
        }),
      );
    }
  });

export interface EmailSyncRun {
  readonly mailboxes: number;
  readonly emails: number;
}

/**
 * The Email Digest run: for every switched-on mailbox, reads what arrived since the last run,
 * and drops old emails. Safe to run every minute; a mailbox is read by one run at a time.
 */
export const syncMailboxes = (config: EmailDigestConfig) =>
  Effect.gen(function* () {
    const repo = yield* EmailRepository;
    const kv = yield* KeyValueStore;
    const nowMs = (yield* Effect.flatMap(Clock, (c) => c.now)).getTime();
    yield* repo.removeOlder({
      waitingBefore: new Date(nowMs - config.waitingRetentionMs).toISOString(),
      filedBefore: new Date(nowMs - config.filedRetentionMs).toISOString(),
    });

    let mailboxes = 0;
    let emails = 0;
    for (const mailbox of yield* repo.enabledMailboxes) {
      // Skipped: one the person has to relink (until they switch it on again), and one with
      // no label chosen yet (nothing is read before they say what).
      if (mailbox.needsReconnect || mailbox.label === null) continue;
      const lock = `email:lock:${keyOf(mailbox.owner)}`;
      if (!(yield* kv.setIfAbsent(lock, "1", { ttlSeconds: 300 }))) continue;
      mailboxes++;
      emails += yield* syncMailbox(mailbox, config).pipe(Effect.ensuring(kv.delete(lock)));
    }
    const run: EmailSyncRun = { mailboxes, emails };
    return run;
  });
