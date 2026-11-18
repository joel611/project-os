import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_NAMES,
  AGENTS,
  CODEX_TOKEN_ENV,
  claudeMcpConfig,
  isAgentName,
  MCP_SERVER_NAME,
} from "./agents.ts";
import type { WatcherConfig } from "./config.ts";

const config: WatcherConfig = {
  mcpUrl: "http://coord:8080/mcp",
  workerId: "w1",
  workerType: "local",
  agent: "claude",
  intervalMs: 1000,
  maxSessions: 1,
  cwd: "/work",
  secret: "s3cret",
  skills: true,
};
const ctx = { config, prompt: "do it", configDir: "/cfg", home: "/home/me" };

describe("agent registry", () => {
  it("has an implementation for every name, keyed by its own name", () => {
    for (const name of AGENT_NAMES) expect(AGENTS[name].name).toBe(name);
    expect(isAgentName("codex")).toBe(true);
    expect(isAgentName("gemini")).toBe(false);
  });

  it("keeps the secret out of every command line", () => {
    for (const name of AGENT_NAMES) {
      expect(AGENTS[name].launch(ctx).cmd.join(" ")).not.toContain("s3cret");
    }
  });
});

describe("claude", () => {
  const launch = AGENTS.claude.launch(ctx);

  it("runs headless with the prompt and an MCP config file", () => {
    expect(launch.cmd.slice(0, 5)).toEqual([
      "claude",
      "-p",
      "do it",
      "--mcp-config",
      "/cfg/mcp.json",
    ]);
    expect(launch.files.map((f) => f.path)).toEqual(["/cfg/mcp.json"]);
    expect(JSON.parse(launch.files[0]!.update(undefined))).toEqual(
      JSON.parse(claudeMcpConfig(config)),
    );
  });

  it("passes the configured model", () => {
    const withModel = AGENTS.claude.launch({ ...ctx, config: { ...config, model: "opus" } });
    expect(withModel.cmd.slice(-2)).toEqual(["--model", "opus"]);
  });

  it("pre-approves the coordinator MCP tools by the configured server name", () => {
    const i = launch.cmd.indexOf("--allowedTools");
    expect(launch.cmd[i + 1]).toBe(`mcp__${MCP_SERVER_NAME}__*`);
    expect(Object.keys(JSON.parse(claudeMcpConfig(config)).mcpServers)).toEqual([MCP_SERVER_NAME]);
  });

  it("sends the secret as a Bearer header", () => {
    expect(JSON.parse(claudeMcpConfig(config)).mcpServers[MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: config.mcpUrl,
      headers: { Authorization: "Bearer s3cret" },
    });
  });
});

describe("pi", () => {
  const launch = AGENTS.pi.launch({ ...ctx, config: { ...config, model: "openrouter/x" } });

  it("runs `pi --print` with the model and prompt", () => {
    expect(launch.cmd).toEqual(["pi", "--print", "--model", "openrouter/x", "do it"]);
    expect(AGENTS.pi.launch(ctx).cmd).toEqual(["pi", "--print", "do it"]);
  });

  it("declares the coordinator tools directly in ~/.pi/agent/mcp.json", () => {
    const [file] = launch.files;
    expect(file?.path).toBe("/home/me/.pi/agent/mcp.json");
    expect(JSON.parse(file!.update(undefined)).mcpServers[MCP_SERVER_NAME]).toEqual({
      url: config.mcpUrl,
      headers: { Authorization: "Bearer s3cret" },
      exposure: "direct",
    });
  });

  it("keeps the user's own Pi servers and settings when it adds the coordinator", () => {
    const existing = JSON.stringify({
      theme: "dark",
      mcpServers: { mine: { url: "http://mine" }, [MCP_SERVER_NAME]: { url: "http://stale" } },
    });
    const merged = JSON.parse(launch.files[0]!.update(existing));
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.mine).toEqual({ url: "http://mine" });
    expect(merged.mcpServers[MCP_SERVER_NAME].url).toBe(config.mcpUrl);
  });
});

describe("codex", () => {
  const launch = AGENTS.codex.launch({ ...ctx, config: { ...config, model: "gpt-5" } });

  it("runs `codex exec` unattended in the workspace sandbox, prompt last", () => {
    expect(launch.cmd.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(launch.cmd).toContain("workspace-write");
    expect(launch.cmd).toContain('approval_policy="never"');
    expect(launch.cmd.slice(-3)).toEqual(["--model", "gpt-5", "do it"]);
  });

  it("registers the coordinator via -c overrides and passes the token by env, not a file", () => {
    expect(launch.cmd).toContain(`mcp_servers.${MCP_SERVER_NAME}.url="http://coord:8080/mcp"`);
    expect(launch.cmd).toContain(
      `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var="${CODEX_TOKEN_ENV}"`,
    );
    expect(launch.env).toEqual({ [CODEX_TOKEN_ENV]: "s3cret" });
    expect(launch.files).toEqual([]);
  });
});

describe("skills", () => {
  const base = { ...ctx, prompt: "go" };
  const skills = { root: "/tmp/sk", slugs: ["tdd", "review"] };

  it("declares where each agent expects its skill folders", () => {
    expect(AGENTS.claude.skillsLayout).toBe(".claude/skills");
    expect(AGENTS.pi.skillsLayout).toBe("skills");
    // Codex can't load skills from outside its own config, so none are installed for it.
    expect(AGENTS.codex.skillsLayout).toBeUndefined();
  });

  it("gives Claude the session's skills folder as an added directory", () => {
    const cmd = AGENTS.claude.launch({ ...base, skills }).cmd;
    expect(cmd[cmd.indexOf("--add-dir") + 1]).toBe("/tmp/sk");
    expect(AGENTS.claude.launch({ ...base }).cmd).not.toContain("--add-dir");
  });

  it("gives Pi each skill folder, with the prompt still last", () => {
    const cmd = AGENTS.pi.launch({ ...base, config: { ...config, agent: "pi" }, skills }).cmd;
    expect(cmd).toEqual([
      "pi",
      "--print",
      "--skill",
      "/tmp/sk/skills/tdd",
      "--skill",
      "/tmp/sk/skills/review",
      "go",
    ]);
  });
});
