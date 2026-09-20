#!/usr/bin/env bash
# One command to the pitch: install, (optionally) start a local Elasticsearch, generate + index the
# acme-ledger crime scene, build the detective UI and open the Interrogation Room.
#
#   scripts/demo.sh            # use ELASTICSEARCH_URL from .env (Elastic Cloud / Serverless) or a running local node
#   scripts/demo.sh --local    # also download + start a local single-node Elasticsearch (no Docker)
#   scripts/demo.sh --offline  # skip Elasticsearch entirely; the UI runs the simulated cold case
#
# Without Elasticsearch or a GEMINI_API_KEY the UI still works: "Run demo case (simulated)" replays the
# real acme-ledger history through the Bayesian engine in the browser.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3333}"
LOCAL_ES=0
OFFLINE=0
for a in "$@"; do
  case "$a" in
    --local) LOCAL_ES=1 ;;
    --offline) OFFLINE=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
  esac
done

say() { printf '\033[1;33m▸\033[0m %s\n' "$*"; }

[ -f .env ] && set -a && . ./.env && set +a

if [ ! -d node_modules ]; then
  say "npm install"
  npm install
fi

if [ "$OFFLINE" = 1 ]; then
  export ELASTICSEARCH_URL="http://127.0.0.1:1"   # guaranteed unreachable → simulation mode
elif [ "$LOCAL_ES" = 1 ]; then
  say "starting a local Elasticsearch (first run downloads ~600 MB)"
  bash scripts/es-local.sh start
  export ELASTICSEARCH_URL="${ELASTICSEARCH_URL:-http://127.0.0.1:9200}"
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  say "GEMINI_API_KEY is not set — the detective agent is off; bring-your-own-oracle cases and the simulation still work"
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "port $PORT is busy — stopping the previous bureau"
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
fi

say "building the detective UI"
npm run -s build:web

say "opening the Interrogation Room at http://127.0.0.1:$PORT"
( sleep 2; command -v open >/dev/null && open "http://127.0.0.1:$PORT" || true ) &
PORT="$PORT" exec npx tsx src/server.ts
