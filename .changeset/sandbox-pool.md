---
"@project-os/contracts": minor
"@project-os/core": minor
"@project-os/coordinator": minor
"@project-os/sandbox-core": minor
"@project-os/sandbox-daytona": minor
"@project-os/sandbox-cloudflare": minor
"@project-os/sandbox-boat": minor
"@project-os/cloudflare-sandbox": minor
"@project-os/infra-local": patch
"@project-os/agent-runtime": patch
"@project-os/web": patch
---

Run shared tickets from a sandbox pool: Daytona, Cloudflare Sandbox and boat.dev behind one `SandboxRunner` interface, picked in `WORKER_PROVIDERS` order with per-provider caps. boat.dev joins as the third provider.
