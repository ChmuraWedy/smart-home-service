#!/bin/bash
set -euo pipefail
umask 077

if [[ -z "${SMART_HOME_API_TOKEN:-}" && -z "${SMART_HOME_SETUP_CODE:-}" &&
      ! -s "${SMART_HOME_DB:-/app/data/smarthome.db}.access-key" ]]; then
    echo 'Set SMART_HOME_API_TOKEN or opt into initial key setup with SMART_HOME_SETUP_CODE.' >&2
    exit 1
fi

exec python -m uvicorn smarthome.main:app --host "${SMART_HOME_API_HOST:-0.0.0.0}" --port 8000 --workers 1
