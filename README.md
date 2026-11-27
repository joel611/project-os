# project-os

> The open-source control tower for your team's AI agents.  
> Questions land in chat → tickets get cleared → grounded answers return. Engineers stay focused.

[![CI](https://img.shields.io/github/actions/workflow/status/joel611/project-os/ci.yml?branch=main)](https://github.com/joel611/project-os/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1)](https://bun.sh)
[![MCP](https://img.shields.io/badge/MCP-ready-black)](https://modelcontextprotocol.io)

<!-- TODO: Add hero GIF of Discord question → ticket → grounded reply -->

**[Website](https://joel611.github.io/project-os/)** · **[Quick start](apps/site/guide/quick-start.md)** · **[Why](apps/site/why.md)** · **[Architecture](apps/site/reference/architecture.md)**

---

## Why project-os?

Most AI agents either interrupt engineers or give ungrounded answers.  
project-os sits in the middle like a control tower:

- **Questions land once** — PMs and clients ask in Discord/email. No more "quick ping" tax on senior engineers.
- **Context stays project-scoped** — Every channel maps to exactly one Project. Memory, sources, and instructions never leak.
- **Work becomes tickets** — The tower opens a Ticket, assigns it, and tracks every status update. Channels only see what the tower chooses to surface.
- **Workers pull, never get pushed** — Local Claude Code (or cloud sandboxes) claim tickets atomically. Two agents never collide.
- **Only the tower talks outside** — Adapters are thin. Workers speak only MCP. The surface that can say the wrong thing to a customer is tiny and centralized.
- **Memory compounds** — Workers can write durable facts to Project Memory, so the next similar question starts with more context.

The full story and design rationale: [Why project-os](apps/site/why.md).

---

## Get started

```sh
bun install
cp .env.example .env      # Discord bot + OPENROUTER_API_KEY + ADMIN_*
docker compose up --build
```

The full walkthrough is in [Quick start](apps/site/guide/quick-start.md).

## Documentation

The same Markdown files are published as the product site at **[joel611.github.io/project-os](https://joel611.github.io/project-os/)**.

- [Why project-os](apps/site/why.md): the problem and the design choices
- [How it works](apps/site/how-it-works.md): the control tower, its roles, and a question's path
- [Quick start](apps/site/guide/quick-start.md) and [Setup](apps/site/guide/setup.md): run it, then connect [Discord](apps/site/channels/discord.md#set-up), [Google](apps/site/connectors/google.md#set-up), and [GitHub](apps/site/connectors/github.md#set-up)
- [Deploy to Cloudflare](apps/site/guide/deployment.md)
- [Development](apps/site/guide/development.md) and [Testing without Discord](apps/site/guide/testing.md)
- [Technical architecture](apps/site/reference/architecture.md) and the [glossary](CONTEXT.md)

---

## Contributing

This is still a focused proof-of-concept of the full loop.  
We welcome issues, discussions, and PRs — especially around:

- Additional channel adapters
- More Worker runtimes beyond local Claude Code and the Daytona, Cloudflare Sandbox and boat.dev sandboxes
- Dashboard UX
- Memory quality / retrieval

See the issues tab and [CONTEXT.md](CONTEXT.md) for the language we use (Project, Ticket, Worker, Claim, etc.).

---

## License

MIT — see [LICENSE](LICENSE).

---

**project-os** — clear the airspace so your team can focus on flying.
