import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { orgs } from "./org.ts";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  createdAt: text("created_at").notNull(),
});
