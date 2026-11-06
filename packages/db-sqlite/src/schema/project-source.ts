import { PROJECT_SOURCE_TYPES } from "@project-os/contracts";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./project.ts";

export const projectSources = sqliteTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type", {
      enum: PROJECT_SOURCE_TYPES,
    }).notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** Unique within the project; see migration 0003 for how pre-existing rows were named. */
    alias: text("alias").notNull(),
    description: text("description"),
    direction: text("direction", { enum: ["inbound", "outbound", "both"] }).notNull(),
    isDefaultResponse: integer("is_default_response", { mode: "boolean" }).notNull(),
    config: text("config", { mode: "json" }),
    status: text("status", { enum: ["active", "disabled"] }).notNull(),
    connectedBy: text("connected_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("project_sources_type_external_id_uq").on(t.type, t.externalId),
    uniqueIndex("project_sources_project_alias_uq").on(t.projectId, t.alias),
    // At most one default-response source per project.
    uniqueIndex("project_sources_one_default_per_project")
      .on(t.projectId)
      .where(sql`${t.isDefaultResponse} = 1`),
    index("project_sources_project_idx").on(t.projectId),
  ],
);
