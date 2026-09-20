#!/usr/bin/env bash
# Run a single-node Elasticsearch locally without Docker (macOS / Linux).
# Usage: scripts/es-local.sh start|stop|status
set -euo pipefail

ES_VERSION="${ES_VERSION:-9.5.4}"
WD_HOME="${WHODUNIT_HOME:-$HOME/.whodunit}"
ES_DIR="$WD_HOME/elasticsearch-$ES_VERSION"
PID_FILE="$WD_HOME/es.pid"
PORT="${ES_PORT:-9200}"

platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in arm64|aarch64) arch="aarch64";; x86_64|amd64) arch="x86_64";; esac
  echo "${os}-${arch}"
}

download() {
  mkdir -p "$WD_HOME"
  local tarball="$WD_HOME/es.tar.gz"
  if [ ! -d "$ES_DIR" ]; then
    if [ ! -s "$tarball" ] || ! tar -tzf "$tarball" >/dev/null 2>&1; then
      echo "▸ downloading Elasticsearch $ES_VERSION ($(platform))…"
      curl -L --progress-bar -o "$tarball" \
        "https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-${ES_VERSION}-$(platform).tar.gz"
    fi
    echo "▸ extracting…"
    tar -xzf "$tarball" -C "$WD_HOME"
    rm -f "$tarball"
    # Local dev config: no TLS/auth, tiny heap, single node.
    cat > "$ES_DIR/config/elasticsearch.yml" <<EOF
cluster.name: whodunit
node.name: detective
discovery.type: single-node
network.host: 127.0.0.1
http.port: ${PORT}
xpack.security.enabled: false
xpack.ml.enabled: false
cluster.routing.allocation.disk.threshold_enabled: false
EOF
    echo "-Xms1g" > "$ES_DIR/config/jvm.options.d/heap.options"
    echo "-Xmx1g" >> "$ES_DIR/config/jvm.options.d/heap.options"
  fi
}

start() {
  if status >/dev/null 2>&1; then echo "✔ Elasticsearch already running on :$PORT"; exit 0; fi
  download
  echo "▸ starting Elasticsearch $ES_VERSION on http://127.0.0.1:$PORT (logs: $WD_HOME/es.log)"
  ES_JAVA_OPTS="${ES_JAVA_OPTS:-}" nohup "$ES_DIR/bin/elasticsearch" > "$WD_HOME/es.log" 2>&1 &
  echo $! > "$PID_FILE"
  for i in $(seq 1 90); do
    if curl -s "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      echo "✔ Elasticsearch is up: $(curl -s "http://127.0.0.1:$PORT" | tr -d '\n' | sed 's/  */ /g' | cut -c1-120)…"
      exit 0
    fi
    sleep 1
  done
  echo "✖ Elasticsearch did not come up in 90s; see $WD_HOME/es.log" >&2
  exit 1
}

stop() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null && echo "✔ stopped" || echo "▲ not running"
    rm -f "$PID_FILE"
  else
    pkill -f "$ES_DIR" 2>/dev/null && echo "✔ stopped" || echo "▲ not running"
  fi
}

status() {
  curl -s "http://127.0.0.1:$PORT/_cluster/health" && echo
}

case "${1:-start}" in
  start) start;;
  stop) stop;;
  status) status;;
  *) echo "usage: $0 start|stop|status"; exit 1;;
esac
