from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .api_dependencies import authenticate
from .assistant_sessions import fingerprint

router = APIRouter(prefix="/api/v1/assistant", tags=["Assistant"])


class ChatEmbed(BaseModel):
    url: str | None
    ticket: str | None


class ChatTicket(BaseModel):
    ticket: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class ChatSession(BaseModel):
    key: str


@router.post("/embed", response_model=ChatEmbed, dependencies=[Depends(authenticate)])
def chat_embed(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    url = request.app.state.settings.ai_chat_embed_url
    if not url:
        return ChatEmbed(url=None, ticket=None)
    key = request.app.state.settings.api_token
    if not key:
        raise HTTPException(403, "Set a service access key to use AI chat.")
    ticket = request.app.state.assistant_sessions.issue_ticket(fingerprint(key))
    return ChatEmbed(url=url, ticket=ticket)


@router.post("/session", response_model=ChatSession)
def redeem_chat_ticket(ticket: ChatTicket, request: Request, response: Response):
    key = request.app.state.assistant_sessions.redeem(ticket.ticket)
    if not key:
        raise HTTPException(401, "Chat sign-in expired. Reopen AI chat.")
    response.headers["Cache-Control"] = "no-store"
    return ChatSession(key=key)
