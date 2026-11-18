import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntentClassifier, type SkillBundle } from "@project-os/core";
import { makeSkillSourceFake } from "@project-os/testing";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fakeInbound } from "../../../packages/channel-discord/src/fake.ts";
import { forwardInbound } from "../../../packages/channel-discord/src/forward.ts";
import { loadConfig } from "../../watcher/src/config.ts";
import { httpMcpClient } from "../../watcher/src/mcp-client.ts";
import { createWatcher } from "../../watcher/src/poll.ts";
import { bunSpawner } from "../../watcher/src/spawn.ts";
import { type Stack, startStack } from "./stack.ts";

// Skill sets, end to end: an Operator builds "development" in the dashboard API (browse a repo,
// pick a skill), Jev routes a Discord request to it, and the skills reach the Worker before the
// ticket starts: a sandbox session fetches them with its own token, a Watcher writes them to a
// private folder for the session and removes it afterwards. GitHub is a fake repo.

const CHANNEL = "chan-1";
const md = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`;

const newUpstream = () =>
  makeSkillSourceFake({
    "acme/skills": [
      {
        path: "skills/tdd",
        sha: "tree-1",
        files: [
          { path: "SKILL.md", contents: md("tdd", "Test first") },
          { path: "examples/a.ts", contents: "export {}" },
        ],
      },
      {
        path: "skills/docs",
        sha: "tree-2",
        files: [{ path: "SKILL.md", contents: md("docs", "d") }],
      },
    ],
  });
let upstream = newUpstream();

/** Jev picks the set named "development" for anything about code, and none otherwise. */
const jev = Layer.succeed(IntentClassifier, {
  classify: ({ content, skillSets = [] }) =>
    Effect.succeed({
      intent: "new_request",
      confidence: 1,
      ...(skillSets.length > 0 && {
        skillSet: {
          choice: content.includes("code")
            ? (skillSets.find((s) => s.name === "development")?.id ?? "none")
            : "none",
          confidence: 0.95,
        },
      }),
    }),
});

let stack: Stack;
let launched: Array<{ ticketId: string; workerId: string; mcpToken: string }>;
const dirs: string[] = [];

beforeEach(async () => {
  launched = [];
  upstream = newUpstream();
  stack = await startStack({
    classifier: jev,
    skillSource: upstream.service,
    workerLauncher: {
      pool: Effect.succeed([{ workerType: "daytona_pi" }]),
      launch: (input) => Effect.sync(() => void launched.push(input)),
    },
    sharedWorkerMaxTickets: 5,
  });
  await stack.linkChannel(CHANNEL);
});
afterEach(async () => {
  await stack.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const say = (content: string) =>
  forwardInbound(
    stack.coordinator,
    fakeInbound({ channelId: CHANNEL, userId: "u-ada", name: "Ada" }, content)!,
    fetch,
  );

const buildDevelopmentSet = async () => {
  const set = await stack.json("POST", "/skill-sets", {
    name: "development",
    description: "Writing, fixing and reviewing code",
  });
  const found = await stack.json("POST", "/skill-sets/browse", {
    source: "https://skills.sh/acme/skills",
  });
  expect(found.skills.map((s: { slug: string }) => s.slug).sort()).toEqual(["docs", "tdd"]);
  const added = await stack.json("POST", `/skill-sets/${set.id}/skills`, {
    source: "acme/skills",
    slugs: ["tdd"],
  });
  return { set, skill: added.skills[0] };
};

const projectTickets = async () => {
  const [project] = await stack.json("GET", "/projects");
  return (await stack.json("GET", `/projects/${project.id}/tickets`)) as any[];
};

const bundleFor = (ticketId: string, token: string) =>
  fetch(`${stack.url}/tickets/${ticketId}/skills`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe("skill sets", () => {
  it("routes a code request to its set, and a sandbox session fetches the pinned skills", async () => {
    const { set } = await buildDevelopmentSet();
    await say("please fix the login code");
    await say("write the release announcement");
    const [code, other] = ((await projectTickets()) as any[]).sort((a, b) =>
      a.inputSummary.includes("code") ? -1 : b.inputSummary.includes("code") ? 1 : 0,
    );
    expect(code.skillSetId).toBe(set.id);
    expect(other.skillSetId).toBeNull();

    const session = launched.find((l) => l.ticketId === code.id)!;
    const res = await bundleFor(code.id, session.mcpToken);
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as SkillBundle;
    expect(bundle.set).toEqual({ id: set.id, name: "development" });
    expect(bundle.skills).toEqual([
      {
        slug: "tdd",
        name: "tdd",
        files: [
          { path: "SKILL.md", contents: md("tdd", "Test first") },
          { path: "examples/a.ts", contents: "export {}" },
        ],
      },
    ]);

    // The other ticket's session gets nothing, and can't read this one's.
    const otherSession = launched.find((l) => l.ticketId === other.id)!;
    expect(await (await bundleFor(other.id, otherSession.mcpToken)).json()).toEqual({
      set: null,
      skills: [],
    });
    expect((await bundleFor(code.id, otherSession.mcpToken)).status).toBe(403);
    expect((await bundleFor(code.id, "nope")).status).toBe(401);
  });

  it("keeps a ticket on the version it was routed with until an Operator updates the skill", async () => {
    const { set, skill } = await buildDevelopmentSet();
    await say("fix the code");
    const [ticket] = await projectTickets();
    const token = launched[0]!.mcpToken;

    upstream.publish("acme/skills", {
      path: "skills/tdd",
      sha: "tree-9",
      files: [{ path: "SKILL.md", contents: md("tdd", "Test first, v2") }],
    });
    const before = (await (await bundleFor(ticket.id, token)).json()) as SkillBundle;
    expect(before.skills[0]!.files).toHaveLength(2);

    const report = await stack.json("GET", `/skill-sets/${set.id}/updates`);
    expect(report.statuses[0]).toMatchObject({ skillId: skill.id, state: "update_available" });
    await stack.json("POST", `/skill-sets/${set.id}/update`, {});
    const after = (await (await bundleFor(ticket.id, token)).json()) as SkillBundle;
    expect(after.skills[0]!.files).toEqual([
      { path: "SKILL.md", contents: md("tdd", "Test first, v2") },
    ]);
  });

  it("writes the set into a private folder for a Watcher's session, then removes it", async () => {
    await buildDevelopmentSet();
    const { workerId, secret } = await stack.registerSharedWorker();
    await say("fix the code");

    const config = loadConfig({ server: stack.url, workerId, name: "box", secret }, () => true);
    const logs: string[] = [];
    const seen: Array<{ cmd: string[]; skills: Record<string, string>; existed: boolean }> = [];
    let root = "";
    const spawner = bunSpawner(
      config,
      (cmd) => {
        const folder = cmd[cmd.indexOf("--add-dir") + 1]!;
        const skills = join(folder, ".claude", "skills", "tdd");
        seen.push({
          cmd,
          existed: existsSync(skills),
          skills: Object.fromEntries(
            ["SKILL.md", "examples/a.ts"].map((f) => [f, readFileSync(join(skills, f), "utf8")]),
          ),
        });
        root = folder;
        return { exited: Promise.resolve(0) };
      },
      {
        readFile: () => undefined,
        writePrivate: () => {},
        env: {},
        configDir: tmpdir(),
        home: tmpdir(),
        skills: {
          fetchBundle: async (url, token) => {
            const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
            return res.ok ? ((await res.json()) as SkillBundle) : undefined;
          },
          makeDir: () => {
            const d = mkdtempSync(join(tmpdir(), "e2e-skills-"));
            dirs.push(d);
            return d;
          },
          writeFile: (path, contents) => {
            mkdirSync(join(path, ".."), { recursive: true });
            writeFileSync(path, contents);
          },
          removeDir: (d) => rmSync(d, { recursive: true, force: true }),
        },
      },
    );
    const watcher = createWatcher({
      config,
      client: httpMcpClient(config.mcpUrl, fetch, config.secret),
      spawner,
      log: (m) => logs.push(m),
    });
    await watcher.pollOnce();
    await new Promise((r) => setTimeout(r, 50));

    expect(logs.at(-1)).toBe("session exit code=0 (0/1)");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.skills).toEqual({
      "SKILL.md": md("tdd", "Test first"),
      "examples/a.ts": "export {}",
    });
    // The prompt names the one ticket this session is for.
    const [ticket] = await projectTickets();
    expect(seen[0]!.cmd[2]).toContain(`This session is for ticket \`${ticket.id}\``);
    // The folder is gone once the session ends.
    expect(existsSync(root)).toBe(false);
    expect(readdirSync(tmpdir()).some((n) => n === root.split("/").pop())).toBe(false);
  });

  it("answers an Operator's mistakes with the right errors", async () => {
    await stack.json("POST", "/skill-sets", { name: "development" });
    expect(await stack.json("POST", "/skill-sets", { name: "development" })).toMatchObject({
      error: "SkillSetNameTaken",
    });
    expect(await stack.json("POST", "/skill-sets", { name: "none" })).toMatchObject({
      error: "InvalidSkillSet",
    });
    expect(
      await stack.json("POST", "/skill-sets/browse", { source: "acme/missing" }),
    ).toMatchObject({
      error: "SkillFetchFailed",
    });
  });
});
