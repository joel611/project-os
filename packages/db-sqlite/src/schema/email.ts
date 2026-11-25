import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** A person's mailbox for the Email Digest: switched on or off, and where the last sync stopped. */
export const emailMailboxes = sqliteTable(
  "email_mailboxes",
  {
    ownerChannelType: text("owner_channel_type", { enum: ["discord", "email", "chat"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    cursor: text("cursor"),
    lastSyncAt: text("last_sync_at"),
    needsReconnect: integer("needs_reconnect", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerChannelType, t.ownerId] })],
);

/**
 * An email waiting for a project, or filed under one. The body is redacted, and emptied once
 * the email is filed or dismissed. A project is a plain id, not a foreign key: filing never
 * blocks deleting a project.
 */
export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    ownerChannelType: text("owner_channel_type", { enum: ["discord", "email", "chat"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id").notNull(),
    fromName: text("from_name"),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    receivedAt: text("received_at").notNull(),
    status: text("status", { enum: ["unassigned", "assigned", "dismissed"] }).notNull(),
    projectId: text("project_id"),
    assignedBy: text("assigned_by", { enum: ["classifier", "person"] }),
    suggestedProjectId: text("suggested_project_id"),
    confidence: real("confidence"),
  },
  (t) => [
    uniqueIndex("emails_owner_message_uq").on(t.ownerChannelType, t.ownerId, t.messageId),
    index("emails_owner_status_idx").on(t.ownerChannelType, t.ownerId, t.status, t.receivedAt),
    index("emails_status_received_idx").on(t.status, t.receivedAt),
  ],
);
