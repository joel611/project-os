# Discord alone, for a Coordinator that can't host it (Cloudflare) or a split self-host. The Bun
# Coordinator image already runs Discord, so this is only used by the `split` compose profile.
# Build from the repo root: docker build -f apps/discord-gateway/Dockerfile .
FROM oven/bun:1.4.4-slim
WORKDIR /repo
COPY . .
# --ignore-scripts: root `prepare` runs `vp config` (git hooks), vp is a devDependency
RUN bun install --frozen-lockfile --production --ignore-scripts
WORKDIR /repo/apps/discord-gateway
CMD ["bun", "run", "src/main.bun.ts"]
