---
"@project-os/config": minor
"@project-os/coordinator": minor
"@project-os/agent-runtime": minor
---

Reorganize the model env. Every model is now one `provider/model` string: `DEFAULT_MODEL` (required, the chat model and the fallback for the rest), `CHANNEL_DIGEST_MODEL` (optional, the Channel Digest) and `DECISION_MODEL` (optional, the message classifier, default `openrouter/typesafe/jev-1.14`). `SANDBOX_PI_MODEL` falls back to `DEFAULT_MODEL`. The Coordinator refuses to start without `DEFAULT_MODEL`, with a model pi-ai doesn't know, or with an old name set: `CHAT_MODEL_ID` / `CHAT_MODEL_PROVIDER`, `CHANNEL_DIGEST_MODEL_ID` / `CHANNEL_DIGEST_MODEL_PROVIDER` and `JEV_MODEL_ID` are removed, and the error names the replacement. The Channel Digest is now always available; the per-project setting turns it on or off. `JEV_MODEL_ID` is no longer exported from `@project-os/agent-runtime`.
