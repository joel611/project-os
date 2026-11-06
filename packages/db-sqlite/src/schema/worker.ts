import { WORKER_TYPES } from "@project-os/contracts";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workers = sqliteTable(
  "workers",
  {
    id: text("id").primaryKey(),
    workerType: text("worker_type", { enum: WORKER_TYPES }).notNull(),
    /** Set on personal workers (registered with /register-worker): whose tickets they serve. */
    ownerChannelType: text("owner_channel_type", { enum: ["discord", "email", "chat"] }),
    ownerId: text("owner_id"),
    name: text("name"),
    /** SHA-256 of the device's bearer secret; the secret itself is never stored. */
    secretHash: text("secret_hash"),
    currentTicketId: text("current_ticket_id"),
    lastSeenAt: text("last_seen_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("workers_owner_idx").on(t.ownerChannelType, t.ownerId),
    uniqueIndex("workers_secret_hash_uq").on(t.secretHash),
  ],
);
