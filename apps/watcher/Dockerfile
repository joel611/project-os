# Stand-in for the external VM that runs the Watcher. Built from the repo root:
#   docker build -f apps/watcher/Dockerfile -t project-os-watcher-vm .
# The package isn't on npm yet, so the Watcher is linked from the repo checkout instead.
# The Watcher launches `claude`; here that name is a shim that runs the session on Pi.
FROM oven/bun:1.4.4
ENV BUN_INSTALL=/usr/local
RUN bun add -g @earendil-works/pi-coding-agent
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --production --ignore-scripts \
 && chmod +x apps/watcher/src/main.bun.ts apps/watcher/sim/claude-as-pi.ts \
 && ln -s /repo/apps/watcher/src/main.bun.ts /usr/local/bin/project-os-watcher \
 && ln -s /repo/apps/watcher/sim/claude-as-pi.ts /usr/local/bin/claude \
 && mkdir -p /work /home/bun/.config && chown bun:bun /work /home/bun/.config
USER bun
WORKDIR /work
ENV WORKER_CWD=/work
CMD ["sleep", "infinity"]
