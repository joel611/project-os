---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/infra-sandbox": minor
"@project-os/infra-daytona": minor
"@project-os/infra-cloudflare-sandbox": minor
"@project-os/cloudflare-sandbox": minor
"@project-os/infra-local": patch
"@project-os/agent-runtime": patch
"@project-os/web": patch
---

Run shared tickets from a sandbox pool: Daytona and Cloudflare Sandbox behind one `SandboxRunner` interface, picked in `WORKER_PROVIDERS` order with per-provider caps. boat.dev is stubbed as planned.
