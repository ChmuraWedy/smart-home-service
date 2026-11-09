"""Opt-in, one-time provisioning of the first service access key."""
import hmac
import os
from dataclasses import replace
from pathlib import Path
from secrets import token_urlsafe
from tempfile import NamedTemporaryFile
from threading import Lock

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, SecretStr

from .config import Settings

router = APIRouter(prefix="/api/v1/setup", tags=["Setup"])
provisioning_lock = Lock()
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


class SetupRequest(BaseModel):
    setup_code: SecretStr


class SetupAvailability(BaseModel):
    can_initialize: bool


class SetupResult(BaseModel):
    access_key: str


def managed_key_path(settings: Settings) -> Path:
    return Path(settings.database_path + ".access-key")


def load_managed_key(settings: Settings) -> Settings:
    if settings.api_token:
        return settings
    try:
        key = managed_key_path(settings).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return settings
    if len(key) != 43 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in key):
        raise RuntimeError("Invalid managed service access key file")
    return replace(settings, api_token=key)


def secure_setup(request: Request) -> bool:
    return request.url.scheme == "https" or bool(
        request.client and request.client.host in LOOPBACK and request.url.hostname in LOOPBACK
    )


@router.get("", response_model=SetupAvailability)
def setup_status(request: Request, response: Response):
    settings = request.app.state.settings
    response.headers["Cache-Control"] = "no-store"
    return SetupAvailability(can_initialize=bool(
        settings.setup_code and not settings.api_token and secure_setup(request)
    ))


@router.post("", status_code=201, response_model=SetupResult)
def initialize_setup(body: SetupRequest, request: Request, response: Response):
    if not secure_setup(request):
        raise HTTPException(403, "First-time key setup requires HTTPS or localhost.")
    with provisioning_lock:
        settings = request.app.state.settings
        if settings.api_token or not settings.setup_code:
            raise HTTPException(409, "First-time key setup is unavailable.")
        if not hmac.compare_digest(body.setup_code.get_secret_value().encode(), settings.setup_code.encode()):
            raise HTTPException(403, "Invalid setup code.")
        key = token_urlsafe(32)
        destination = managed_key_path(settings)
        with NamedTemporaryFile(dir=destination.parent, mode="w", encoding="utf-8") as draft:
            draft.write(key + "\n")
            draft.flush()
            os.fsync(draft.fileno())
            try:
                os.link(draft.name, destination)
            except FileExistsError:
                raise HTTPException(409, "First-time key setup is unavailable.") from None
        settings = replace(settings, api_token=key)
        request.app.state.cloud.settings = settings
        request.app.state.developer_cloud.settings = settings
        request.app.state.settings = settings
    response.headers["Cache-Control"] = "no-store"
    return SetupResult(access_key=key)
