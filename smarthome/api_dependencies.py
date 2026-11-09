import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, HTTPException, Request
from fastapi.security import APIKeyHeader
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assistant_sessions import CHAT_ROUTES, SESSION_PREFIX, fingerprint
from .models import HouseholdMember

MEMBER_KEY_PREFIX = "shm_"
MEMBER_KEY = re.compile(r"shm_[A-Za-z0-9_-]{43}\Z")
MEMBER_ROUTES = {
    "GET": frozenset({
        "/api/v1/buildings",
        "/api/v1/rooms",
        "/api/v1/devices",
        "/api/v1/devices/{item_id}",
        "/api/v1/devices/{item_id}/state",
        "/api/v1/groups",
        "/api/v1/groups/{group_id}/state",
        "/api/v1/cloud/status",
        "/api/v1/cloud/topology",
        "/api/v1/cloud/devices",
        "/api/v1/cloud/devices/{device_id}/status",
        "/api/v1/cloud/devices/{device_id}/functions",
        "/api/v1/dashboard-layouts/me",
        "/api/v1/dashboard-layouts/me/room-navigation",
        "/api/v1/rooms/{room_id}/appearance",
        "/api/v1/rooms/{room_id}/background",
        "/api/v1/light-presets/{device_id}",
    }),
    "POST": frozenset({
        "/api/v1/devices/{item_id}/commands/capabilities",
        "/api/v1/groups/{group_id}/commands/{command}",
        "/api/v1/cloud/devices/{device_id}/commands",
    }),
    "PUT": frozenset({
        "/api/v1/dashboard-layouts/me",
        "/api/v1/dashboard-layouts/me/room-navigation",
    }),
}


@dataclass(frozen=True)
class Account:
    id: str
    name: str
    role: Literal["owner", "member"]


OWNER = Account(id="owner", name="Owner", role="owner")


def get_session(request: Request):
    with Session(request.app.state.engine, expire_on_commit=False) as session:
        yield session


def key_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


token_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def authenticate(
    request: Request, token: str | None = Depends(token_header), session: Session = Depends(get_session),
) -> Account | None:
    settings = request.app.state.settings
    expected = settings.api_token
    if not expected and settings.setup_code:
        raise HTTPException(503, "Complete first-time key setup before using the service.")
    if not expected:
        # The existing open mode remains available for development.
        return None
    if token and hmac.compare_digest(token.encode(), expected.encode()):
        return OWNER
    if token and token.startswith(SESSION_PREFIX):
        credential = request.app.state.assistant_sessions.resolve(token)
        if credential and hmac.compare_digest(credential, fingerprint(expected)):
            route = getattr(request.scope.get("route"), "path", None)
            if route not in CHAT_ROUTES.get(request.method, ()):
                raise HTTPException(403, "This action is unavailable in AI chat")
            return None
    if not token or not MEMBER_KEY.fullmatch(token):
        raise HTTPException(401, "Missing or invalid X-API-Key")
    member = session.scalar(select(HouseholdMember).where(HouseholdMember.key_digest == key_digest(token)))
    if member is None:
        raise HTTPException(401, "Missing or invalid X-API-Key")
    # FastAPI resolves the route before running dependencies. New routes are owner-only by default.
    route = request.scope.get("route")
    if getattr(route, "path", None) not in MEMBER_ROUTES.get(request.method, ()):
        raise HTTPException(403, "This action requires the owner account")
    return Account(id=member.id, name=member.name, role="member")


def require_account(account: Account | None = Depends(authenticate)) -> Account:
    if account is None:
        raise HTTPException(403, "Configure an owner key to use household accounts")
    return account


def require_owner(account: Account = Depends(require_account)) -> Account:
    if account.role != "owner":
        raise HTTPException(403, "This action requires the owner account")
    return account
