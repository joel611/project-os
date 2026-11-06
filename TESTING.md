# Testing without Discord

`bun run test:integration` runs `apps/e2e/`: message → ticket → Watcher → MCP worker → completion → reply, with discord.js and the AI providers faked. `bun run test:run` includes it.

To drive a running Coordinator by hand, start it without `DISCORD_BOT_TOKEN`, so it posts replies to `:8081`, and run the fake there:

```sh
SEED_DISCORD_CHANNEL_ID=fake-chan-1 bun run seed   # link the fake channel once
bun run --cwd packages/channel-discord fake        # REPL: type a message, replies print
bun run --cwd packages/channel-discord fake --say "fix the login bug" --wait 120   # one-shot, exits on first reply
```

Flags: `--channel`, `--thread`, `--user`, `--name`. Messages @mention the bot like a person would; `--no-mention` sends one without, which the Coordinator ignores at the top of a project channel. Set `--channel`/`--user` to `ADMIN_CHANNEL_ID`/an id in `ADMIN_USER_IDS` to exercise the admin channel.
