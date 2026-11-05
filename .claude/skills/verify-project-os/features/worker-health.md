# Worker health

## Sub-features

- Heartbeat registers a worker and marks it `online` (`GET /workers`)
- Sidebar Workers panel: id, online/offline, "seen <age>", "· working" with a current ticket
- Goes `offline` once `lastSeenAt` exceeds the stale window (`healthConfig().workerStaleMs`)

## How to get to it (user POV)

Dashboard sidebar → Workers.

## Driving it with the harness

1. Fresh stack: sidebar says "No worker has checked in." and `curl -s localhost:18080/workers` → `[]`.
2. `bun verify/drive.ts heartbeat` → `curl …/workers` → `status:"online"`.
3. Dashboard: `wait 6000` · `snapshot` → `verify-worker`, `online · seen just now`. Screenshot.

Proves it: API status and sidebar agree.

## Gotchas

- Offline transition is not exercised: the default stale window is long, and `run.sh` does not pass a smaller one. Read `libs/config/src/health.ts` for the env var, then start with it set.
- `drive.ts work` does not heartbeat; only `heartbeat` does.
- A fresh `up` has no worker row; if the seeded precondition "no workers" is violated, a previous run's data leaked.
