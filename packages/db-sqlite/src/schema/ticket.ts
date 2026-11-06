import { TICKET_STATUSES, WORKER_TYPES } from "@project-os/contracts";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { projects } from "./project.ts";

export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    status: text("status", {
      enum: TICKET_STATUSES,
    }).notNull(),
    title: text("title").notNull(),
    intent: text("intent"),
    inputSummary: text("input_summary").notNull(),
    priority: text("priority"),
    workerType: text("worker_type", { enum: WORKER_TYPES }),
    workerId: text("worker_id"),
    result: text("result", { mode: "json" }),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    assignedAt: text("assigned_at"),
    startedAt: text("started_at"),
    lastActivityAt: text("last_activity_at").notNull(),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("tickets_status_worker_idx").on(t.status, t.workerId),
    index("tickets_project_idx").on(t.projectId),
  ],
);
