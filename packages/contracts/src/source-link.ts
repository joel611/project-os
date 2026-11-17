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

/**
 * A repo link in any form people paste: `https://github.com/o/r`, the same without the scheme or
 * with `www.`, the SSH remote `git@github.com:o/r.git`, or the `o/r` shorthand. Anything after
 * the repo (a branch path, `?query`, `#anchor`, a trailing slash) is dropped.
 */
const GITHUB_REPO =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?([^/?#\s]+)\/([^/?#\s]+)(?:[/?#].*)?$/i;
/** GitHub user and org names: letters, digits and hyphens, not starting with one, at most 39. */
const GITHUB_OWNER = /^[a-z\d][a-z\d-]{0,38}$/i;
/** GitHub repo names: letters, digits, `.`, `-` and `_`, at most 100 characters, never `.` or `..`. */
const GITHUB_NAME = /^(?!\.{1,2}$)[\w.-]{1,100}$/;
const DRIVE_FOLDER =
  /^(?:(?:https?:\/\/)?drive\.google\.com\/.*?\/folders\/)?([\w-]{10,})(?:[/?#].*)?$/;

/**
 * The canonical `owner/repo` (lowercased, since GitHub names are case-insensitive) for a repo
 * link in any accepted form, or null when it isn't a GitHub repo. `gitlab.com/o/r` is rejected
 * because an owner never has a dot.
 */
export const normalizeGithubRepo = (raw: string): string | null => {
  const m = GITHUB_REPO.exec(raw.trim());
  if (!m) return null;
  const owner = m[1] as string;
  const name = (m[2] as string).replace(/\.git$/i, "");
  return GITHUB_OWNER.test(owner) && GITHUB_NAME.test(name)
    ? `${owner}/${name}`.toLowerCase()
    : null;
};

const parseRepo = (text: string): DetectedSource | null => {
  const externalId = normalizeGithubRepo(text);
  return externalId ? { type: "github_repo", externalId, name: externalId } : null;
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
