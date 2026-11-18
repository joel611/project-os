import {
  isSafeSkillPath,
  SKILL_LIMITS,
  SkillFetchFailed,
  type SkillSource,
  parseSkillFrontmatter,
  type SkillFile,
} from "@project-os/core";
import { Effect } from "effect";

export interface GithubSkillSourceConfig {
  /** Test hook, and workerd's "Illegal invocation" guard. Default: global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Raises GitHub's 60 requests an hour for anonymous callers. A read-only token is enough. */
  readonly token?: string;
  /** How long a repo's file listing is reused. Default 30 seconds. */
  readonly listingTtlMs?: number;
  readonly now?: () => number;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
  readonly size?: number;
}

interface Listing {
  readonly branch: string;
  readonly entries: ReadonlyArray<TreeEntry>;
}

const MAX_SKILLS_LISTED = 100;
const CONCURRENCY = 6;

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Skills straight from GitHub: a skill is a folder with a SKILL.md, and skills.sh's own ids
 * (`owner/repo/skill`) point at those folders. A folder's git tree SHA is its version: it
 * changes exactly when a file inside changes, with no download needed to find out.
 */
export const makeGithubSkillSource = (
  config: GithubSkillSourceConfig = {},
): typeof SkillSource.Service => {
  const send = config.fetch ?? ((input, init) => fetch(input, init));
  const ttl = config.listingTtlMs ?? 30_000;
  const now = config.now ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly listing: Listing }>();

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "project-os-skills",
    ...(config.token && { authorization: `Bearer ${config.token}` }),
  };

  const get = (url: string, what: string) =>
    Effect.tryPromise({
      try: async () => {
        const res = await send(url, { headers });
        if (res.status === 403 || res.status === 429) {
          throw new Error(
            `GitHub is rate limiting the Coordinator while it reads ${what}; try again later.`,
          );
        }
        if (res.status === 404) throw new Error(`${what} was not found on GitHub.`);
        if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${what}.`);
        return (await res.json()) as unknown;
      },
      catch: (e) => new SkillFetchFailed({ message: e instanceof Error ? e.message : String(e) }),
    });

  const listing = (source: string, fresh: boolean) =>
    Effect.gen(function* () {
      if (!REPO.test(source))
        return yield* new SkillFetchFailed({ message: `Bad repo ${source}.` });
      const hit = cache.get(source);
      if (!fresh && hit && now() - hit.at < ttl) return hit.listing;
      const repo = (yield* get(`https://api.github.com/repos/${source}`, source)) as {
        default_branch?: string;
      };
      const branch = repo.default_branch ?? "main";
      const tree = (yield* get(
        `https://api.github.com/repos/${source}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        `the files of ${source}`,
      )) as { tree?: ReadonlyArray<TreeEntry>; truncated?: boolean };
      if (tree.truncated) {
        return yield* new SkillFetchFailed({ message: `${source} is too large to list.` });
      }
      const found: Listing = { branch, entries: tree.tree ?? [] };
      cache.set(source, { at: now(), listing: found });
      return found;
    });

  const folderOf = (skillMd: string) => skillMd.slice(0, -"/SKILL.md".length);

  /** SHA of a folder's git tree; null when it is gone. */
  const shaOf = (entries: ReadonlyArray<TreeEntry>, path: string): string | null =>
    entries.find((e) => e.type === "tree" && e.path === path)?.sha ?? null;

  const mapLimit = <A, B, E>(items: ReadonlyArray<A>, f: (a: A) => Effect.Effect<B, E>) =>
    Effect.forEach(items, f, { concurrency: CONCURRENCY });

  const description = (source: string, branch: string, path: string) =>
    Effect.tryPromise({
      try: async () => {
        const res = await send(
          `https://raw.githubusercontent.com/${source}/${branch}/${path}/SKILL.md`,
          { headers: { "user-agent": headers["user-agent"]! } },
        );
        return res.ok ? parseSkillFrontmatter(await res.text()) : { name: "", description: "" };
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => ({ name: "", description: "" })));

  return {
    list: (source) =>
      Effect.gen(function* () {
        const { branch, entries } = yield* listing(source, true);
        const folders = entries
          .filter((e) => e.type === "blob" && e.path.endsWith("/SKILL.md"))
          .map((e) => folderOf(e.path))
          .filter(isSafeSkillPath)
          .sort((a, b) => a.length - b.length || a.localeCompare(b))
          .slice(0, MAX_SKILLS_LISTED);
        const seen = new Set<string>();
        const unique = folders.filter((folder) => {
          const slug = folder.split("/").pop()!;
          if (seen.has(slug)) return false;
          seen.add(slug);
          return true;
        });
        return yield* mapLimit(unique, (folder) =>
          Effect.map(description(source, branch, folder), (meta) => {
            const slug = folder.split("/").pop()!;
            return {
              source,
              slug,
              name: meta.name || slug,
              description: meta.description,
              path: folder,
            };
          }),
        );
      }),
    latestSha: (source, path) =>
      Effect.map(listing(source, false), ({ entries }) => shaOf(entries, path)),
    fetch: (source, path) =>
      Effect.gen(function* () {
        const { entries } = yield* listing(source, true);
        const sha = shaOf(entries, path);
        const prefix = `${path}/`;
        const inside = entries.filter((e) => e.path.startsWith(prefix));
        if (
          sha === null ||
          !isSafeSkillPath(path) ||
          !inside.some((e) => e.path === `${prefix}SKILL.md`)
        ) {
          return yield* new SkillFetchFailed({ message: `${source}/${path} has no SKILL.md.` });
        }
        const blobs = inside.filter(
          // Symlinks (120000) and submodules are never followed.
          (e) =>
            e.type === "blob" &&
            e.mode !== "120000" &&
            !e.path.slice(prefix.length).startsWith(".") &&
            isSafeSkillPath(e.path.slice(prefix.length)),
        );
        if (blobs.length > SKILL_LIMITS.maxFiles) {
          return yield* new SkillFetchFailed({
            message: `${source}/${path} has more than ${SKILL_LIMITS.maxFiles} files.`,
          });
        }
        const files: SkillFile[] = [];
        let total = 0;
        const read = yield* mapLimit(blobs, (blob) =>
          Effect.gen(function* () {
            if ((blob.size ?? 0) > SKILL_LIMITS.maxFileBytes) return undefined;
            const body = (yield* get(
              `https://api.github.com/repos/${source}/git/blobs/${blob.sha}`,
              blob.path,
            )) as { content?: string; encoding?: string };
            if (body.encoding !== "base64" || body.content === undefined) return undefined;
            const text = decodeText(body.content);
            return text === undefined
              ? undefined
              : ({ path: blob.path.slice(prefix.length), contents: text } satisfies SkillFile);
          }),
        );
        for (const file of read) {
          if (!file) continue;
          total += file.contents.length;
          files.push(file);
        }
        if (total > SKILL_LIMITS.maxTotalBytes) {
          return yield* new SkillFetchFailed({
            message: `${source}/${path} is bigger than ${SKILL_LIMITS.maxTotalBytes / 1024} KB.`,
          });
        }
        if (!files.some((f) => f.path === "SKILL.md")) {
          return yield* new SkillFetchFailed({
            message: `${source}/${path} has no readable SKILL.md.`,
          });
        }
        return { sha, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
      }),
  };
};

/** UTF-8 text from GitHub's base64; undefined for a binary file, which a skill can't use here. */
const decodeText = (base64: string): string | undefined => {
  try {
    const bytes = Uint8Array.from(atob(base64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};
