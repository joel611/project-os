FROM oven/bun:1.4.4 AS agents
ENV BUN_INSTALL=/opt/bun-global
RUN bun add -g @earendil-works/pi-coding-agent @openai/codex

FROM oven/bun:1.4.4 AS manifests
WORKDIR /repo
COPY . /src
RUN cd /src && mkdir /manifests \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests \; \
 && cp bun.lock /manifests/

FROM oven/bun:1.4.4 AS deps
WORKDIR /repo
COPY --from=manifests /manifests ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.4
COPY --from=agents /opt/bun-global /opt/bun-global
# `bun add -g` links the agents into the base image's bin dir, which this copy doesn't carry over.
RUN ln -s /opt/bun-global/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi \
 && ln -s /opt/bun-global/install/global/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=deps /repo ./
COPY . .
RUN chmod +x apps/watcher/src/main.bun.ts \
 && ln -s /repo/apps/watcher/src/main.bun.ts /usr/local/bin/project-os-watcher \
 && mkdir -p /work /home/bun/.config && chown bun:bun /work /home/bun/.config
USER bun
WORKDIR /work
ENV WORKER_CWD=/work
CMD ["sleep", "infinity"]
