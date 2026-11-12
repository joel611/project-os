import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { forwardCommand } from "../../../packages/channel-discord/src/commands.ts";
import { fakeCommand } from "../../../packages/channel-discord/src/fake.ts";
import { type Stack, startStack } from "./stack.ts";

// /source-add in a project channel -> adapter normalizes + forwards -> Coordinator /commands ->
// link detected like the dashboard -> source on the channel's project.

let stack: Stack;
let projectId: string;
beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request") });
  projectId = await stack.linkChannel("proj-chan");
});
afterEach(() => stack.stop());

const ada = { channelId: "proj-chan", userId: "u1", name: "Ada" };
const run = (options: Record<string, string>, speaker: Record<string, string> = ada) =>
  forwardCommand(
    stack.coordinator,
    fakeCommand(speaker as typeof ada, "source-add", options)!,
    fetch,
  );
const sources = async () =>
  ((await stack.json("GET", `/projects/${projectId}`)).sources as Array<Record<string, unknown>>)
    .filter((s) => s.type !== "discord_channel")
    .map(({ type, externalId, alias, description }) => ({ type, externalId, alias, description }));

describe("/source-add slash command", () => {
  it("links a GitHub repo, naming it after the repo", async () => {
    const reply = await run({ link: "https://github.com/Acme/Web-App/tree/main" });
    expect(reply).toEqual({
      content: expect.stringMatching(
        /^Linked GitHub repo <https:\/\/github.com\/acme\/web-app>.*`web-app`/,
      ),
      ephemeral: true,
    });
    expect(await sources()).toEqual([
      { type: "github_repo", externalId: "acme/web-app", alias: "web-app", description: null },
    ]);
  });

  it("links a Drive folder from a thread of the project channel, with alias and description", async () => {
    const reply = await run(
      {
        link: "https://drive.google.com/drive/folders/1AbCdEfGhIjK?usp=sharing",
        alias: "Design Docs",
        description: "Specs and mockups",
      },
      { ...ada, threadId: "th-1" },
    );
    expect(reply.content).toMatch(/^Linked Google Drive folder .*`design-docs`/);
    expect(await sources()).toEqual([
      {
        type: "google_drive_folder",
        externalId: "1AbCdEfGhIjK",
        alias: "design-docs",
        description: "Specs and mockups",
      },
    ]);
  });

  it("asks for an alias for a Drive folder, and rejects links it can't read", async () => {
    expect((await run({ link: "1AbCdEfGhIjK" })).content).toMatch(/give it an alias/);
    expect((await run({ link: "not a link" })).content).toMatch(
      /isn't a GitHub repo or Google Drive/,
    );
    expect(await sources()).toEqual([]);
  });

  it("refuses duplicates, taken aliases and channels that aren't a project's", async () => {
    await run({ link: "acme/web" });
    expect((await run({ link: "https://github.com/acme/web" })).content).toBe(
      "That GitHub repo is already linked to this project.",
    );
    await stack.linkChannel("other-chan");
    expect((await run({ link: "acme/web" }, { ...ada, channelId: "other-chan" })).content).toBe(
      "That GitHub repo is already linked to another project.",
    );
    expect((await run({ link: "other/web" })).content).toMatch(/already has a source called `web`/);
    expect((await run({ link: "acme/api", alias: "Not OK!" })).content).toMatch(/alias is/);
    expect(await run({ link: "acme/api" }, { ...ada, channelId: "random" })).toEqual({
      content: "/source-add only works in a project's channel.",
      ephemeral: true,
    });
    expect(await sources()).toEqual([
      { type: "github_repo", externalId: "acme/web", alias: "web", description: null },
    ]);
  });
});
