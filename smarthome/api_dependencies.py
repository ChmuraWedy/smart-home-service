import hmac

from fastapi import Depends, HTTPException, Request
from fastapi.security import APIKeyHeader
from sqlalchemy.orm import Session


def get_session(request: Request):
    with Session(request.app.state.engine, expire_on_commit=False) as session:
        yield session


token_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def authenticate(request: Request, token: str | None = Depends(token_header)):
    expected = request.app.state.settings.api_token
    if expected and not hmac.compare_digest((token or "").encode(), expected.encode()):
        raise HTTPException(401, "Missing or invalid X-API-Key")
