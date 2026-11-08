"""Account scopes for data associated with a Tuya connection."""

import hashlib

from fastapi import HTTPException


def scope_for(bridge, provider):
    bridge.require_enabled()
    identity = (
        bridge.credentials.get("access_id")
        if provider == "developer" and bridge.credentials
        else bridge.auth.get("token_info", {}).get("uid")
        if provider == "sharing" and isinstance(bridge.auth, dict)
        else None
    )
    if not identity:
        raise HTTPException(409, "Connect the selected Tuya account first")
    return hashlib.sha256((provider + ":" + identity).encode()).hexdigest()
