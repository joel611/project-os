FROM oven/bun:1.4.4 AS pi
ENV BUN_INSTALL=/opt/bun-global
RUN bun add -g @earendil-works/pi-coding-agent

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
COPY --from=pi /opt/bun-global /opt/bun-global
# `bun add -g` links pi into the base image's bin dir, which this copy doesn't carry over.
RUN ln -s /opt/bun-global/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js /usr/local/bin/pi
WORKDIR /repo
COPY --from=deps /repo ./
COPY . .
RUN chmod +x apps/watcher/src/main.bun.ts apps/watcher/sim/claude-as-pi.ts \
 && ln -s /repo/apps/watcher/src/main.bun.ts /usr/local/bin/project-os-watcher \
 && ln -s /repo/apps/watcher/sim/claude-as-pi.ts /usr/local/bin/claude \
 && mkdir -p /work /home/bun/.config && chown bun:bun /work /home/bun/.config
USER bun
WORKDIR /work
ENV WORKER_CWD=/work
CMD ["sleep", "infinity"]
