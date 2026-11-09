from hashlib import sha256
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from PIL import Image, ImageOps
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .api_dependencies import authenticate, get_session
from .db import lock_writes, upsert
from .models import Room, RoomAppearance
from .schemas import PositiveID, Schema
from .service import commit, get_or_404

router = APIRouter(prefix="/api/v1/rooms", dependencies=[Depends(authenticate)], tags=["Rooms"])
IMAGE_FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
MAX_IMAGE_BYTES = 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000


class CardAppearance(Schema):
    card_opacity: int = Field(ge=65, le=100, strict=True)


class AppearanceRead(CardAppearance):
    background_version: str | None = None


def read_appearance(session: Session, room_id: int) -> AppearanceRead:
    item = session.get(RoomAppearance, room_id)
    return AppearanceRead.model_validate(item) if item else AppearanceRead(card_opacity=100)


def save_appearance(session: Session, room_id: int, **values) -> AppearanceRead:
    lock_writes(session)
    get_or_404(session, Room, room_id)
    statement = upsert(session.get_bind(), RoomAppearance).values(room_id=room_id, **values)
    session.execute(statement.on_conflict_do_update(index_elements=[RoomAppearance.room_id], set_=values))
    appearance = read_appearance(session, room_id)
    commit(session)
    return appearance


def normalize_background(raw: bytearray, image_format: str) -> bytes:
    try:
        with Image.open(BytesIO(raw), formats=[image_format]) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS or getattr(image, "n_frames", 1) != 1:
                raise ValueError("Unsupported image dimensions or animation")
            image = ImageOps.exif_transpose(image).convert("RGB")
            for size in (1920, 1024):
                image.thumbnail((size, size))
                output = BytesIO()
                image.save(output, format="JPEG", quality=82)
                if output.tell() <= MAX_IMAGE_BYTES:
                    return output.getvalue()
            raise ValueError("Normalized image exceeds maximum size")
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError) as error:
        raise HTTPException(422, "Invalid or unsupported background image") from error


@router.get("/{room_id}/appearance", response_model=AppearanceRead)
def get_appearance(room_id: PositiveID, session: Session = Depends(get_session)):
    get_or_404(session, Room, room_id)
    return read_appearance(session, room_id)


@router.patch("/{room_id}/appearance", response_model=AppearanceRead)
def set_opacity(room_id: PositiveID, body: CardAppearance, session: Session = Depends(get_session)):
    return save_appearance(session, room_id, card_opacity=body.card_opacity)


@router.get("/{room_id}/background", response_class=Response)
def get_background(room_id: PositiveID, session: Session = Depends(get_session)):
    background = session.scalar(select(RoomAppearance.background).where(RoomAppearance.room_id == room_id))
    if background is None:
        raise HTTPException(404, "Room background not found")
    return Response(background, media_type="image/jpeg", headers={
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-site",
        "X-Content-Type-Options": "nosniff",
    })


@router.put("/{room_id}/background", response_model=AppearanceRead)
async def upload_background(room_id: PositiveID, request: Request, session: Session = Depends(get_session)):
    content_type = request.headers.get("content-type", "").partition(";")[0].strip().lower()
    image_format = IMAGE_FORMATS.get(content_type)
    if image_format is None:
        raise HTTPException(415, "Use a JPEG, PNG, or WebP background image")
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Room background upload exceeds 1 MiB")
        raw.extend(chunk)
    background = await run_in_threadpool(normalize_background, raw, image_format)
    return await run_in_threadpool(
        save_appearance, session, room_id, background=background, background_version=sha256(background).hexdigest(),
    )


@router.delete("/{room_id}/background", response_model=AppearanceRead)
def remove_background(room_id: PositiveID, session: Session = Depends(get_session)):
    return save_appearance(session, room_id, background=None, background_version=None)
