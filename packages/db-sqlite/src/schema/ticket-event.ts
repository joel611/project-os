import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tickets } from "./ticket.ts";

export const ticketEvents = sqliteTable(
  "ticket_events",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => tickets.id),
    type: text("type", {
      enum: [
        "created",
        "assigned",
        "status_update",
        "comment",
        "follow_up",
        "result",
        "error",
        "system",
      ],
    }).notNull(),
    actor: text("actor", { enum: ["coordinator", "worker", "system"] }).notNull(),
    actorId: text("actor_id"),
    body: text("body").notNull(),
    payload: text("payload", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("ticket_events_ticket_idx").on(t.ticketId, t.createdAt)],
);
