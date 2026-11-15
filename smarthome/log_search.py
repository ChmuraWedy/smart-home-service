"""Owner-only handoff to the log console; application keys never enter its URLs."""

import hashlib
import hmac
import secrets
import time
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from .api_dependencies import require_owner

router = APIRouter(prefix="/api/v1/log-search", tags=["Log search"])
COOKIE = "__Secure-home_logs"
PRIVATE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
TICKET_TTL = 60
SESSION_TTL = 1800


def settings(request):
    value = request.app.state.settings
    if not value.log_search_url or not value.api_token:
        raise HTTPException(404, "Log search is unavailable", headers=PRIVATE)
    return value


def sign(config, purpose, payload):
    message = f"home-log-search:v1:{config.log_search_url}:{purpose}:{payload}".encode()
    return hmac.new(config.api_token.encode(), message, hashlib.sha256).hexdigest()


def issue(config, purpose, ttl):
    payload = f"{int(time.time()) + ttl}.{secrets.token_hex(16)}"
    return f"{payload}.{sign(config, purpose, payload)}"


def valid(config, purpose, token, ttl):
    try:
        if not isinstance(token, str) or len(token) > 160:
            return False
        expiry, nonce, signature = token.split(".")
        payload = f"{expiry}.{nonce}"
        return (
            len(nonce) == 32 and 0 < int(expiry) - time.time() <= ttl
            and hmac.compare_digest(signature, sign(config, purpose, payload))
        )
    except (ValueError, TypeError):
        return False


@router.post("/ticket", dependencies=[Depends(require_owner)])
def ticket(request: Request, response: Response):
    config = settings(request)
    response.headers.update(PRIVATE)
    return {"url": config.log_search_url + "/session", "ticket": issue(config, "ticket", TICKET_TTL)}


@router.post("/session", include_in_schema=False)
async def session(request: Request):
    config = settings(request)
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/x-www-form-urlencoded":
        raise HTTPException(415, "Expected a log sign-in form", headers=PRIVATE)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 1024:
            raise HTTPException(413, "Log sign-in form is too large", headers=PRIVATE)
    try:
        values = parse_qs(body.decode("ascii"), max_num_fields=2, strict_parsing=True)
        token, = values.get("ticket", [])
    except (ValueError, UnicodeError):
        token = None
    if not valid(config, "ticket", token, TICKET_TTL):
        raise HTTPException(401, "Log sign-in expired. Open Log search from the app menu again.", headers=PRIVATE)
    response = RedirectResponse(config.log_search_url + "/select/vmui/", status_code=303, headers=PRIVATE)
    response.set_cookie(COOKIE, issue(config, "session", SESSION_TTL), max_age=SESSION_TTL,
                        path="/select/", secure=True, httponly=True, samesite="lax")
    return response


@router.get("/authorize", include_in_schema=False)
def authorize(request: Request):
    config = settings(request)
    if not valid(config, "session", request.cookies.get(COOKIE), SESSION_TTL):
        raise HTTPException(401, "Log sign-in required", headers=PRIVATE)
    return Response(status_code=204, headers=PRIVATE)
