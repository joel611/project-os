import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { orgs } from "./org.ts";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  name: text("name").notNull(),
  slug: text("slug"),
  customInstructions: text("custom_instructions").notNull(),
  // Logical FK to project_sources.id (not enforced: circular with project_sources.project_id).
  defaultResponseChannelId: text("default_response_channel_id"),
  channelDigest: integer("channel_digest", { mode: "boolean" }).notNull().default(true),
  channelDigestNotify: integer("channel_digest_notify", { mode: "boolean" })
    .notNull()
    .default(false),
  status: text("status", { enum: ["active", "archived", "deleted"] }).notNull(),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
