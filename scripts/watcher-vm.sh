#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose --profile vm)
export PUBLIC_URL=http://host.docker.internal:8080
export WATCHER_INSTALL_COMMAND=true
url=${COORDINATOR_URL:-http://localhost:8080}

case "${1:-}" in
  up)
    "${compose[@]}" up -d --build coordinator watcher-vm
    until curl -sf "$url/workers" >/dev/null; do sleep 1; done
    "${compose[@]}" exec -e SEED_DISCORD_CHANNEL_ID=sim-channel coordinator bun run src/main.seed.ts
    ;;
  register)
    reply=$(curl -sf -X POST "$url/commands" -H 'content-type: application/json' -d '{
      "channelType":"discord","command":"register-worker","externalId":"sim-1",
      "channelId":"sim-channel","sender":{"id":"sim-user"},"options":{"name":"vm-sim"}}')
    line=$(printf '%s' "$reply" | sed -E 's/.*(curl -fsSL [^ ]*\/watcher\/install\.sh [^\\]*)\\n.*/\1/')
    echo "in the VM: $line"
    "${compose[@]}" exec -d watcher-vm sh -c "$line > /tmp/watcher.log 2>&1"
    sleep 5
    "${compose[@]}" exec watcher-vm cat /tmp/watcher.log
    ;;
  logs)
    "${compose[@]}" exec watcher-vm tail -f /tmp/watcher.log
    ;;
  *)
    echo "usage: $0 up|register|logs" >&2
    exit 2
    ;;
esac
