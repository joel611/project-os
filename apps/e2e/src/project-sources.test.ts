import { classifierReturning } from "@project-os/testing";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type Stack, startStack } from "./stack.ts";

// Source aliases end to end: the dashboard API (POST/PATCH/DELETE sources) and the admin dialogue's
// actions name sources, and a Worker finds them by alias over MCP `project_sources_list`.

/** The shared worker an admin registered; set once the stack is up. */
let SECRET: string;
let stack: Stack;

beforeEach(async () => {
  stack = await startStack({ classifier: classifierReturning("new_request") });
  ({ secret: SECRET } = await stack.registerSharedWorker());
});
afterEach(() => stack.stop());

const listSources = async (projectId: string) => {
  const mcp = await stack.worker(SECRET);
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

  it("removes a source from the dashboard: Workers stop seeing it and it can be linked again", async () => {
    const projectId = await stack.linkChannel("chan-1");
    const repo = await stack.json("POST", `/projects/${projectId}/sources`, {
      type: "github_repo",
      externalId: "acme/web",
      name: "acme/web",
      alias: "web",
    });

    expect(await stack.json("DELETE", `/projects/${projectId}/sources/${repo.id}`)).toMatchObject({
      id: repo.id,
      alias: "web",
    });
    expect(await stack.json("DELETE", `/projects/${projectId}/sources/${repo.id}`)).toMatchObject({
      error: "SourceNotFound",
    });
    expect((await listSources(projectId)).map((s) => s.alias)).toEqual(["chat"]);

    const anonymous = await fetch(`${stack.url}/projects/${projectId}/sources/${repo.id}`, {
      method: "DELETE",
    });
    expect(anonymous.status).toBe(401);

    expect(
      await stack.json("POST", `/projects/${projectId}/sources`, {
        type: "github_repo",
        externalId: "acme/web",
        name: "acme/web",
        alias: "web",
      }),
    ).toMatchObject({ alias: "web" });
  });

  it("names the channel admin create_project makes after the channel", async () => {
    await stack.admin.createProject({ name: "Acme Site" });
    const [project] = await stack.json("GET", "/projects");
    expect((await listSources(project.id)).map((s) => s.alias)).toEqual(["acme-site"]);
  });
});
