#!/usr/bin/env bash
# Local stand-in for an external VM running the Watcher (compose service `watcher-vm`).
#   scripts/watcher-vm.sh up        start Coordinator + VM, seed a demo project and tickets
#   scripts/watcher-vm.sh register  issue a /register-worker code and run the Watcher in the VM
#   scripts/watcher-vm.sh logs      follow the Watcher's output
# Needs OPENROUTER_API_KEY in .env for Pi to run a ticket; registration works without it.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose --profile vm)
# What /register-worker prints as --server, so the VM reaches the Coordinator via the host port.
export PUBLIC_URL=http://host.docker.internal:8080
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
    # The reply's install half is baked into the image, so run only the register half, as printed.
    line=$(printf '%s' "$reply" | sed -E 's/.*(project-os-watcher register [^\\]*)\\n.*/\1/')
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
