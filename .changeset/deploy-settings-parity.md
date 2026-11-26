---
"@project-os/coordinator": patch
"@project-os/config": patch
---

Fix: the Cloudflare deploy could not turn on the Email Digest, because `alchemy.run.ts` never bound `EMAIL_DIGEST`. It also now binds `HEALTH_WORKER_STALE_MIN`, `HEALTH_UNPICKED_MIN`, `HEALTH_FOLLOW_UP_MIN`, `HEALTH_INACTIVITY_FAIL_MIN`, `CHANNEL_DIGEST_MAX_MESSAGES` and `CHANNEL_DIGEST_RETRY_MIN`. The deploy workflow now forwards the settings it was missing, and `bun run env:gh` uploads `SKILLS_GITHUB_TOKEN` as a secret. A setting the Coordinator reads but the deploy does not bind now fails a test. Internally, one module (`assembleCoordinator`) now wires the Coordinator for both targets and the test stack.
