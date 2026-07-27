#!/bin/sh
set -eu

postgres_pid=""
app_pid=""

stop_processes() {
  if [ -n "$app_pid" ]; then
    kill -TERM "$app_pid" 2>/dev/null || true
  fi
  if [ -n "$postgres_pid" ]; then
    kill -TERM "$postgres_pid" 2>/dev/null || true
    wait "$postgres_pid" 2>/dev/null || true
  fi
}

trap stop_processes INT TERM EXIT

mkdir -p "$PGDATA" /tmp/postgresql

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  initdb \
    -D "$PGDATA" \
    --username=plugin \
    --auth-local=trust \
    --auth-host=trust \
    --encoding=UTF8 \
    --no-locale
fi

postgres \
  -D "$PGDATA" \
  -h 127.0.0.1 \
  -k /tmp/postgresql \
  -p 5432 \
  -c shared_buffers=32MB \
  -c max_connections=10 \
  -c work_mem=2MB \
  -c maintenance_work_mem=16MB \
  > /data/postgres.log 2>&1 &
postgres_pid=$!

attempt=0
until pg_isready -h 127.0.0.1 -p 5432 -U plugin >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 0.25
done

if ! psql -h 127.0.0.1 -p 5432 -U plugin -d postgres -tAc \
  "select 1 from pg_database where datname = 'plugin'" | grep -q 1; then
  createdb -h 127.0.0.1 -p 5432 -U plugin plugin
fi

node server.mjs &
app_pid=$!
wait "$app_pid"
exit_code=$?
app_pid=""

stop_processes
trap - INT TERM EXIT
exit "$exit_code"
