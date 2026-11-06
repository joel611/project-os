import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type Stack, startStack } from "./stack.ts";

// Source aliases end to end: the dashboard API (POST/PATCH sources) and the admin dialogue's
// actions name sources, and a Worker finds them by alias over MCP `project_sources_list`.

const WORKER = "w1";
let stack: Stack;

beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request"), workerId: WORKER });
});
afterEach(() => stack.stop());

const listSources = async (projectId: string) => {
  const mcp = await stack.worker();
  const res = (await mcp.callTool({ name: "project_sources_list", arguments: { projectId } })) as {
    isError?: boolean;
    structuredContent?: any;
  };
  expect(res.isError).toBeFalsy();
  return res.structuredContent.sources as Array<Record<string, unknown>>;
};

describe("project source aliases", () => {
  it("names sources from the dashboard and admin dialogue; Workers find them by alias", async () => {
    const projectId = await stack.linkChannel("chan-1");

    const drive = await stack.json("POST", `/projects/${projectId}/sources`, {
      type: "google_drive_folder",
      externalId: "1AbCdEfGhIjK",
      name: "Drive folder 1AbCdEfG…",
      alias: "Design Docs",
      description: "Specs and mockups for the redesign",
    });
    expect(drive).toMatchObject({ alias: "design-docs" });

    expect(
      await stack.json("POST", `/projects/${projectId}/sources`, {
        type: "github_repo",
        externalId: "acme/web",
        name: "acme/web",
        alias: "design-docs",
      }),
    ).toMatchObject({ error: "SourceAliasTaken" });

    expect(
      await stack.admin.addSource({
        projectId,
        type: "github_repo",
        externalId: "acme/web",
        alias: "site",
      }),
    ).toMatch(/as "site"/);
    expect(
      await stack.admin.updateSource({
        projectId,
        alias: "site",
        newAlias: "marketing-site",
        description: "The public website",
      }),
    ).toMatch(/marketing-site: github_repo acme\/web — The public website/);
    expect(await stack.admin.listSources({ projectId })).toMatch(/- design-docs: google_drive/);

    expect(await listSources(projectId)).toEqual([
      {
        alias: "chat",
        description: null,
        type: "discord_channel",
        externalId: "chan-1",
        name: "#chan-1",
        url: null,
      },
      {
        alias: "design-docs",
        description: "Specs and mockups for the redesign",
        type: "google_drive_folder",
        externalId: "1AbCdEfGhIjK",
        name: "Drive folder 1AbCdEfG…",
        url: "https://drive.google.com/drive/folders/1AbCdEfGhIjK",
      },
      {
        alias: "marketing-site",
        description: "The public website",
        type: "github_repo",
        externalId: "acme/web",
        name: "acme/web",
        url: "https://github.com/acme/web",
      },
    ]);

    const patched = await stack.json("PATCH", `/projects/${projectId}/sources/${drive.id}`, {
      description: null,
    });
    expect(patched).toMatchObject({ alias: "design-docs", description: null });
  });

  it("names the channel admin create_project makes after the channel", async () => {
    await stack.admin.createProject({ name: "Acme Site" });
    const [project] = await stack.json("GET", "/projects");
    expect((await listSources(project.id)).map((s) => s.alias)).toEqual(["acme-site"]);
  });
});
