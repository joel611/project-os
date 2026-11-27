# Cloud sandbox

Tickets that no personal or shared computer takes ([registered workers](local.md)) can run in a cloud sandbox: the Coordinator starts a fresh sandbox per ticket, runs a Pi session in it under its own worker id (`daytona-<ticketId>`, `cloudflare-<ticketId>` or `boat-<ticketId>`), and deletes the sandbox when the session ends. No Watcher ever sees these tickets.

You choose the providers. Each one joins the **pool** when its credentials are set, and `WORKER_PROVIDERS` sets which ones and in what order:

```sh
# Try Cloudflare first, then Daytona, then boat.dev. Unset: every configured provider,
# in the order daytona, cloudflare, boat.
WORKER_PROVIDERS=cloudflare,daytona,boat

# Required with any provider: the Coordinator's /mcp as the sandbox's cloud sees it
# (a tunnel such as https://abc.trycloudflare.com/mcp, never localhost).
SANDBOX_MCP_URL=https://coordinator.example.com/mcp
# Optional: Pi model (provider/model, default DEFAULT_MODEL) and session limit (default 1800 s).
SANDBOX_PI_MODEL=
SANDBOX_SESSION_TIMEOUT_SECONDS=
```

When the Coordinator assigns a ticket, it reads the pool and starts the first provider with room. Room means fewer active tickets on it than its `*_MAX_CONCURRENT` (no cap if unset). If every provider is full, or the pool is empty, the ticket is queued until something has room. Which sandbox runs a ticket is always the pool's call. Worker ids are `<provider>-<id>`. Naming one that isn't configured, or an unknown name, stops the Coordinator at startup so a typo can't silently leave tickets queued.

| Provider           | `WORKER_PROVIDERS` name | Worker type     | Status    | Settings                                                                                           |
| ------------------ | ----------------------- | --------------- | --------- | -------------------------------------------------------------------------------------------------- |
| Daytona            | `daytona`               | `daytona_pi`    | Paused    | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL`, `DAYTONA_SNAPSHOT`, `DAYTONA_MAX_CONCURRENT`        |
| Cloudflare Sandbox | `cloudflare`            | `cloudflare_pi` | Supported | `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_TOKEN`, optional `CLOUDFLARE_SANDBOX_MAX_CONCURRENT` |
| boat.dev           | `boat`                  | `boat_pi`       | Supported | `BOAT_API_KEY`, optional `BOAT_API_URL`, `BOAT_SANDBOX_SIZE`, `BOAT_MAX_CONCURRENT`                |

The older `DAYTONA_MCP_URL`, `DAYTONA_PI_MODEL` and `DAYTONA_SESSION_TIMEOUT_SECONDS` still work as fallbacks for the `SANDBOX_*` names.

## Credential proxy

By default a sandbox session gets the requester's Google, GitHub or ClickUp token from `user_token`, so the token ends up in the model's context and is sent to the model provider. Set `SANDBOX_CREDENTIAL_PROXY=true` to keep it on the Coordinator instead:

```sh
SANDBOX_CREDENTIAL_PROXY=true
# Optional: where sandboxes reach the proxy. Default: SANDBOX_MCP_URL with /mcp swapped for /egress.
SANDBOX_EGRESS_URL=
```

With it on, the Coordinator serves `/egress/<service>/<path>` beside `/mcp`. A sandbox calls it with its own MCP token, and the Coordinator forwards the call with the requester's token in its place: `github` goes to api.github.com, `github-git` to github.com (git over HTTPS), `google` to www.googleapis.com and `clickup` to api.clickup.com. Sandbox sessions no longer see `user_token`, their prompt tells them to use `$PROJECT_OS_EGRESS_URL`, and git is set up so clones and pushes of `https://github.com/` repos go through the proxy. `gh` doesn't work this way, so sessions use `curl` for the API. Watcher devices keep `user_token` either way.

## Daytona

**Paused.** The code stays and works up to launching the sandbox, but a sandbox can only reach the Coordinator's public `/mcp` URL on Daytona's Tier 3, which is too costly for now. On a lower tier Pi installs and runs but never connects, and the ticket stays `assigned`. We are not investing further until that changes; use a registered device, Cloudflare Sandbox or boat.dev instead.

1. Create an API key at [app.daytona.io](https://app.daytona.io) and set `DAYTONA_API_KEY`.
2. Optional: `DAYTONA_SNAPSHOT` for a snapshot with Node 22.19 or newer (Pi installs itself at session start).

## boat.dev

1. Create an API key (`boat api-key create project-os --preset ci`, or in the dashboard) and set `BOAT_API_KEY` (keys start with `boat_`).
2. Optional: `BOAT_SANDBOX_SIZE` (`small`, `default`, `large`, `xlarge`; `xlarge` needs a $100 plan or higher) and `BOAT_MAX_CONCURRENT`. Set the cap at or below your plan's sandboxes-at-once limit (100 on the $20 plan), so the pool moves on instead of failing.
3. Each ticket gets its own sandbox, created with the session's settings as sandbox env vars and deleted when the session ends. The TTL is the session limit plus 5 minutes, which reclaims it even if the Coordinator stops first. Sandboxes bill per second while they run.

## Cloudflare Sandbox

Cloudflare Sandboxes are Durable Objects backed by Containers, reachable only from a Worker binding. So you deploy a small bridge Worker (`apps/cloudflare-sandbox`) and the Coordinator talks to it over HTTPS with a shared token.

1. Use a Cloudflare account on the Workers Paid plan (Containers need it), and have Docker running locally (the deploy builds the sandbox image).
2. Deploy the bridge and give it a token:

   ```sh
   bun run --cwd apps/cloudflare-sandbox deploy
   openssl rand -hex 32   # the token
   bunx wrangler@4.153.0 secret put BRIDGE_TOKEN --cwd apps/cloudflare-sandbox
   ```

3. In the Coordinator `.env`, set `CLOUDFLARE_SANDBOX_URL` to the Worker's URL (`https://project-os-sandbox.<subdomain>.workers.dev`) and `CLOUDFLARE_SANDBOX_TOKEN` to the same token.
4. Optional: raise `containers[0].max_instances` in `apps/cloudflare-sandbox/wrangler.jsonc` and set `CLOUDFLARE_SANDBOX_MAX_CONCURRENT` to match, so the pool moves on to the next provider instead of waiting for a container.

The sandbox image is Cloudflare's base image (`docker.io/cloudflare/sandbox`, with Node and npm). A sandbox goes to sleep after 10 idle minutes, so one is reclaimed even if the Coordinator stops before deleting it.
