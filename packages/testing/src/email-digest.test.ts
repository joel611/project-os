import {
  assignEmail,
  DEFAULT_EMAIL_DIGEST,
  EMAIL_DIGEST_AUTHOR,
  EmailClassifier,
  EmailNotFound,
  EmailRepository,
  KeyValueStore,
  getMyEmail,
  listEmailLabels,
  MemoryRepository,
  type MailMessage,
  type Project,
  ProjectRepository,
  setMailboxEnabled,
  syncMailboxes,
  AuditLogRepository,
} from "@project-os/core";
import type { Requester } from "@project-os/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeTestLayer } from "./index.ts";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const ada: Requester = { channelType: "discord", id: "u1" };
const bob: Requester = { channelType: "discord", id: "u2" };

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  orgId: "o1",
  name: "Acme",
  slug: null,
  customInstructions: "Web shop",
  defaultResponseChannelId: null,
  channelDigest: true,
  channelDigestNotify: false,
  status: "active",
  createdBy: null,
  createdAt: ago(1000),
  updatedAt: ago(1000),
  ...over,
});

const mail = (
  over: Partial<MailMessage> & { readonly labels?: ReadonlyArray<string> } = {},
): MailMessage & { readonly labels?: ReadonlyArray<string> } => ({
  messageId: "g1",
  threadId: "t1",
  fromName: "Dana",
  fromAddress: "dana@acme.test",
  subject: "Acme launch date",
  body: "We decided the Acme launch is 1 December. Card 4242 4242 4242 4242.",
  receivedAt: ago(5),
  ...over,
});

const setup = (options: Parameters<typeof makeTestLayer>[0] = {}) => {
  const t = makeTestLayer({ now: NOW, ...options });
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        yield* projects.insert(project());
        yield* projects.insert(project({ id: "p2", name: "Globex" }));
        return yield* effect;
      }).pipe(Effect.provide(t.layer)) as Effect.Effect<A, E, never>,
    );
  return { ...t, run };
};

describe("syncMailboxes", () => {
  it("reads nothing on the first run, then files a sure match into memory with a redacted quote", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        t.emailSource.deliver(ada, mail());
        const first = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const second = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return {
          first,
          second,
          memory: yield* (yield* MemoryRepository).list("p1"),
          mine: yield* getMyEmail(ada, true),
          audit: (yield* (yield* AuditLogRepository).list({ limit: 10 })).entries,
        };
      }),
    );
    expect(out.first).toEqual({ mailboxes: 1, emails: 0 });
    expect(out.second).toEqual({ mailboxes: 1, emails: 1 });
    expect(out.memory).toHaveLength(1);
    expect(out.memory[0]).toMatchObject({ type: "decision", createdBy: EMAIL_DIGEST_AUTHOR });
    const source = out.memory[0]!.sourceMetadata as { quote: string; assignedBy: string };
    expect(source.assignedBy).toBe("classifier");
    expect(source.quote).toContain("[redacted card]");
    expect(source.quote).not.toContain("4242");
    expect(out.mine.unassigned).toEqual([]);
    expect(out.audit[0]).toMatchObject({
      kind: "digest_event",
      action: "email_filed",
      projectId: "p1",
    });
    // The model saw the redacted text, never the card number.
    expect(JSON.stringify(t.digestCalls)).not.toContain("4242");
  });

  it("holds an email below the threshold, with the suggestion, until the person assigns it", async () => {
    const t = setup({ emailConfidence: 0.6 });
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(ada, mail());
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const waiting = yield* getMyEmail(ada, true);
        const memoryBefore = yield* (yield* MemoryRepository).list("p1");
        const assigned = yield* assignEmail(ada, waiting.unassigned[0]!.id, "p1");
        return {
          waiting,
          memoryBefore,
          assigned,
          after: yield* getMyEmail(ada, true),
          memory: yield* (yield* MemoryRepository).list("p1"),
        };
      }),
    );
    expect(out.waiting.unassigned).toHaveLength(1);
    expect(out.waiting.unassigned[0]).toMatchObject({
      suggestedProjectId: "p1",
      confidence: 0.6,
    });
    expect(out.memoryBefore).toEqual([]);
    expect(out.assigned).toEqual({ saved: 1 });
    expect(out.after.unassigned).toEqual([]);
    expect(out.memory[0]!.sourceMetadata).toMatchObject({ assignedBy: "person" });
  });

  it("learns from a hand assignment: the next email from that sender goes to the same project", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        // Matches no project name: the classifier is unsure.
        t.emailSource.deliver(
          ada,
          mail({ messageId: "g1", subject: "Hello", body: "We decided on a new vendor." }),
        );
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const [first] = (yield* getMyEmail(ada, true)).unassigned;
        yield* assignEmail(ada, first!.id, "p2");
        t.emailSource.deliver(
          ada,
          mail({ messageId: "g2", subject: "Re: Hello", body: "We decided to sign today." }),
        );
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return yield* (yield* MemoryRepository).list("p2");
      }),
    );
    expect(out).toHaveLength(2);
    const last = t.emailClassifyCalls.at(-1)!;
    expect(last.projects.find((p) => p.id === "p2")!.examples).toEqual([
      { from: "dana@acme.test", subject: "Hello" },
    ]);
  });

  it("keeps an email waiting when the classifier or the digest fails, and ignores repeats", async () => {
    const classifierDown = setup({ failEmailClassify: "model down" });
    const a = await classifierDown.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        classifierDown.emailSource.deliver(ada, mail(), mail());
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return (yield* getMyEmail(ada, true)).unassigned;
      }),
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ suggestedProjectId: null, confidence: null });

    const digestDown = setup({ failDigest: "boom" });
    const b = await digestDown.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        digestDown.emailSource.deliver(ada, mail());
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const waiting = yield* getMyEmail(ada, true);
        const retry = yield* Effect.flip(assignEmail(ada, waiting.unassigned[0]!.id, "p1"));
        return { waiting: waiting.unassigned, retry };
      }),
    );
    expect(b.waiting).toHaveLength(1);
    expect(b.retry._tag).toBe("EmailDigestFailed");
  });

  it("does nothing with no projects, and skips a mailbox mid-run or switched off", async () => {
    const t = makeTestLayer({ now: NOW });
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(ada, mail());
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const waiting = yield* getMyEmail(ada, true);
        yield* setMailboxEnabled(ada, false);
        const off = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return { waiting: waiting.unassigned.length, calls: t.emailClassifyCalls.length, off };
      }).pipe(Effect.provide(t.layer)),
    );
    expect(out).toEqual({ waiting: 1, calls: 0, off: { mailboxes: 0, emails: 0 } });
  });

  it("flags a mailbox that needs relinking and stops reading it until it is switched on again", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        t.emailSource.fail({ message: "no gmail scope", reconnect: true });
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const flagged = yield* getMyEmail(ada, true);
        t.emailSource.fail({ message: "should not be called", reconnect: false });
        const skipped = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.fail(undefined);
        yield* setMailboxEnabled(ada, true, "all");
        const retried = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return { flagged, skipped, retried, after: yield* getMyEmail(ada, true) };
      }),
    );
    expect(out.flagged.needsReconnect).toBe(true);
    expect(out.skipped).toEqual({ mailboxes: 0, emails: 0 });
    expect(out.retried.mailboxes).toBe(1);
    expect(out.after).toMatchObject({ needsReconnect: false, enabled: true });
    expect(out.after.lastSyncAt).not.toBeNull();
  });

  it("logs a failed read without flagging when the mailbox is just unavailable", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        t.emailSource.fail({ message: "gmail 503", reconnect: false });
        const run = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return { run, mine: yield* getMyEmail(ada, true) };
      }),
    );
    expect(out.run).toEqual({ mailboxes: 1, emails: 0 });
    expect(out.mine.needsReconnect).toBe(false);
  });

  it("drops old waiting emails but keeps filed ones longer", async () => {
    const t = setup({ emailConfidence: 0.5 });
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(
          ada,
          mail({ receivedAt: ago(40 * 24 * 60) }),
          mail({ messageId: "g2" }),
        );
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const before = (yield* getMyEmail(ada, true)).unassigned.length;
        const repo = yield* EmailRepository;
        const old = (yield* repo.listUnassigned(ada)).find((e) => e.messageId === "g1")!;
        yield* repo.update(old.id, { status: "assigned", projectId: "p1", assignedBy: "person" });
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return { before, keptFiled: (yield* repo.get(old.id)) !== null };
      }),
    );
    expect(out.before).toBe(2);
    expect(out.keptFiled).toBe(true);
    // And a 40-day-old waiting email is gone on the next run.
    const t2 = setup({ emailConfidence: 0.5 });
    const gone = await t2.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t2.emailSource.deliver(ada, mail({ receivedAt: ago(40 * 24 * 60) }));
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return (yield* getMyEmail(ada, true)).unassigned;
      }),
    );
    expect(gone).toEqual([]);
  });
});

describe("syncMailboxes edge cases", () => {
  it("reads an email with no sender name, and skips a mailbox another run is reading", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(ada, mail({ fromName: null }));
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const memory = yield* (yield* MemoryRepository).list("p1");
        // Another run holds the mailbox: this one leaves it alone.
        yield* (yield* KeyValueStore).set("email:lock:discord:u1", "1");
        t.emailSource.deliver(ada, mail({ messageId: "g2" }));
        const skipped = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return { memory, skipped };
      }),
    );
    expect(out.memory[0]!.sourceMetadata).toMatchObject({ from: "dana@acme.test" });
    expect(out.skipped).toEqual({ mailboxes: 0, emails: 0 });
  });
});

describe("long emails", () => {
  it("cuts a long subject, shows a short excerpt, and quotes only the start of the body", async () => {
    const t = setup({ emailConfidence: 0.5 });
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(
          ada,
          mail({ subject: "s".repeat(400), body: `We decided on Acme. ${"x".repeat(900)}` }),
        );
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const [waiting] = (yield* getMyEmail(ada, true)).unassigned;
        yield* assignEmail(ada, waiting!.id, "p1");
        return { waiting, memory: yield* (yield* MemoryRepository).list("p1") };
      }),
    );
    expect(out.waiting!.subject).toHaveLength(300);
    expect(out.waiting!.excerpt).toHaveLength(240);
    expect((out.memory[0]!.sourceMetadata as { quote: string }).quote).toHaveLength(500);
  });
});

describe("a classifier that names a project that is gone", () => {
  it("leaves the email waiting", async () => {
    const t = setup();
    const ghost = Layer.succeed(EmailClassifier, {
      classify: () => Effect.succeed({ projectId: "ghost", confidence: 0.99 }),
    });
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(ada, mail());
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return (yield* getMyEmail(ada, true)).unassigned;
      }).pipe(Effect.provide(ghost)),
    );
    expect(out).toHaveLength(1);
  });
});

describe("assignEmail", () => {
  it("dismisses an email, and refuses another person's, a missing one, and one already filed", async () => {
    const t = setup({ emailConfidence: 0.5 });
    const out = await t.run(
      Effect.gen(function* () {
        yield* setMailboxEnabled(ada, true, "all");
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(ada, mail());
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const [email] = (yield* getMyEmail(ada, true)).unassigned;
        const theirs = yield* Effect.flip(assignEmail(bob, email!.id, "p1"));
        const missing = yield* Effect.flip(assignEmail(ada, "nope", "p1"));
        const noProject = yield* Effect.flip(assignEmail(ada, email!.id, "ghost"));
        const dismissed = yield* assignEmail(ada, email!.id, null);
        const again = yield* Effect.flip(assignEmail(ada, email!.id, "p1"));
        return { theirs, missing, noProject, dismissed, again, mine: yield* getMyEmail(ada, true) };
      }),
    );
    expect(out.theirs).toBeInstanceOf(EmailNotFound);
    expect(out.missing).toBeInstanceOf(EmailNotFound);
    expect(out.noProject._tag).toBe("ProjectNotFound");
    expect(out.dismissed).toEqual({ saved: 0 });
    expect(out.again).toBeInstanceOf(EmailNotFound);
    expect(out.mine.unassigned).toEqual([]);
  });
});

describe("the label a mailbox reads", () => {
  it("needs a label to switch on, reuses it when switched back on, and can change it", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        const refused = yield* Effect.flip(setMailboxEnabled(ada, true));
        const off = yield* getMyEmail(ada, true);
        yield* setMailboxEnabled(ada, true, "Label_1");
        const on = yield* getMyEmail(ada, true);
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        // Turned off and on again without saying: the label it had.
        yield* setMailboxEnabled(ada, false);
        yield* setMailboxEnabled(ada, true);
        const again = yield* getMyEmail(ada, true);
        // Changing it while on keeps the cursor: nothing is read twice or skipped.
        const repo = yield* EmailRepository;
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        const before = yield* repo.mailbox(ada);
        yield* setMailboxEnabled(ada, true, "all");
        const after = yield* repo.mailbox(ada);
        return {
          refused,
          off,
          on,
          again,
          kept: after!.cursor !== null && after!.cursor === before!.cursor,
          label: after!.label,
        };
      }),
    );
    expect(out.refused._tag).toBe("EmailLabelRequired");
    expect(out.off).toMatchObject({ enabled: false, label: null });
    expect(out.on).toMatchObject({ enabled: true, label: "Label_1" });
    expect(out.again).toMatchObject({ enabled: true, label: "Label_1" });
    expect(out.kept).toBe(true);
    expect(out.label).toBe("all");
  });

  it("reads only mail with the chosen label, and nothing for a mailbox with no label yet", async () => {
    const t = setup();
    const out = await t.run(
      Effect.gen(function* () {
        const repo = yield* EmailRepository;
        // A mailbox switched on before labels existed: on, but no label.
        yield* repo.saveMailbox({
          owner: ada,
          enabled: true,
          label: null,
          cursor: "old",
          lastSyncAt: null,
          needsReconnect: false,
        });
        const skipped = yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        // Choosing a label starts from now, not from the old cursor.
        yield* setMailboxEnabled(ada, true, "Label_1");
        const restarted = (yield* repo.mailbox(ada))!.cursor;
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        t.emailSource.deliver(
          ada,
          mail({ messageId: "in", labels: ["INBOX", "Label_1"] }),
          mail({ messageId: "out", labels: ["INBOX"] }),
        );
        yield* syncMailboxes(DEFAULT_EMAIL_DIGEST);
        return {
          skipped,
          restarted,
          syncs: t.emailSource.syncs,
          filed: (yield* (yield* MemoryRepository).list("p1")).length,
          waiting: (yield* getMyEmail(ada, true)).unassigned.length,
        };
      }),
    );
    expect(out.skipped).toEqual({ mailboxes: 0, emails: 0 });
    expect(out.restarted).toBeNull();
    expect(out.syncs.every((s) => s.label === "Label_1")).toBe(true);
    // Only the labelled one was read; the other never left the mailbox.
    expect(out.filed + out.waiting).toBe(1);
  });

  it("lists the labels a person may pick from", async () => {
    const t = setup();
    t.emailSource.setLabels([{ id: "Label_1", name: "Clients" }]);
    const labels = await t.run(listEmailLabels(ada));
    expect(labels).toEqual([{ id: "Label_1", name: "Clients" }]);
    t.emailSource.fail({ message: "down", reconnect: false });
    const failed = await t.run(Effect.flip(listEmailLabels(ada)));
    expect(failed.message).toBe("down");
  });
});

describe("getMyEmail", () => {
  it("shows an off, empty mailbox for someone who never switched it on", async () => {
    const t = setup();
    const mine = await t.run(getMyEmail(bob, false));
    expect(mine).toEqual({
      available: false,
      enabled: false,
      label: null,
      needsReconnect: false,
      lastSyncAt: null,
      projects: [
        { id: "p1", name: "Acme" },
        { id: "p2", name: "Globex" },
      ],
      unassigned: [],
    });
  });
});
