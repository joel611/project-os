---
layout: home

hero:
  name: project-os
  text: The control tower for your team's AI agents
  tagline: Questions land in chat, tickets get cleared, grounded answers come back. Engineers stay focused.
  actions:
    - theme: brand
      text: Get started
      link: /guide/quick-start
    - theme: alt
      text: Why project-os
      link: /why
    - theme: alt
      text: GitHub
      link: https://github.com/joel611/project-os

features:
  - title: Questions land once
    details: PMs and clients ask in Discord or email, so senior engineers stop paying the "quick ping" tax.
    link: /why
  - title: Context stays project-scoped
    details: Every channel maps to exactly one Project. Memory, sources, and instructions never leak between them.
    link: /how-it-works
  - title: Work becomes tickets
    details: The Coordinator opens a Ticket, assigns it, and tracks every status update. Channels see only what it chooses to surface.
    link: /how-it-works
  - title: Workers pull, never get pushed
    details: Local Claude Code or cloud sandboxes claim tickets atomically, so two agents never collide.
    link: /reference/architecture
  - title: Only the tower talks outside
    details: Adapters are thin and Workers speak only MCP, so the surface that can say the wrong thing to a customer is small and central.
    link: /how-it-works
  - title: Memory compounds
    details: Workers write durable facts to Project Memory, so the next similar question starts with more context.
    link: /how-it-works
---

::: warning Beta
project-os is in beta. The full loop works end to end, but APIs, configuration, and the database schema can still change in breaking ways. Please [report problems](https://github.com/joel611/project-os/issues).
:::
