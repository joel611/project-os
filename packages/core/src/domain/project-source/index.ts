import type { ProjectSource, ProjectSourceType, SourceDirection } from "@project-os/contracts";
import { Data } from "effect";

export type { ProjectSource, ProjectSourceType, SourceDirection };

/** `(type, externalId)` is already linked to a project. Enforces the 1:1 channel → project rule. */
export class SourceAlreadyLinked extends Data.TaggedError("SourceAlreadyLinked")<{
  readonly type: ProjectSourceType;
  readonly externalId: string;
  readonly projectId: string;
}> {}

export class SourceNotFound extends Data.TaggedError("SourceNotFound")<{
  readonly sourceId: string;
}> {}

/** Another source in the same project already uses this alias. */
export class SourceAliasTaken extends Data.TaggedError("SourceAliasTaken")<{
  readonly projectId: string;
  readonly alias: string;
}> {}

/** The alias isn't a short lowercase handle (see `normalizeAlias`). */
export class InvalidSourceAlias extends Data.TaggedError("InvalidSourceAlias")<{
  readonly alias: string;
  readonly message: string;
}> {}

/** The external id isn't a valid link for its type, e.g. a GitHub repo that isn't `owner/repo`. */
export class InvalidSourceLink extends Data.TaggedError("InvalidSourceLink")<{
  readonly type: ProjectSourceType;
  readonly externalId: string;
  readonly message: string;
}> {}

export const ALIAS_MAX_LENGTH = 40;
const ALIAS_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Canonical alias: trimmed, lowercased, inner whitespace as `-`. Valid aliases are lowercase
 * letters and digits joined by single `-` or `_`, at most 40 characters (`design-docs`, `web`).
 * Returns null when the result isn't valid.
 */
export const normalizeAlias = (raw: string): string | null => {
  const alias = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return alias.length <= ALIAS_MAX_LENGTH && ALIAS_PATTERN.test(alias) ? alias : null;
};

/** Best-effort alias from free text (a channel or repo name), or `fallback` if nothing is left. */
export const aliasFrom = (text: string, fallback: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ALIAS_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug || fallback;
};

/** `base`, or `base-2`, `base-3`, … — the first one not in `taken`. */
export const uniqueAlias = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, ALIAS_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** Where a source lives on the web, when it has a link (repos, Drive folders). */
export const sourceUrl = (s: Pick<ProjectSource, "type" | "externalId">): string | null =>
  s.type === "github_repo"
    ? `https://github.com/${s.externalId}`
    : s.type === "google_drive_folder"
      ? `https://drive.google.com/drive/folders/${s.externalId}`
      : null;

export const isInbound = (s: ProjectSource): boolean =>
  s.status === "active" && s.direction !== "outbound";
