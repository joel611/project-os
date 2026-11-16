# Sandbox Workers reach connected accounts through a credential proxy (opt-in)

Status: accepted, behind `SANDBOX_CREDENTIAL_PROXY` (off by default)

## Context

Per-person account linking (PR #41) handed Workers the requester's OAuth token through the `user_token` MCP tool, with no proxy tools. The token comes back as a tool result, so it sits in the model's context, is sent to the model provider on every later turn, and is typed into shell commands by the model. A prompt injection in a Drive doc, issue or ClickUp task can ask the model to send it anywhere. The Sidekick already avoids this: its tools add the token in code.

## Decision

The Coordinator serves `/egress/<service>/<path>` beside `/mcp`. A sandbox session authenticates with its own per-ticket MCP token, the Coordinator resolves the session's ticket, fetches the requester's token the way `user_token` does, and forwards the call with that token in place of the session's. Services are a fixed allowlist: `github` (api.github.com), `github-git` (github.com, Basic `x-access-token`), `google` (www.googleapis.com) and `clickup` (api.clickup.com). Same-provider redirects are rewritten to stay on the proxy.

While it is on, sandbox sessions do not see `user_token`, get `PROJECT_OS_EGRESS_URL` and `PROJECT_OS_EGRESS_TOKEN` in their env, a prompt that sends them through the proxy, and a git config that routes `https://github.com/` through it. Watcher devices keep `user_token`: they run on the person's own machine.

## Consequences

- The person's token never reaches the sandbox. What the sandbox holds is its MCP token: one ticket, expiring with the session.
- `gh` can't be pointed at a path prefix, so proxied sessions use `curl` and git.
- Every provider call costs a hop through the Coordinator.
- The sandbox still holds `OPENROUTER_API_KEY`. Fronting the model provider the same way is a follow-up.
