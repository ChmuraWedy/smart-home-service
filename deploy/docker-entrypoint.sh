#!/bin/bash
set -euo pipefail
umask 077

if [[ -z "${SMART_HOME_API_TOKEN:-}" ]]; then
    echo 'Set SMART_HOME_API_TOKEN before exposing the service.' >&2
    exit 1
fi

python -m uvicorn smarthome.main:app --host 127.0.0.1 --port 8000 --workers 1 &
api_pid=$!
nginx -c /app/deploy/nginx.conf -g 'daemon off;' &
web_pid=$!

cleanup() {
    trap - EXIT INT TERM
    kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
    wait "$api_pid" "$web_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
# Stop the whole container if either the web server or API exits.
wait -n "$api_pid" "$web_pid"
