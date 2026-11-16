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
    codex_auth=${CODEX_HOME:-$HOME/.codex}/auth.json
    if [ -f "$codex_auth" ]; then
      "${compose[@]}" exec -u root watcher-vm mkdir -p /home/bun/.codex
      "${compose[@]}" cp "$codex_auth" watcher-vm:/home/bun/.codex/auth.json
      "${compose[@]}" exec -u root watcher-vm sh -c 'chown -R bun:bun /home/bun/.codex && chmod 600 /home/bun/.codex/auth.json'
    else
      echo "no $codex_auth: codex won't be signed in inside the VM" >&2
    fi
    until curl -sf "$url/health" >/dev/null; do sleep 1; done
    "${compose[@]}" exec -e SEED_DISCORD_CHANNEL_ID=sim-channel coordinator bun run src/main.seed.ts
    ;;
  register)
    agent=${WATCHER_VM_AGENT:-pi}
    model=${WATCHER_VM_MODEL:-}
    if [ "$agent" = pi ] && [ -z "$model" ]; then
      model=${SANDBOX_PI_MODEL:-openrouter/deepseek/deepseek-v4.1-flash-1017}
    fi
    # /commands takes the service token; Compose reads it from .env, so fall back to that.
    token=${COORDINATOR_SERVICE_TOKEN:-$(sed -n 's/^COORDINATOR_SERVICE_TOKEN=//p' .env 2>/dev/null | head -1)}
    if [ -z "$token" ]; then
      echo "COORDINATOR_SERVICE_TOKEN is not set (shell or .env)" >&2
      exit 1
    fi
    reply=$(curl -sf -X POST "$url/commands" -H 'content-type: application/json' \
      -H "authorization: Bearer $token" -d '{
      "channelType":"discord","command":"register-worker","externalId":"sim-1",
      "channelId":"sim-channel","sender":{"id":"sim-user"},
      "options":{"name":"vm-sim","agent":"'"$agent"'","model":"'"$model"'"}}')
    line=$(printf '%s' "$reply" | sed -E 's/.*(curl -fsSL [^ ]*\/watcher\/install\.sh [^\\]*)\\n.*/\1/')
    case "$line" in
      "curl -fsSL "*) ;;
      *)
        echo "/register-worker gave no install line: $reply" >&2
        exit 1
        ;;
    esac
    echo "in the VM: $line"
    "${compose[@]}" exec -d watcher-vm sh -c "$line > /tmp/watcher.log 2>&1"
    sleep 5
    "${compose[@]}" exec watcher-vm cat /tmp/watcher.log
    ;;
  logs)
    "${compose[@]}" exec watcher-vm tail -f /tmp/watcher.log
    ;;
  *)
    echo "usage: [WATCHER_VM_AGENT=pi|codex|claude] [WATCHER_VM_MODEL=...] $0 up|register|logs" >&2
    exit 2
    ;;
esac
