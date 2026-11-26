import type { EmailItem } from "@project-os/contracts";
import type { EmailRepository } from "@project-os/core";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { Effect } from "effect";
import { emailMailboxes, emails } from "../schema/index.ts";
import { q, type SqliteDb } from "./db.ts";

type Impl = (typeof EmailRepository)["Service"];
type Row = typeof emails.$inferSelect;

const toItem = (r: Row): EmailItem => ({
  id: r.id,
  owner: { channelType: r.ownerChannelType, id: r.ownerId },
  messageId: r.messageId,
  threadId: r.threadId,
  fromName: r.fromName,
  fromAddress: r.fromAddress,
  subject: r.subject,
  body: r.body,
  receivedAt: r.receivedAt,
  status: r.status,
  projectId: r.projectId,
  assignedBy: r.assignedBy,
  suggestedProjectId: r.suggestedProjectId,
  confidence: r.confidence,
});

const ownedBy = (owner: { channelType: "discord" | "email" | "chat"; id: string }) =>
  and(eq(emails.ownerChannelType, owner.channelType), eq(emails.ownerId, owner.id));

export const makeEmailRepository = (db: SqliteDb): Impl => ({
  mailbox: (owner) =>
    q(() =>
      db
        .select()
        .from(emailMailboxes)
        .where(
          and(
            eq(emailMailboxes.ownerChannelType, owner.channelType),
            eq(emailMailboxes.ownerId, owner.id),
          ),
        ),
    ).pipe(
      Effect.map(([r]) =>
        r
          ? {
              owner,
              enabled: r.enabled,
              label: r.label,
              cursor: r.cursor,
              lastSyncAt: r.lastSyncAt,
              needsReconnect: r.needsReconnect,
            }
          : null,
      ),
    ),
  saveMailbox: (m) =>
    q(() =>
      db
        .insert(emailMailboxes)
        .values({
          ownerChannelType: m.owner.channelType,
          ownerId: m.owner.id,
          enabled: m.enabled,
          label: m.label,
          cursor: m.cursor,
          lastSyncAt: m.lastSyncAt,
          needsReconnect: m.needsReconnect,
        })
        .onConflictDoUpdate({
          target: [emailMailboxes.ownerChannelType, emailMailboxes.ownerId],
          set: {
            enabled: m.enabled,
            label: m.label,
            cursor: m.cursor,
            lastSyncAt: m.lastSyncAt,
            needsReconnect: m.needsReconnect,
          },
        }),
    ).pipe(Effect.asVoid),
  enabledMailboxes: q(() =>
    db.select().from(emailMailboxes).where(eq(emailMailboxes.enabled, true)),
  ).pipe(
    Effect.map((rows) =>
      rows.map((r) => ({
        owner: { channelType: r.ownerChannelType, id: r.ownerId },
        enabled: r.enabled,
        label: r.label,
        cursor: r.cursor,
        lastSyncAt: r.lastSyncAt,
        needsReconnect: r.needsReconnect,
      })),
    ),
  ),
  insert: (e) =>
    q(() =>
      db
        .insert(emails)
        .values({
          id: e.id,
          ownerChannelType: e.owner.channelType,
          ownerId: e.owner.id,
          messageId: e.messageId,
          threadId: e.threadId,
          fromName: e.fromName,
          fromAddress: e.fromAddress,
          subject: e.subject,
          body: e.body,
          receivedAt: e.receivedAt,
          status: e.status,
          projectId: e.projectId,
          assignedBy: e.assignedBy,
          suggestedProjectId: e.suggestedProjectId,
          confidence: e.confidence,
        })
        .onConflictDoNothing()
        .returning({ id: emails.id }),
    ).pipe(Effect.map((rows) => rows.length > 0)),
  get: (id) =>
    q(() => db.select().from(emails).where(eq(emails.id, id))).pipe(
      Effect.map(([r]) => (r ? toItem(r) : null)),
    ),
  update: (id, patch) =>
    q(() => db.update(emails).set(patch).where(eq(emails.id, id))).pipe(Effect.asVoid),
  listUnassigned: (owner) =>
    q(() =>
      db
        .select()
        .from(emails)
        .where(and(ownedBy(owner), eq(emails.status, "unassigned")))
        .orderBy(desc(emails.receivedAt)),
    ).pipe(Effect.map((rows) => rows.map(toItem))),
  examples: (limit) =>
    q(() =>
      db
        .select()
        .from(emails)
        .where(and(eq(emails.status, "assigned"), eq(emails.assignedBy, "person")))
        .orderBy(desc(emails.receivedAt))
        .limit(limit),
    ).pipe(Effect.map((rows) => rows.map(toItem))),
  removeOlder: ({ waitingBefore, filedBefore }) =>
    q(() =>
      db
        .delete(emails)
        .where(
          or(
            and(
              inArray(emails.status, ["unassigned", "dismissed"]),
              lt(emails.receivedAt, waitingBefore),
            ),
            and(eq(emails.status, "assigned"), lt(emails.receivedAt, filedBefore)),
          ),
        )
        .returning({ id: emails.id }),
    ).pipe(Effect.map((rows) => rows.length)),
});
