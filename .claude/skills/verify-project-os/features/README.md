# project-os verification map

Index of user-facing features and the recipe for each. Read this, then the matching file. Launch/doctor/drive/cleanup mechanics are in `../SKILL.md`.

## Baseline preconditions

- `../run.sh up` from an empty data dir; `../run.sh doctor` all `ok`.
- Seed: org `verify-org`, project **Verify Project**, default Discord channel `verify-chan`, shared worker **verify-box** (offline until `drive.ts heartbeat`) and personal device **bob-laptop** (never online). No tickets or memory yet.
- Commands run from `apps/e2e`; dashboard at `http://localhost:15173`.
- Recipes may build on earlier state; run in index order or `down`/`up` between them.

## Proof and skip reporting

- Capture the action (command + output), an API read-back (`curl`), and an ARIA snapshot + screenshot of the dashboard. Save to `$VERIFY_DIR/evidence/`, naming artifacts after the feature file.
- A precondition that cannot be met: report the attempted command and what was missing; never weaken the journey.

## Features

| File                                           | Feature                                                    |
| ---------------------------------------------- | ---------------------------------------------------------- |
| [inbound-to-reply.md](inbound-to-reply.md)     | Discord message → Ticket → Worker completes → reply posted |
| [dashboard-tickets.md](dashboard-tickets.md)   | Dashboard ticket table + activity sheet                    |
| [project-memory.md](project-memory.md)         | Worker writes memory → Memory tab                          |
| [worker-health.md](worker-health.md)           | Worker heartbeat → Workers panel online/offline            |
| [inbound-edge-cases.md](inbound-edge-cases.md) | Duplicate delivery, unlinked channel                       |
