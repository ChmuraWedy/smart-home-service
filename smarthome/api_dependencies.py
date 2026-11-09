import hmac

from fastapi import Depends, HTTPException, Request
from fastapi.security import APIKeyHeader
from sqlalchemy.orm import Session

from .assistant_sessions import CHAT_ROUTES, SESSION_PREFIX, fingerprint


def get_session(request: Request):
    with Session(request.app.state.engine, expire_on_commit=False) as session:
        yield session


token_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def authenticate(request: Request, token: str | None = Depends(token_header)):
    settings = request.app.state.settings
    expected = settings.api_token
    if not expected and settings.setup_code:
        raise HTTPException(503, "Complete first-time key setup before using the service.")
    if not expected or hmac.compare_digest((token or "").encode(), expected.encode()):
        return
    if token and token.startswith(SESSION_PREFIX):
        credential = request.app.state.assistant_sessions.resolve(token)
        if credential and hmac.compare_digest(credential, fingerprint(expected)):
            route = getattr(request.scope.get("route"), "path", None)
            if route not in CHAT_ROUTES.get(request.method, ()):
                raise HTTPException(403, "This action is unavailable in AI chat")
            return
    raise HTTPException(401, "Missing or invalid X-API-Key")
