/**
 * Turning a pasted link into a project source. The dashboard's "link a source" field and the
 * Discord `/source-add` command share this, so both accept the same links.
 */

/** What a pasted link turns into, before someone names it. */
export interface DetectedSource {
  readonly type: "github_repo" | "google_drive_folder";
  readonly externalId: string;
  readonly name: string;
}

const GITHUB_REPO =
  /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/;
const DRIVE_FOLDER =
  /^(?:(?:https?:\/\/)?drive\.google\.com\/.*?\/folders\/)?([\w-]{10,})(?:[/?#].*)?$/;

const parseRepo = (text: string): DetectedSource | null => {
  const m = GITHUB_REPO.exec(text);
  if (!m) return null;
  const externalId = `${m[1]}/${m[2]}`.toLowerCase();
  return { type: "github_repo", externalId, name: externalId };
};

const parseFolder = (text: string): DetectedSource | null => {
  const id = DRIVE_FOLDER.exec(text)?.[1];
  return id
    ? { type: "google_drive_folder", externalId: id, name: `Drive folder ${id.slice(0, 8)}…` }
    : null;
};

/**
 * Detects the source type from a pasted link (URL or short form) and normalizes it to the
 * `(type, externalId)` the Coordinator keys on. Repo names are case-insensitive, so they are
 * lowercased to keep the key canonical. `owner/repo` is a repo, a bare long id is a Drive folder.
 */
export const detectSource = (raw: string): DetectedSource | null => {
  const text = raw.trim();
  if (text.includes("drive.google.com")) return parseFolder(text);
  return parseRepo(text) ?? parseFolder(text);
};

/** A starting alias for a pasted link: a repo's name. A Drive folder id says nothing, so none. */
export const suggestAlias = (source: DetectedSource | null): string =>
  source?.type === "github_repo"
    ? source.externalId
        .slice(source.externalId.indexOf("/") + 1)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
    : "";
