from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from .api_dependencies import authenticate

router = APIRouter(prefix="/api/v1/assistant", dependencies=[Depends(authenticate)], tags=["Assistant"])


class ChatEmbed(BaseModel):
    url: str | None


@router.get("/embed", response_model=ChatEmbed)
def chat_embed(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return ChatEmbed(url=request.app.state.settings.ai_chat_embed_url or None)
