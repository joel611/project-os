# Discord alone, for a Coordinator that can't host it (Cloudflare). Not used by docker-compose.yml:
# the Bun Coordinator image already runs Discord. Build from the repo root:
#   docker build -f packages/channel-discord/Dockerfile .
FROM oven/bun:1.4.4-slim
WORKDIR /repo
COPY . .
# --ignore-scripts: root `prepare` runs `vp config` (git hooks), vp is a devDependency
RUN bun install --frozen-lockfile --production --ignore-scripts
WORKDIR /repo/packages/channel-discord
CMD ["bun", "run", "src/main.standalone.ts"]
