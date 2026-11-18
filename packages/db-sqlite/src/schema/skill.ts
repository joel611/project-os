import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const skillSets = sqliteTable(
  "skill_sets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("skill_sets_name_uq").on(t.name)],
);

export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(),
    skillSetId: text("skill_set_id")
      .notNull()
      .references(() => skillSets.id),
    source: text("source").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    path: text("path").notNull(),
    sha: text("sha").notNull(),
    /** Where the downloaded folder is kept: a zip in the asset store (R2 on Cloudflare). */
    archiveKey: text("archive_key").notNull(),
    fileCount: integer("file_count").notNull(),
    bytes: integer("bytes").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    fetchedBy: text("fetched_by"),
  },
  (t) => [
    uniqueIndex("skills_set_source_slug_uq").on(t.skillSetId, t.source, t.slug),
    index("skills_set_idx").on(t.skillSetId),
  ],
);
