import { SKILL_LIMITS } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeGithubSkillSource } from "./skills-github.ts";

const b64 = (text: string) => btoa(text);
const bytesB64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

interface Entry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  mode?: string;
  size?: number;
}

/** A GitHub that serves one repo from memory and counts the calls it gets. */
const github = (
  entries: Entry[],
  blobs: Record<string, string>,
  raw: Record<string, string> = {},
  opts: { repo?: number; tree?: object; truncated?: boolean; blob?: number } = {},
) => {
  const calls: string[] = [];
  const auth: Array<string | null> = [];
  const send = (async (input: string, init?: RequestInit) => {
    calls.push(input);
    const headers = new Headers(init?.headers);
    auth.push(headers.get("authorization"));
    const url = new URL(input);
    if (url.hostname === "raw.githubusercontent.com") {
      const text = raw[url.pathname];
      return text === undefined ? new Response("", { status: 404 }) : new Response(text);
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return opts.repo
        ? new Response("{}", { status: opts.repo })
        : Response.json({ default_branch: "trunk" });
    }
    if (url.pathname.includes("/git/trees/")) {
      return Response.json(opts.tree ?? { tree: entries, truncated: opts.truncated ?? false });
    }
    const sha = url.pathname.split("/").pop()!;
    if (opts.blob) return new Response("{}", { status: opts.blob });
    return blobs[sha] === undefined
      ? new Response("{}", { status: 404 })
      : Response.json({ content: blobs[sha], encoding: "base64" });
  }) as unknown as typeof fetch;
  return { send, calls, auth };
};

const repoEntries: Entry[] = [
  { path: "README.md", type: "blob", sha: "r", mode: "100644" },
  { path: "skills", type: "tree", sha: "t-skills" },
  { path: "skills/tdd", type: "tree", sha: "t-tdd" },
  { path: "skills/tdd/SKILL.md", type: "blob", sha: "b-md", mode: "100644", size: 40 },
  { path: "skills/tdd/examples", type: "tree", sha: "t-ex" },
  { path: "skills/tdd/examples/a.ts", type: "blob", sha: "b-a", mode: "100644", size: 9 },
  { path: "skills/tdd/logo.png", type: "blob", sha: "b-bin", mode: "100644", size: 4 },
  { path: "skills/tdd/link", type: "blob", sha: "b-link", mode: "120000", size: 3 },
  { path: "skills/tdd/.hidden", type: "blob", sha: "b-h", mode: "100644", size: 3 },
  { path: "skills/tdd/big.txt", type: "blob", sha: "b-big", mode: "100644", size: 999_999 },
  { path: "skills/review", type: "tree", sha: "t-review" },
  { path: "skills/review/SKILL.md", type: "blob", sha: "b-r", mode: "100644", size: 10 },
  { path: "skills/nested/tdd", type: "tree", sha: "t-other" },
  { path: "skills/nested/tdd/SKILL.md", type: "blob", sha: "b-o", mode: "100644", size: 10 },
  { path: "SKILL.md", type: "blob", sha: "b-root", mode: "100644", size: 10 },
  { path: "../evil/SKILL.md", type: "blob", sha: "b-evil", mode: "100644", size: 10 },
];

const blobs = {
  "b-md": b64("---\nname: Test-driven\ndescription: Red green\n---\n# tdd"),
  "b-a": b64("export {}"),
  "b-bin": bytesB64([0xff, 0xfe, 0x00, 0x80]),
  "b-big": b64("x"),
  "b-r": b64("# review"),
};
const raw = {
  "/acme/skills/trunk/skills/tdd/SKILL.md": "---\nname: Test-driven\ndescription: Red green\n---\n",
  "/acme/skills/trunk/skills/review/SKILL.md": "# no frontmatter",
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fails = (effect: Effect.Effect<unknown, { message: string }>) =>
  Effect.runPromise(Effect.flip(effect)).then((e) => e.message);

describe("makeGithubSkillSource", () => {
  it("lists skill folders, reading names and descriptions from the raw SKILL.md", async () => {
    const gh = github(repoEntries, blobs, raw);
    const source = makeGithubSkillSource({ fetch: gh.send });
    const found = await run(source.list("acme/skills"));
    // Shortest path first; a second `tdd` folder and the repo-root SKILL.md are skipped.
    expect(found).toEqual([
      {
        source: "acme/skills",
        slug: "tdd",
        name: "Test-driven",
        description: "Red green",
        path: "skills/tdd",
      },
      {
        source: "acme/skills",
        slug: "review",
        name: "review",
        description: "",
        path: "skills/review",
      },
    ]);
    // The branch is the repo's own default.
    expect(gh.calls.some((c) => c.endsWith("/git/trees/trunk?recursive=1"))).toBe(true);
  });

  it("downloads a folder's text files, leaving out binaries, symlinks, hidden and oversize files", async () => {
    const gh = github(repoEntries, blobs, raw);
    const source = makeGithubSkillSource({ fetch: gh.send });
    const got = await run(source.fetch("acme/skills", "skills/tdd"));
    expect(got.sha).toBe("t-tdd");
    expect(got.files).toEqual([
      { path: "examples/a.ts", contents: "export {}" },
      { path: "SKILL.md", contents: "---\nname: Test-driven\ndescription: Red green\n---\n# tdd" },
    ]);
  });

  it("reports a folder's tree SHA, null once it is gone, and reuses the listing briefly", async () => {
    let t = 0;
    const gh = github(repoEntries, blobs, raw);
    const source = makeGithubSkillSource({ fetch: gh.send, now: () => t, listingTtlMs: 1000 });
    expect(await run(source.latestSha("acme/skills", "skills/tdd"))).toBe("t-tdd");
    expect(await run(source.latestSha("acme/skills", "skills/gone"))).toBeNull();
    expect(gh.calls.filter((c) => c.includes("/git/trees/"))).toHaveLength(1);
    t = 2000;
    await run(source.latestSha("acme/skills", "skills/tdd"));
    expect(gh.calls.filter((c) => c.includes("/git/trees/"))).toHaveLength(2);
  });

  it("sends the token only to the GitHub API, never to raw.githubusercontent.com", async () => {
    const gh = github(repoEntries, blobs, raw);
    await run(makeGithubSkillSource({ fetch: gh.send, token: "tok" }).list("acme/skills"));
    const byHost = gh.calls.map((c, i) => [new URL(c).hostname, gh.auth[i]] as const);
    expect(
      byHost.filter(([h]) => h === "api.github.com").every(([, a]) => a === "Bearer tok"),
    ).toBe(true);
    expect(
      byHost.filter(([h]) => h === "raw.githubusercontent.com").every(([, a]) => a === null),
    ).toBe(true);
  });

  it("resolves credentials for every API request, preferring shared tokens over the PAT", async () => {
    const gh = github(repoEntries, blobs, raw);
    const tokens = ["shared-1", "shared-2", undefined, ""];
    const source = makeGithubSkillSource({
      fetch: gh.send,
      token: "pat",
      getToken: async () => tokens.shift(),
    });
    await run(source.list("acme/skills"));
    await run(source.list("acme/skills"));
    expect(
      gh.calls.flatMap((url, i) =>
        new URL(url).hostname === "api.github.com" ? [gh.auth[i]] : [],
      ),
    ).toEqual(["Bearer shared-1", "Bearer shared-2", "Bearer pat", "Bearer pat"]);
    expect(
      gh.calls.flatMap((url, i) =>
        new URL(url).hostname === "raw.githubusercontent.com" ? [gh.auth[i]] : [],
      ),
    ).toEqual([null, null, null, null]);
  });

  it("uses anonymous API requests when neither shared nor static token exists", async () => {
    const gh = github(repoEntries, blobs, raw);
    await run(
      makeGithubSkillSource({ fetch: gh.send, getToken: async () => undefined }).list(
        "acme/skills",
      ),
    );
    expect(gh.auth).toEqual([null, null, null, null]);
  });

  it("reports credential lookup failures as SkillFetchFailed", async () => {
    const gh = github(repoEntries, blobs, raw);
    const source = makeGithubSkillSource({
      fetch: gh.send,
      token: "pat",
      getToken: async () => {
        throw new Error("credential lookup failed");
      },
    });
    const error = await run(Effect.flip(source.list("acme/skills")));
    expect(error._tag).toBe("SkillFetchFailed");
    expect(error.message).toBe("credential lookup failed");
    expect(gh.calls).toEqual([]);
  });

  it("does not retry rejected shared credentials with the PAT", async () => {
    const gh = github([], {}, {}, { repo: 401 });
    const source = makeGithubSkillSource({
      fetch: gh.send,
      token: "pat",
      getToken: async () => "shared",
    });
    expect(await fails(source.list("acme/skills"))).toContain("401");
    expect(gh.auth).toEqual(["Bearer shared"]);
  });

  it("explains rate limits, missing repos and other failures", async () => {
    const limited = makeGithubSkillSource({ fetch: github([], {}, {}, { repo: 403 }).send });
    expect(await fails(limited.list("acme/skills"))).toContain("rate limiting");
    const missing = makeGithubSkillSource({ fetch: github([], {}, {}, { repo: 404 }).send });
    expect(await fails(missing.list("acme/skills"))).toContain("was not found");
    const broken = makeGithubSkillSource({ fetch: github([], {}, {}, { repo: 500 }).send });
    expect(await fails(broken.list("acme/skills"))).toContain("500");
    const throwing = makeGithubSkillSource({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await fails(throwing.list("acme/skills"))).toBe("offline");
    const stringly = makeGithubSkillSource({
      fetch: (async () => {
        throw "boom";
      }) as unknown as typeof fetch,
    });
    expect(await fails(stringly.list("acme/skills"))).toBe("boom");
  });

  it("refuses a bad repo name, a truncated tree and a repo with no tree", async () => {
    expect(
      await fails(makeGithubSkillSource({ fetch: github([], {}).send }).list("../etc/passwd")),
    ).toContain("Bad repo");
    expect(
      await fails(
        makeGithubSkillSource({ fetch: github([], {}, {}, { truncated: true }).send }).list(
          "acme/skills",
        ),
      ),
    ).toContain("too large");
    const empty = makeGithubSkillSource({ fetch: github([], {}, {}, { tree: {} }).send });
    expect(await run(empty.list("acme/skills"))).toEqual([]);
  });

  it("lists a skill without a description when its SKILL.md can't be fetched", async () => {
    const gh = github(repoEntries, blobs, raw);
    const source = makeGithubSkillSource({
      fetch: ((input: string, init?: RequestInit) => {
        if (input.includes("raw.githubusercontent.com")) throw new Error("offline");
        return gh.send(input, init);
      }) as typeof fetch,
    });
    const found = await run(source.list("acme/skills"));
    expect(found.map((s) => [s.slug, s.name, s.description])).toEqual([
      ["tdd", "tdd", ""],
      ["review", "review", ""],
    ]);
  });

  it("copes with a missing description, equal-length folders, entries without a size and the global fetch", async () => {
    const entries: Entry[] = [
      { path: "s", type: "tree", sha: "ts" },
      { path: "s/bb", type: "tree", sha: "t-bb" },
      { path: "s/bb/SKILL.md", type: "blob", sha: "b1", mode: "100644" },
      { path: "s/aa", type: "tree", sha: "t-aa" },
      { path: "s/aa/SKILL.md", type: "blob", sha: "b2", mode: "100644" },
    ];
    const gh = github(entries, { b1: b64("# one"), b2: b64("# two") });
    const original = globalThis.fetch;
    globalThis.fetch = gh.send;
    try {
      // No `fetch` given: the global one is used. No raw SKILL.md answers: no description.
      const source = makeGithubSkillSource();
      const found = await run(source.list("a/b"));
      expect(found.map((f) => [f.slug, f.description])).toEqual([
        ["aa", ""],
        ["bb", ""],
      ]);
      const got = await run(source.fetch("a/b", "s/aa"));
      expect(got.files).toEqual([{ path: "SKILL.md", contents: "# two" }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("assumes main when GitHub names no default branch", async () => {
    const calls: string[] = [];
    const source = makeGithubSkillSource({
      fetch: (async (input: string) => {
        calls.push(input);
        return Response.json(input.includes("/git/trees/") ? { tree: [] } : {});
      }) as unknown as typeof fetch,
    });
    await run(source.list("acme/skills"));
    expect(calls.some((c) => c.includes("/git/trees/main"))).toBe(true);
  });

  it("won't fetch a folder that is missing, unsafe or has no SKILL.md", async () => {
    const source = makeGithubSkillSource({ fetch: github(repoEntries, blobs, raw).send });
    expect(await fails(source.fetch("acme/skills", "nope"))).toContain("no SKILL.md");
    expect(await fails(source.fetch("acme/skills", "../x"))).toContain("no SKILL.md");
    expect(await fails(source.fetch("acme/skills", "skills"))).toContain("no SKILL.md");
  });

  it("refuses a skill with too many files or too many bytes", async () => {
    const many: Entry[] = [
      { path: "s", type: "tree", sha: "ts" },
      { path: "s/SKILL.md", type: "blob", sha: "b0", mode: "100644", size: 1 },
      ...Array.from({ length: SKILL_LIMITS.maxFiles }, (_, i) => ({
        path: `s/f${i}.txt`,
        type: "blob" as const,
        sha: `b${i + 1}`,
        mode: "100644",
        size: 1,
      })),
    ];
    expect(
      await fails(makeGithubSkillSource({ fetch: github(many, {}).send }).fetch("a/b", "s")),
    ).toContain("more than");

    const heavy: Entry[] = [
      { path: "s", type: "tree", sha: "ts" },
      { path: "s/SKILL.md", type: "blob", sha: "h0", mode: "100644", size: 1 },
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `s/f${i}.txt`,
        type: "blob" as const,
        sha: `h${i + 1}`,
        mode: "100644",
        size: 1,
      })),
    ];
    const chunk = "a".repeat(SKILL_LIMITS.maxFileBytes);
    const blobMap = Object.fromEntries(
      ["h0", "h1", "h2", "h3", "h4", "h5"].map((k) => [k, b64(chunk)]),
    );
    expect(
      await fails(makeGithubSkillSource({ fetch: github(heavy, blobMap).send }).fetch("a/b", "s")),
    ).toContain("bigger than");
  });

  it("refuses a skill whose SKILL.md can't be read as text, or whose blobs fail", async () => {
    const entries: Entry[] = [
      { path: "s", type: "tree", sha: "ts" },
      { path: "s/SKILL.md", type: "blob", sha: "bin", mode: "100644", size: 4 },
    ];
    const binary = makeGithubSkillSource({
      fetch: github(entries, { bin: bytesB64([0xff, 0xfe]) }).send,
    });
    expect(await fails(binary.fetch("a/b", "s"))).toContain("no readable SKILL.md");
    const failing = makeGithubSkillSource({ fetch: github(entries, {}, {}, { blob: 500 }).send });
    expect(await fails(failing.fetch("a/b", "s"))).toContain("500");
    const notBase64 = makeGithubSkillSource({
      fetch: (async (input: string) => {
        const url = new URL(input);
        if (url.pathname.includes("/git/trees/")) return Response.json({ tree: entries });
        if (url.pathname.includes("/git/blobs/")) return Response.json({ encoding: "utf-8" });
        return Response.json({ default_branch: "main" });
      }) as unknown as typeof fetch,
    });
    expect(await fails(notBase64.fetch("a/b", "s"))).toContain("no readable SKILL.md");
  });
});
