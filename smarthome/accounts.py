import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from pydantic import Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .api_dependencies import (
    MEMBER_KEY_PREFIX,
    OWNER_ID,
    ROOT_LOGIN,
    Account,
    get_session,
    key_digest,
    owner_account,
    require_account,
    require_owner,
)
from .db import lock_writes, upsert
from .models import AccountDashboardLayout, HouseholdDeviceKey, HouseholdMember, HouseholdOwner
from .schemas import Schema
from .service import commit

router = APIRouter(prefix="/api/v1/accounts", tags=["Household access"])
MemberId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
AccountId = Annotated[str, Path(pattern=r"^(owner|[0-9a-f]{32})$")]
KeyId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
PRIVATE = {"Cache-Control": "no-store"}


class NameInput(Schema):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def clean_name(cls, name: str) -> str:
        name = name.strip()
        if not name or not name.isprintable():
            raise ValueError("Name must be printable text")
        return name


class OwnerName(NameInput):
    login: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$")


class LoginInput(Schema):
    login: str = Field(min_length=1, max_length=40)


class MemberCreate(NameInput):
    login: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9._-]{2,39}$")
    device_name: str | None = Field(default=None, min_length=1, max_length=80)

    @field_validator("device_name")
    @classmethod
    def clean_device_name(cls, name: str | None) -> str | None:
        return cls.clean_name(name) if name is not None else None


class MemberRead(Schema):
    id: str
    name: str
    login: str
    key_available: bool


class MemberKey(Schema):
    access_key: str


class MemberIssued(MemberRead, MemberKey):
    key_id: str


class DeviceKeyRead(Schema):
    id: str
    name: str
    key_available: bool


def device_key_read(key: HouseholdDeviceKey) -> DeviceKeyRead:
    return DeviceKeyRead(id=key.id, name=key.name, key_available=key.sealed_key is not None)


def private(response: Response):
    response.headers.update(PRIVATE)


def member_read(member: HouseholdMember, session: Session) -> MemberRead:
    initial = session.get(HouseholdDeviceKey, member.id)
    return MemberRead(
        id=member.id, name=member.name, login=member.login or f"user-{member.id}",
        key_available=bool(initial and initial.sealed_key),
    )


def account_key_scope(account_id: str, account: Account) -> str | None:
    if account.role != "owner" and account.id != account_id:
        raise HTTPException(403, "You can only manage your own device keys")
    return None if account_id == OWNER_ID else account_id


def lock_access(session: Session, account: Account):
    lock_writes(session)
    if account.key_id and session.get(HouseholdDeviceKey, account.key_id) is None:
        raise HTTPException(401, "Missing or invalid X-API-Key")


def new_device_key(request: Request, key_id: str, member_id: str | None, name: str):
    token = MEMBER_KEY_PREFIX + secrets.token_urlsafe(32)
    try:
        sealed = request.app.state.account_key_vault.seal(key_id, token)
    except (OSError, ValueError):
        raise HTTPException(503, "User key storage is unavailable") from None
    return HouseholdDeviceKey(
        id=key_id, member_id=member_id, name=name, key_digest=key_digest(token), sealed_key=sealed,
    ), token


def reveal_key(key: HouseholdDeviceKey | None, request: Request, response: Response) -> MemberKey:
    if key is None or key.sealed_key is None:
        raise HTTPException(404, "This user key is unavailable", headers=PRIVATE)
    try:
        token = request.app.state.account_key_vault.reveal(key.id, key.sealed_key)
    except (OSError, ValueError):
        raise HTTPException(503, "User key storage is unavailable", headers=PRIVATE) from None
    private(response)
    return MemberKey(access_key=token)


@router.get("", response_model=list[MemberRead], dependencies=[Depends(require_owner)])
def list_members(response: Response, session: Session = Depends(get_session)):
    private(response)
    rows = session.scalars(select(HouseholdMember).order_by(HouseholdMember.name, HouseholdMember.id))
    return [member_read(member, session) for member in rows]


@router.post("", response_model=MemberIssued, status_code=201)
def create_member(
    body: MemberCreate, request: Request, response: Response,
    account: Account = Depends(require_owner), session: Session = Depends(get_session),
):
    lock_access(session, account)
    member_id = secrets.token_hex(16)
    login = body.login or f"user-{member_id}"
    reserved = {ROOT_LOGIN, owner_account(session).login.casefold()}
    if login in reserved or session.scalar(select(HouseholdMember.id).where(HouseholdMember.login == login)):
        raise HTTPException(409, "This login is already in use")
    initial, token = new_device_key(request, member_id, member_id, body.device_name or "")
    member = HouseholdMember(id=member_id, name=body.name, login=login, key_digest=initial.key_digest)
    session.add(member)
    session.flush()
    session.add(initial)
    commit(session)
    private(response)
    return MemberIssued(
        id=member_id, name=member.name, login=login, key_available=True, access_key=token, key_id=initial.id,
    )


@router.get("/me")
def current_account(response: Response, account: Account = Depends(require_account)):
    private(response)
    return account


@router.post("/login")
def verify_login(body: LoginInput, response: Response, account: Account = Depends(require_account)):
    accepted = {account.login.casefold()}
    if account.role == "owner":
        accepted.add(ROOT_LOGIN)
    if body.login.strip().casefold() not in accepted:
        raise HTTPException(401, "Missing or invalid X-API-Key", headers=PRIVATE)
    private(response)
    return account


@router.put("/owner")
def name_owner(
    body: OwnerName, response: Response, account: Account = Depends(require_owner),
    session: Session = Depends(get_session),
):
    lock_access(session, account)
    login = body.login or owner_account(session).login
    if session.scalar(select(HouseholdMember.id).where(HouseholdMember.login == login.casefold())):
        raise HTTPException(409, "This login is already in use")
    changes = {"name": body.name, "login": login}
    statement = upsert(session.get_bind(), HouseholdOwner).values(id=OWNER_ID, **changes)
    session.execute(statement.on_conflict_do_update(index_elements=[HouseholdOwner.id], set_=changes))
    commit(session)
    private(response)
    return owner_account(session, account.key_id)


@router.get("/{member_id}/key", response_model=MemberKey, dependencies=[Depends(require_owner)])
def reveal_member_key(member_id: MemberId, request: Request, response: Response, session: Session = Depends(get_session)):
    return reveal_key(session.get(HouseholdDeviceKey, member_id), request, response)


@router.delete("/{member_id}", status_code=204)
def revoke_member(
    member_id: MemberId, account: Account = Depends(require_owner), session: Session = Depends(get_session),
):
    lock_access(session, account)
    member = session.get(HouseholdMember, member_id)
    if member is None:
        raise HTTPException(404, "Household member was not found")
    session.delete(member)
    session.execute(delete(AccountDashboardLayout).where(AccountDashboardLayout.account_id == member.id))
    commit(session)
    return Response(status_code=204, headers=PRIVATE)


@router.get("/{account_id}/keys", response_model=list[DeviceKeyRead])
def list_device_keys(
    account_id: AccountId, response: Response, account: Account = Depends(require_account),
    session: Session = Depends(get_session),
):
    member_id = account_key_scope(account_id, account)
    private(response)
    rows = session.scalars(select(HouseholdDeviceKey).where(
        HouseholdDeviceKey.member_id == member_id,
    ).order_by(HouseholdDeviceKey.name, HouseholdDeviceKey.id))
    return [device_key_read(key) for key in rows]


@router.post("/{account_id}/keys", response_model=DeviceKeyRead, status_code=201)
def create_device_key(
    account_id: AccountId, body: NameInput, request: Request, response: Response,
    account: Account = Depends(require_account), session: Session = Depends(get_session),
):
    member_id = account_key_scope(account_id, account)
    lock_access(session, account)
    if member_id is not None and session.get(HouseholdMember, member_id) is None:
        raise HTTPException(404, "Household member was not found")
    key, _ = new_device_key(request, secrets.token_hex(16), member_id, body.name)
    session.add(key)
    commit(session)
    private(response)
    return device_key_read(key)


def get_device_key(session: Session, account_id: str, key_id: str, account: Account):
    member_id = account_key_scope(account_id, account)
    key = session.get(HouseholdDeviceKey, key_id)
    if key is None or key.member_id != member_id:
        raise HTTPException(404, "This user key is unavailable", headers=PRIVATE)
    return key


@router.get("/{account_id}/keys/{key_id}", response_model=MemberKey)
def reveal_device_key(
    account_id: AccountId, key_id: KeyId, request: Request, response: Response,
    account: Account = Depends(require_account), session: Session = Depends(get_session),
):
    return reveal_key(get_device_key(session, account_id, key_id, account), request, response)


@router.delete("/{account_id}/keys/{key_id}", status_code=204)
def revoke_device_key(
    account_id: AccountId, key_id: KeyId, account: Account = Depends(require_account),
    session: Session = Depends(get_session),
):
    lock_access(session, account)
    session.delete(get_device_key(session, account_id, key_id, account))
    commit(session)
    return Response(status_code=204, headers=PRIVATE)
