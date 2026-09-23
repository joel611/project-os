import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const task = sqliteTable("task", {
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});
