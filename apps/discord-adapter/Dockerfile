# Built from the repo root: docker build -f apps/discord-adapter/Dockerfile .
FROM oven/bun:1.4.4-slim
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --production
WORKDIR /repo/apps/discord-adapter
CMD ["bun", "run", "src/main.bun.ts"]
