#!/usr/bin/env bash
# Convenience wrapper around `docker compose` for the local test DB.
# Usage: ./db.sh <command>
set -euo pipefail

cd "$(dirname "$0")"

CONTAINER="database-app-pg"
DB_USER="workbench"
DB_NAME="workbench"

usage() {
  cat <<EOF
local dev Postgres (port 5433) for the Database App POC.

usage: ./db.sh <command>

commands:
  up         start the container in the background (idempotent)
  down       stop and remove the container; volume kept
  reset      down + remove volume + up; re-runs all seed scripts
  restart    restart the container without touching the volume
  psql       interactive psql shell as $DB_USER
  logs       follow container logs
  status     show health + row counts per table
  shell      bash shell inside the container

connection settings for the app:
  host=localhost  port=5433  database=$DB_NAME
  user=$DB_USER   password=$DB_USER   ssl_mode=disable
EOF
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon not running. Open Docker Desktop first." >&2
    exit 1
  fi
}

wait_ready() {
  echo -n "waiting for postgres "
  for _ in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      echo "ready."
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo " timed out" >&2
  return 1
}

cmd_up() {
  require_docker
  docker compose up -d
  wait_ready
  echo
  echo "connected:  postgres://$DB_USER:$DB_USER@localhost:5433/$DB_NAME"
  echo "ssl_mode:   disable"
}

cmd_down() {
  require_docker
  docker compose down
}

cmd_reset() {
  require_docker
  docker compose down -v
  docker compose up -d
  wait_ready
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "ANALYZE;" >/dev/null
  echo "seeded fresh. tables:"
  cmd_status
}

cmd_restart() {
  require_docker
  docker compose restart
  wait_ready
}

cmd_psql() {
  require_docker
  exec docker exec -it "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"
}

cmd_logs() {
  require_docker
  exec docker compose logs -f
}

cmd_shell() {
  require_docker
  exec docker exec -it "$CONTAINER" bash
}

cmd_status() {
  require_docker
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -At -c "
    DO \$\$
    DECLARE
      r record;
      n bigint;
      out text := '';
    BEGIN
      FOR r IN
        SELECT n.nspname AS ns, c.relname AS rn, c.relkind AS kind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','v')
          AND n.nspname IN ('public','clinical','billing')
        ORDER BY n.nspname, c.relname
      LOOP
        EXECUTE format('SELECT count(*) FROM %I.%I', r.ns, r.rn) INTO n;
        out := out || format('  %-32s %10s  %s', r.ns || '.' || r.rn, to_char(n, 'FM999,999,990'), CASE WHEN r.kind = 'v' THEN '(view)' ELSE '' END) || E'\\n';
      END LOOP;
      RAISE INFO E'\\n%', out;
    END \$\$;
  " 2>&1 | grep -E "^INFO|^  " | sed 's/^INFO:  //'
}

case "${1:-}" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  reset)    cmd_reset ;;
  restart)  cmd_restart ;;
  psql)     cmd_psql ;;
  logs)     cmd_logs ;;
  shell)    cmd_shell ;;
  status)   cmd_status ;;
  ""|-h|--help|help) usage ;;
  *) echo "unknown command: $1" >&2; usage; exit 1 ;;
esac
