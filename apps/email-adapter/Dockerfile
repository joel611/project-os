# Built from the repo root: docker build -f apps/email-adapter/Dockerfile .
FROM oven/bun:1.4.4-slim
WORKDIR /repo
COPY . .
# --ignore-scripts: root `prepare` runs `vp config` (git hooks), vp is a devDependency
RUN bun install --frozen-lockfile --production --ignore-scripts
WORKDIR /repo/apps/email-adapter
CMD ["bun", "run", "src/main.bun.ts"]
