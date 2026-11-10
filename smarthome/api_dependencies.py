import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, HTTPException, Request
from fastapi.security import APIKeyHeader
from sqlalchemy import select
from sqlalchemy.orm import Session

from .assistant_sessions import CHAT_ROUTES, SESSION_PREFIX, DashboardCredential
from .models import HouseholdDeviceKey, HouseholdMember, HouseholdOwner

OWNER_ID = "owner"
ROOT_LOGIN = "root"
MEMBER_KEY_PREFIX = "shm_"
MEMBER_KEY = re.compile(r"shm_[A-Za-z0-9_-]{43}\Z")
MEMBER_ROUTES = {
    "GET": frozenset({
        "/api/v1/accounts/me",
        "/api/v1/accounts/{account_id}/keys",
        "/api/v1/accounts/{account_id}/keys/{key_id}",
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
        "/api/v1/accounts/login",
        "/api/v1/assistant/embed",
        "/api/v1/accounts/{account_id}/keys",
        "/api/v1/devices/{item_id}/commands/capabilities",
        "/api/v1/groups/{group_id}/commands/{command}",
        "/api/v1/cloud/devices/{device_id}/commands",
    }),
    "DELETE": frozenset({"/api/v1/accounts/{account_id}/keys/{key_id}"}),
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
    login: str
    key_id: str | None = None
    needs_name: bool = False


def owner_account(session: Session, key_id: str | None = None) -> Account:
    profile = session.get(HouseholdOwner, OWNER_ID)
    if profile is None:
        return Account(OWNER_ID, "Owner", "owner", ROOT_LOGIN, key_id, True)
    return Account(OWNER_ID, profile.name, "owner", profile.login, key_id)


def get_session(request: Request):
    with Session(request.app.state.engine, expire_on_commit=False) as session:
        yield session


def key_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


token_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _account_for_device_key(session: Session, credential: HouseholdDeviceKey) -> Account:
    if credential.member_id is None:
        return owner_account(session, credential.id)
    member = session.get(HouseholdMember, credential.member_id)
    if member is None or not member.login:
        raise HTTPException(401, "Missing or invalid X-API-Key")
    return Account(member.id, member.name, "member", member.login, credential.id)


def account_for_chat(
    request: Request, session: Session, credential: DashboardCredential | None,
) -> Account:
    if credential is not None:
        if credential.key_id is None:
            expected = request.app.state.settings.api_token
            if expected and hmac.compare_digest(key_digest(expected), credential.digest):
                return owner_account(session)
        else:
            key = session.get(HouseholdDeviceKey, credential.key_id)
            if key and hmac.compare_digest(key.key_digest, credential.digest):
                return _account_for_device_key(session, key)
    raise HTTPException(401, "Chat sign-in expired. Reopen AI chat.")


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
        return owner_account(session)

    # FastAPI resolves the route before running dependencies.
    route = getattr(request.scope.get("route"), "path", None)
    if token and token.startswith(SESSION_PREFIX):
        if route not in CHAT_ROUTES.get(request.method, ()):
            raise HTTPException(403, "This action is unavailable in AI chat")
        account = account_for_chat(request, session, request.app.state.assistant_sessions.resolve(token))
    else:
        if not token or not MEMBER_KEY.fullmatch(token):
            raise HTTPException(401, "Missing or invalid X-API-Key")
        credential = session.scalar(select(HouseholdDeviceKey).where(HouseholdDeviceKey.key_digest == key_digest(token)))
        if credential is None:
            raise HTTPException(401, "Missing or invalid X-API-Key")
        account = _account_for_device_key(session, credential)

    if account.role == "member" and route not in MEMBER_ROUTES.get(request.method, ()):
        raise HTTPException(403, "This action requires the owner account")
    return account


def require_account(account: Account | None = Depends(authenticate)) -> Account:
    if account is None:
        raise HTTPException(403, "Configure an owner key to use household accounts")
    return account


def require_owner(account: Account = Depends(require_account)) -> Account:
    if account.role != "owner":
        raise HTTPException(403, "This action requires the owner account")
    return account
