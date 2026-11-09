import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response
from pydantic import Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .api_dependencies import MEMBER_KEY_PREFIX, get_session, key_digest, require_owner
from .models import AccountDashboardLayout, HouseholdMember
from .schemas import Schema
from .service import commit

router = APIRouter(prefix="/api/v1/accounts", tags=["Household access"], dependencies=[Depends(require_owner)])
MemberId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]


class MemberCreate(Schema):
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def clean_name(cls, name: str) -> str:
        name = name.strip()
        if not name or not name.isprintable():
            raise ValueError("Member name must be printable text")
        return name


class MemberRead(Schema):
    id: str
    name: str
    key_available: bool


class MemberKey(Schema):
    access_key: str


class MemberIssued(MemberRead, MemberKey):
    pass


@router.get("", response_model=list[MemberRead])
def list_members(response: Response, session: Session = Depends(get_session)):
    response.headers["Cache-Control"] = "no-store"
    return session.scalars(select(HouseholdMember).order_by(HouseholdMember.name, HouseholdMember.id)).all()


@router.post("", response_model=MemberIssued, status_code=201)
def create_member(body: MemberCreate, request: Request, response: Response, session: Session = Depends(get_session)):
    token = MEMBER_KEY_PREFIX + secrets.token_urlsafe(32)
    member_id = secrets.token_hex(16)
    try:
        sealed = request.app.state.account_key_vault.seal(member_id, token)
    except (OSError, ValueError):
        raise HTTPException(503, "User key storage is unavailable") from None
    member = HouseholdMember(id=member_id, name=body.name, key_digest=key_digest(token), sealed_key=sealed)
    session.add(member)
    commit(session)
    response.headers["Cache-Control"] = "no-store"
    return MemberIssued(id=member.id, name=member.name, key_available=True, access_key=token)


@router.get("/{member_id}/key", response_model=MemberKey)
def reveal_member_key(member_id: MemberId, request: Request, response: Response, session: Session = Depends(get_session)):
    member = session.get(HouseholdMember, member_id)
    if member is None or member.sealed_key is None:
        raise HTTPException(404, "This user key is unavailable", headers={"Cache-Control": "no-store"})
    try:
        token = request.app.state.account_key_vault.reveal(member_id, member.sealed_key)
    except (OSError, ValueError):
        raise HTTPException(503, "User key storage is unavailable", headers={"Cache-Control": "no-store"}) from None
    response.headers["Cache-Control"] = "no-store"
    return MemberKey(access_key=token)


@router.delete("/{member_id}", status_code=204)
def revoke_member(member_id: MemberId, session: Session = Depends(get_session)):
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    member = session.get(HouseholdMember, member_id)
    if member is None:
        raise HTTPException(404, "Household member was not found")
    session.delete(member)
    session.execute(delete(AccountDashboardLayout).where(AccountDashboardLayout.account_id == member.id))
    commit(session)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
