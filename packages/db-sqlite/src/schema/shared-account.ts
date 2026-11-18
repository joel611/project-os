import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth.ts";

/**
 * An account an admin linked for the whole team (a bot's GitHub, a shared Google Drive). Its
 * tokens live on the `account` row of its own auth user, like a person's link does.
 */
export const sharedAccounts = sqliteTable(
  "shared_accounts",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: ["google", "github", "clickup"] }).notNull(),
    label: text("label").notNull(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("shared_accounts_provider_idx").on(t.provider)],
);

/** Which shared account a person without a personal link of their own acts with, per provider. */
export const sharedAccountAssignments = sqliteTable(
  "shared_account_assignments",
  {
    channelType: text("channel_type").notNull(),
    personId: text("person_id").notNull(),
    provider: text("provider", { enum: ["google", "github", "clickup"] }).notNull(),
    sharedAccountId: text("shared_account_id")
      .notNull()
      .references(() => sharedAccounts.id, { onDelete: "cascade" }),
    assignedBy: text("assigned_by").notNull(),
    assignedAt: text("assigned_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelType, t.personId, t.provider] }),
    index("shared_assignments_account_idx").on(t.sharedAccountId),
  ],
);
