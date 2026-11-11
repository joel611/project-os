# Coordinator comments that claim outside rules: keep, delete, or encode

Checked against the versions this repo resolves: elysia 1.4.30, @modelcontextprotocol/sdk 1.32.2, @earendil-works/pi-durable 1.5.0, @opentelemetry/sdk-trace-base 2.12.0, sdk-metrics 3.0.0, resources 3.0.0, exporter-*-otlp-http 0.300.0, typescript 7.0.2 (+ @effect/tsgo 0.67.7), Workers `COMPATIBILITY_DATE` 2026-10-01 (`alchemy.run.ts:21`). Dependency paths are under `apps/coordinator/node_modules/` or `node_modules/.bun/`.

## Summary

| # | Claim (file) | Verdict | Primary source | Recommendation |
|---|---|---|---|---|
| 1 | `buildApp` must run at module load; Elysia `.compile()` uses `new Function`, workerd allows it only before the first request; no I/O (main.cloudflare.ts) | TRUE (docs say "startup phase"; Elysia uses `Function(...)`, same rule) | Cloudflare compat flag `allow_eval_during_startup`; elysia `dist/compose.mjs`, `dist/index.mjs` | Keep, shortened. A workerd e2e test already guards it |
| 2 | `waitUntil` keeps the Worker alive for the session; Workers cap that time; see Known gaps (held-open.ts) | TRUE; the reference exists and agrees (30 s) | Cloudflare `ctx.waitUntil` docs; `docs/deployment.md:73,79` | Keep; add the number so it does not depend on the pointer |
| 3 | Pi storage must live in a SQLite-backed Durable Object, one `PiAgent` per session (pi-agent.ts) | PARTLY TRUE: "must" is overstated, Pi has other backends; "one owner per storage" is true | pi-durable `README.md:856-858, 881` | Encode then delete (imports and `getByName(sessionId)` already say it); optionally keep one clause on single ownership |
| 4 | Exporters read `OTEL_EXPORTER_OTLP_*`; service name from `OTEL_SERVICE_NAME`, the SDK does not read it (telemetry.ts) | TRUE for how this code builds providers; exporters read `process.env`, not the `env` argument | otlp-exporter-base env configuration; resources `EnvDetector.mjs` | Keep the first sentence; delete the parenthetical (the `??` line shows it) |
| 5 | Non-streaming (JSON) responses are complete once `handleRequest` resolves (mcp/server.ts) | TRUE for a POST carrying requests; not for GET (always SSE) or a notification-only POST (202) | MCP SDK `webStandardStreamableHttp.js:590-613, 931-941` | Keep, reworded to say why closing in `finally` is safe |
| 6 | Explicit return type needed because `runtime` is defined below (main.bun.ts) | FALSE at TS 7.0.2: removing the annotation gives no error | scratch `tsc -p apps/coordinator --noEmit`, 0 errors (control error did fire) | Delete the comment (the annotation is harmless) |
| 7 | 303: browser follows a POST's redirect with a GET (connect/routes.ts) | TRUE | RFC 9110 §15.4.4; Fetch Standard HTTP-redirect fetch | Delete: `status: 303` is the encoding and its meaning is standard |
| 8 | Script reads answers from the terminal, not stdin, because stdin is the curl pipe (watcher-install.ts) | TRUE | POSIX `sh` (`-s`, stdin sharing); POSIX `/dev/tty`; the script's own code | Keep the first sentence; delete the fd 3 and stderr sentences (visible in code) |

## Evidence

### 1. buildApp at module load

Current text: "Builds the app from the Worker's bindings. This must run at module load: Elysia's `.compile()` uses `new Function`, which workerd allows only before the first request. Nothing here does I/O; the layers build lazily on the first `runPromise`."

- Elysia: `compile()` calls the adapter's `beforeCompile`, which runs `route.compile()` for every route, then `composeGeneralHandler(this)` (`elysia/dist/index.mjs:1851`; `dist/adapter/cloudflare-worker/index.mjs`, `beforeCompile`). The composers build handlers with `Function(...)` (`dist/compose.mjs:231, 988, 1183, 1310`), which is the same code-generation-from-strings rule as `new Function`. AOT is on by default (`index.mjs:195`).
- workerd: compatibility flag `allow_eval_during_startup` (default as of 2025-06-01): "Workers can use `eval()` and `new Function(text)` during the startup phase"; with `disallow_eval_during_startup` it throws. Source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ (fetched with ctx7, library `/llmstxt/developers_cloudflare_workers_llms-full_txt`). This repo's date is 2026-10-01, so startup eval is on. The docs say "startup phase", not "before the first request"; for module-level code they coincide.
- "No I/O": Cloudflare Bindings docs: "I/O operations cannot be performed outside of a request context" (https://developers.cloudflare.com/workers/runtime-apis/bindings/). `ManagedRuntime.make` is lazy, so the claim holds; `docs/deployment.md:76` makes the same point for admin seeding.
- Already stated elsewhere: `docs/technical-architecture.md:861` ("needs `.compile()` and `compatibility_date >= 2025-06-01`"). In code, `const built = buildApp(workerEnv)` at module scope is visible, but why it must stay there is not. `apps/e2e/src/coordinator-workers-auth.test.ts` boots the Worker in workerd, so moving the build into a request would fail there.
- Recommendation: keep, e.g. "Module-load only: `.compile()` generates code with `Function`, which workerd allows only during startup. No I/O here."

### 2. heldOpen and waitUntil

- Cloudflare: "`ctx.waitUntil()` can extend execution for up to 30 seconds after the response is sent or the client disconnects ... shared across all `waitUntil()` calls within the same request. If any Promises have not settled after 30 seconds, they are canceled." https://developers.cloudflare.com/workers/runtime-apis/context/ and https://developers.cloudflare.com/workers/platform/limits/ (via ctx7).
- Repo reference: `docs/deployment.md:73` is "## Known gaps"; line 79 says "A deployed Worker caps `waitUntil` time, so a long session is cut off there". It exists and agrees.
- A platform limit, so not expressible in code. Keep. If the heading is renamed the pointer rots, so state the number: "capped at 30 s after the response".

### 3. Pi Durable on Workers

- pi-durable README storage table (`README.md:858`): "Cloudflare Durable Object | `openDurableObjectSqliteStorage(ctx.storage)` | The SQLite storage of one SQLite-backed Durable Object". Line 881: "One process owns a storage at a time; there is no cross-process locking."
- Other backends exist (memory, IndexedDB, JSONL, a portable SQLite core over an async facade; `README.md:845-883`). So "must" is not a Pi rule; it is the repo's choice, and the DO adapter is the supported persistent one on Workers. One `PiAgent` per session follows from the single-owner rule plus our design (`pi-agent.ts:109` `agents.getByName(input.sessionId)`; `alchemy.run.ts:306-311`).
- Encoding: `openDurableObjectSqliteStorage(ctx.storage)` and `extends DurableObject` already say "SQLite DO"; session id shapes are in `docs/deployment.md:78`. Delete, or reduce to "One storage owner per session, so one PiAgent each."

### 4. Telemetry env

Current text: "The exporters read the standard `OTEL_EXPORTER_OTLP_*` variables (endpoint, headers, timeouts). The service name comes from `OTEL_SERVICE_NAME` (the SDK does not read it itself), default `project-os-coordinator`."

- Exporters: `@opentelemetry/otlp-exporter-base@0.300.0/dist/platform/node/configuration/otlp-node-http-env-configuration.mjs:10-11, 43-48` (headers, endpoint, per-signal variants) and `dist/configuration/shared-env-configuration.mjs:5-13` (timeout, compression). They read `process.env` through `getStringFromEnv`, not the `env` parameter of `setupTelemetry`. Production passes `process.env` (`main.bun.ts`), tests pass a fake, so in a test the endpoint gate and the exporter can disagree.
- Service name: `@opentelemetry/resources@3.0.0/dist/detectors/EnvDetector.mjs:23,30` reads `OTEL_SERVICE_NAME`, but only when a detector runs. Both providers here get an explicit `resource` from `resourceFromAttributes`; `MeterProvider` uses `defaultResource()` only when none is given (`sdk-metrics@3.0.0/dist/MeterProvider.mjs:15`). `sdk-node` reads the variable itself (`create-from-config.mjs:186`) and is not used. So the parenthetical holds for these classes; "SDK" is ambiguous, since the OpenTelemetry spec lists the variable as an SDK one.
- Encoding: the `?? "project-os-coordinator"` line already shows where the name comes from. The exporter env behaviour is invisible in code, so keep that half.

### 5. MCP JSON responses

- `webStandardStreamableHttp.js:590-613`: with `enableJsonResponse`, `handlePostRequest` returns a Promise that resolves when `send` calls `resolveJson` (`931-941`) once all related responses are ready; the `Response` is whole.
- Caveats: a POST holding only notifications or responses returns 202 at once (`~575-578`); a GET opens a standalone SSE stream whatever `enableJsonResponse` says (`~225-300`), so `server.close()` in `finally` would end that stream. The route is `.all("/mcp")`, so GET is reachable. Stateless, a GET stream has no use, so the close is harmless.
- SDK behaviour, not expressible in code. Keep, reworded to say what it justifies: closing in `finally` cannot truncate a JSON response.

### 6. runAdmin explicit return type

- Scratch test: removed `: Promise<A>` from `runAdmin` in `apps/coordinator/src/main.bun.ts` and ran `bunx tsc -p apps/coordinator --noEmit` (TypeScript 7.0.2 with effect-tsgo 0.67.7): no errors. Control: appending `const zz: number = "x"` produced `TS2322`, so the check was live; same result with the root `tsc -p tsconfig.json`. File restored; `git status` clean.
- `runtime` is read only inside the function body and the function's type does not feed `runtime`'s initializer circularly, so no TS7022/TS7023. `main.cloudflare.ts` has the same function with `runtime` defined above and no comment.
- FALSE for this repo and toolchain. Delete the comment (the annotation may stay).

### 7. 303 on the connect POST

- RFC 9110 §15.4.4: 303 "is primarily used to allow the output of a POST action to redirect the user agent to a different resource"; "A user agent can perform a retrieval request targeting that URI (a GET or HEAD request if using HTTP)". https://www.rfc-editor.org/rfc/rfc9110#section-15.4.4. The RFC says "can"; the binding browser behaviour is in the Fetch Standard, HTTP-redirect fetch: status 303 and method not GET or HEAD, then the method becomes GET and the body is dropped. https://fetch.spec.whatwg.org/#http-redirect-fetch
- Code: `connect/routes.ts:78-79`, `status: 303`. The number is the encoding; the comment restates its meaning. Delete.

### 8. Install script stdin

- POSIX `sh` (https://pubs.opengroup.org/onlinepubs/9799919799/utilities/sh.html): `-s` "Read commands from the standard input", assumed with no operands; when the shell reads stdin and runs a command that also reads stdin, the shell leaves the pointer directly after the command it read. So an unredirected `read` would swallow the next script lines. The repo's usage is `curl ... | sh -s -- <code>` (`watcher-install.ts:30`).
- `/dev/tty`: POSIX base definitions ch. 10 (https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap10.html): "a synonym for the controlling terminal ... reading data from the terminal no matter how output has been redirected". Script: `tty=${PROJECT_OS_INSTALL_TTY:-/dev/tty}`, `if (: <"$tty") 2>/dev/null; then exec 3<"$tty"; asking=1; fi`, `read -r reply <&3` (`watcher-install.ts:36-43`). The probe covers no controlling terminal (CI, some ssh); `can_ask` is then false.
- Tests in `watcher-install.test.ts` set `PROJECT_OS_INSTALL_TTY` to a file or a missing path, covering the ask and no-terminal paths.
- Residual: `bun install -g` and the final `exec project-os-watcher` still inherit stdin (the pipe). Not a bug today; a child that read stdin would eat script text.
- Keep the first sentence. The fd 3 and "prompts go to stderr" sentences describe visible code (`exec 3<`, `>&2`).
