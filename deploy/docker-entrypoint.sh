#!/bin/bash
set -euo pipefail
umask 077

if [[ -z "${SMART_HOME_API_TOKEN:-}" ]]; then
    echo 'Set SMART_HOME_API_TOKEN before exposing the service.' >&2
    exit 1
fi

exec python -m uvicorn smarthome.main:app --host "${SMART_HOME_API_HOST:-0.0.0.0}" --port 8000 --workers 1
