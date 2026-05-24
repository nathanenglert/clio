#!/usr/bin/env bash
# Reseed app-side state for one (or every) configured connection.
#
# Wipes from the metadata DB at:
#   ~/Library/Application Support/com.dbapp.poc/connections.db
#     - all rows in sensitivity_classifications for the connection
#
# And from the secret store (dev-secrets.json in debug builds, macOS
# keychain in release):
#     - the per-connection redaction secret (`redaction:<name>`)
#
# Preserves: the connection row itself, saved credentials, every other
# connection. After reseeding, restart the app (or disconnect + reconnect)
# so the in-process redactor cache is dropped.
#
# Usage:
#   ./reseed.sh --list
#   ./reseed.sh <connection-name>
#   ./reseed.sh --all
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/com.dbapp.poc"
META_DB="$APP_DIR/connections.db"
DEV_SECRETS="$APP_DIR/dev-secrets.json"
KEYRING_SERVICE="com.dbapp.poc"

usage() {
  cat <<EOF
reseed app-side state (classifications + redaction secret) for a connection.

usage:
  ./reseed.sh --list                 show configured connections
  ./reseed.sh <connection-name>      wipe app state for one connection
  ./reseed.sh --all                  wipe app state for every connection

after running, restart the Database App (or disconnect + reconnect the
affected connection) so the redactor cache is dropped.
EOF
}

require_db() {
  if [[ ! -f "$META_DB" ]]; then
    echo "metadata DB not found at $META_DB" >&2
    echo "has the app ever run on this machine?" >&2
    exit 1
  fi
}

cmd_list() {
  require_db
  sqlite3 -separator $'\t' "$META_DB" \
    "SELECT name, host || ':' || port || '/' || database FROM connections ORDER BY name;" \
    | awk -F'\t' 'BEGIN { printf "  %-24s  %s\n", "name", "endpoint" }
                  { printf "  %-24s  %s\n", $1, $2 }'
}

# Delete the redaction secret for $1. Auto-detects dev vs release store.
wipe_secret() {
  local name="$1"
  local key="redaction:$name"
  if [[ -f "$DEV_SECRETS" ]]; then
    python3 - "$DEV_SECRETS" "$key" <<'PY'
import json, sys
path, key = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
removed = data.pop(key, None) is not None
with open(path, "w") as f:
    json.dump(data, f, indent=2)
print("removed" if removed else "absent")
PY
  else
    if security delete-generic-password -s "$KEYRING_SERVICE" -a "$key" >/dev/null 2>&1; then
      echo removed
    else
      echo absent
    fi
  fi
}

reseed_one() {
  local name="$1"
  local id
  id="$(sqlite3 "$META_DB" "SELECT id FROM connections WHERE name = '$(printf %s "$name" | sed "s/'/''/g")';")"
  if [[ -z "$id" ]]; then
    echo "no connection named '$name' in $META_DB" >&2
    return 1
  fi

  local before after
  before="$(sqlite3 "$META_DB" "SELECT COUNT(*) FROM sensitivity_classifications WHERE connection_id = '$id';")"
  sqlite3 "$META_DB" "DELETE FROM sensitivity_classifications WHERE connection_id = '$id';"
  after="$(sqlite3 "$META_DB" "SELECT COUNT(*) FROM sensitivity_classifications WHERE connection_id = '$id';")"
  local secret_state
  secret_state="$(wipe_secret "$name")"
  printf "  %-24s  classifications: %d → %d   secret: %s\n" "$name" "$before" "$after" "$secret_state"
}

cmd_one() {
  require_db
  local name="$1"
  read -r -p "reseed app state for '$name'? this can't be undone. [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
  reseed_one "$name"
  echo
  echo "done. restart the app or disconnect + reconnect '$name' to drop the redactor cache."
}

cmd_all() {
  require_db
  local names
  names="$(sqlite3 "$META_DB" "SELECT name FROM connections ORDER BY name;")"
  if [[ -z "$names" ]]; then
    echo "no connections in $META_DB"
    return 0
  fi
  echo "this will reseed app state for:"
  while IFS= read -r n; do echo "  - $n"; done <<<"$names"
  read -r -p "proceed? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
  while IFS= read -r n; do reseed_one "$n"; done <<<"$names"
  echo
  echo "done. restart the app to drop the redactor cache."
}

case "${1:-}" in
  --list)      cmd_list ;;
  --all)       cmd_all ;;
  ""|-h|--help|help) usage ;;
  -*)          echo "unknown option: $1" >&2; usage; exit 1 ;;
  *)           cmd_one "$1" ;;
esac
