#!/usr/bin/env bash
# Lifecycle helper for verify-project-os.  Usage: run.sh up | doctor | down
# Ports (override via env): COORD_PORT=18080 ADAPTER_PORT=18081 WEB_PORT=15173. serve.ts registers a shared worker and saves its credentials to $DATA_DIR/worker.json.
# State + logs + evidence live in $VERIFY_DIR (default /tmp/project-os-verify-$COORD_PORT).
# `down` removes data/pids/logs but NEVER $VERIFY_DIR/evidence.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export COORD_PORT="${COORD_PORT:-18080}" ADAPTER_PORT="${ADAPTER_PORT:-18081}" WEB_PORT="${WEB_PORT:-15173}"
VERIFY_DIR="${VERIFY_DIR:-/tmp/project-os-verify-$COORD_PORT}"
export DATA_DIR="$VERIFY_DIR/data"
listener() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true; }

case "${1:-}" in
  up)
    for p in "$COORD_PORT" "$ADAPTER_PORT" "$WEB_PORT"; do
      [ -z "$(listener "$p")" ] || { echo "port $p already in use; refusing to double-drive (set COORD_PORT/ADAPTER_PORT/WEB_PORT)"; exit 1; }
    done
    mkdir -p "$VERIFY_DIR/evidence" "$VERIFY_DIR/logs"
    rm -rf "$DATA_DIR"                       # always start from an empty data dir
    ( cd "$REPO/apps/e2e" && exec bun verify/serve.ts ) >"$VERIFY_DIR/logs/coordinator.log" 2>&1 </dev/null &
    echo $! >"$VERIFY_DIR/coordinator.pid"
    for _ in $(seq 60); do grep -q '^READY' "$VERIFY_DIR/logs/coordinator.log" 2>/dev/null && break; sleep 0.5; done
    grep -q '^READY' "$VERIFY_DIR/logs/coordinator.log" || { echo "coordinator not ready:"; cat "$VERIFY_DIR/logs/coordinator.log"; "$0" down; exit 1; }
    ( cd "$REPO/apps/web" && COORDINATOR_URL="http://localhost:$COORD_PORT" exec bun run dev -- --port "$WEB_PORT" --strictPort ) >"$VERIFY_DIR/logs/web.log" 2>&1 </dev/null &
    echo $! >"$VERIFY_DIR/web.pid"
    for _ in $(seq 90); do curl -sf "http://localhost:$WEB_PORT/" >/dev/null && break; sleep 0.5; done
    curl -sf "http://localhost:$WEB_PORT/" >/dev/null || { echo "web not ready:"; cat "$VERIFY_DIR/logs/web.log"; "$0" down; exit 1; }
    cat "$VERIFY_DIR/logs/coordinator.log"
    echo "WEB http://localhost:$WEB_PORT  VERIFY_DIR=$VERIFY_DIR"
    ;;
  doctor)
    ok=0
    chk() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; ok=1; fi; }
    chk "coordinator pid alive" 'kill -0 "$(cat "$VERIFY_DIR/coordinator.pid")"'
    chk "coordinator port $COORD_PORT owned by our pid" '[ "$(listener $COORD_PORT)" = "$(cat "$VERIFY_DIR/coordinator.pid")" ]'
    chk "GET /health" "curl -sf http://localhost:$COORD_PORT/health | grep -q '\"status\":\"ok\"'"
    chk "seed project exists (name Verify Project)" "curl -sf -H \"authorization: Bearer $(cat "$DATA_DIR/operator.token")\" http://localhost:$COORD_PORT/projects | grep -q 'Verify Project'"
    chk "MCP lists tools" "curl -s -X POST http://localhost:$COORD_PORT/mcp -H \"authorization: Bearer $(sed -n 's/.*\"secret\":\"\([^\"]*\)\".*/\1/p' "$DATA_DIR/worker.json")\" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | grep -q ticket_claim"
    chk "web serves + proxies /api" "curl -sf -H \"authorization: Bearer $(cat "$DATA_DIR/operator.token")\" http://localhost:$WEB_PORT/api/projects | grep -q 'Verify Project'"
    exit $ok
    ;;
  down)
    # Kill only what `up` started: recorded pids, plus whatever still listens on OUR ports (vite forks children).
    for f in coordinator web; do
      [ -f "$VERIFY_DIR/$f.pid" ] && kill "$(cat "$VERIFY_DIR/$f.pid")" 2>/dev/null || true
    done
    sleep 1
    for p in "$COORD_PORT" "$ADAPTER_PORT" "$WEB_PORT"; do
      [ -f "$VERIFY_DIR/coordinator.pid" ] || continue   # never reached `up`: we own nothing
      pid="$(listener "$p")"; [ -z "$pid" ] || kill $pid 2>/dev/null || true
    done
    rm -rf "$DATA_DIR" "$VERIFY_DIR"/*.pid "$VERIFY_DIR/logs"
    echo "down; evidence kept in $VERIFY_DIR/evidence"
    ;;
  *) echo "usage: $0 up|doctor|down"; exit 2 ;;
esac
