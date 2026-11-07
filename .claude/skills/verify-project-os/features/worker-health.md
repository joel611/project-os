# Worker health

## Sub-features

- Heartbeat marks a worker `online` (`GET /workers`)
- Sidebar Workers panel, grouped "Shared pool" / "Personal" / "Sandbox sessions": name, online/offline, "seen <age>" (or "never"), "· working" with a current ticket, and the owner on personal devices
- Goes `offline` once `lastSeenAt` exceeds the stale window (`healthConfig().workerStaleMs`)

## How to get to it (user POV)

Dashboard sidebar → Workers.

## Driving it with the harness

1. Fresh stack: sidebar shows "Shared pool" → `verify-box` `offline · seen never` and "Personal" → `bob-laptop` `offline · seen never`, `discord user u9`. `curl -s localhost:18080/workers` → both, `registered:true`.
2. `bun verify/drive.ts heartbeat` → `curl …/workers` → `verify-box` `status:"online"`.
3. Dashboard: `wait 6000` · `snapshot` → `verify-box`, `online · seen just now`. Screenshot.

Proves it: API status and sidebar agree.

## Gotchas

- Offline transition is not exercised: the default stale window is long, and `run.sh` does not pass a smaller one. Read `libs/config/src/health.ts` for the env var, then start with it set.
- `drive.ts work` does not heartbeat; only `heartbeat` does.
- A fresh `up` has exactly the two seeded workers; more means a previous run's data leaked.
