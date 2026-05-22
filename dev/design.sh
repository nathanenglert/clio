#!/usr/bin/env bash
# Serve the design canvas over HTTP and open it in the browser.
# Usage: ./design.sh <command>
set -euo pipefail

cd "$(dirname "$0")/../design"

PORT="${DESIGN_PORT:-5180}"
HTML="Database%20App.html"
URL="http://localhost:${PORT}/${HTML}"
PID_FILE="/tmp/database-app-design-canvas.pid"

usage() {
  cat <<EOF
local HTTP server for the design canvas (./design/Database App.html).

usage: ./design.sh <command>

commands:
  up         start the server in the background (idempotent) and open browser
  down       stop the server
  status     report whether the server is running
  open       open the browser to the canvas (does not touch the server)

The canvas needs HTTP (not file://) because Chrome blocks loading the .jsx
files as text/babel from a file:// origin.

port: ${PORT} (override with DESIGN_PORT=...)
url:  ${URL}
EOF
}

server_pid() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    cat "$PID_FILE"
    return 0
  fi
  return 1
}

cmd_up() {
  if pid=$(server_pid); then
    echo "server already running (pid $pid) at $URL"
  else
    python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
    sleep 0.3
    echo "started server (pid $(cat "$PID_FILE")) at $URL"
  fi
  open "$URL"
}

cmd_down() {
  if pid=$(server_pid); then
    kill "$pid"
    rm -f "$PID_FILE"
    echo "stopped server (was pid $pid)"
  else
    echo "no server running"
    rm -f "$PID_FILE"
  fi
}

cmd_status() {
  if pid=$(server_pid); then
    echo "running (pid $pid) at $URL"
  else
    echo "not running"
  fi
}

cmd_open() {
  open "$URL"
}

case "${1:-up}" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  status)   cmd_status ;;
  open)     cmd_open ;;
  -h|--help|help) usage ;;
  *) echo "unknown command: $1" >&2; usage; exit 1 ;;
esac
