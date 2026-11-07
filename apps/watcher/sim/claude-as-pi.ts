#!/usr/bin/env bun
// Installed as `claude` in the watcher VM image so the Watcher's session runs on Pi instead.
// Takes the argv spawn.ts's claudeArgs builds: claude -p <prompt> --mcp-config <file> --allowedTools <glob>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const after = (flag: string) => argv[argv.indexOf(flag) + 1];
const prompt = after("-p");
const mcpConfigFile = after("--mcp-config");
if (!prompt || !mcpConfigFile) {
  console.error("claude-as-pi: expected -p <prompt> --mcp-config <file>");
  process.exit(2);
}

const { mcpServers } = JSON.parse(readFileSync(mcpConfigFile, "utf8")) as {
  mcpServers: Record<string, { url: string; headers?: Record<string, string> }>;
};
const piServers = Object.fromEntries(
  Object.entries(mcpServers).map(([name, { url, headers }]) => [
    name,
    // `direct` declares the tools to the model; the default hides them behind codemode.
    { url, ...(headers && { headers }), exposure: "direct" },
  ]),
);
const agentDir = join(homedir(), ".pi", "agent");
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: piServers }), {
  mode: 0o600,
});

const model = process.env.PI_MODEL ?? "openrouter/anthropic/claude-sonnet-4.5";
const proc = Bun.spawn(["pi", "--print", "--model", model, prompt], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
