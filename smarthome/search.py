import unicodedata

from fastapi import HTTPException
from sqlalchemy import func, select


def fold_name(value: str) -> str:
    """Unicode-aware search, including Cyrillic; no SQLite ASCII-only LIKE/NOCASE."""
    return unicodedata.normalize("NFC", value).strip().casefold()


def name_filters(query, model, *, name=None, q=None):
    folded_column = func.unicode_casefold(model.name)
    if name is not None:
        query = query.where(folded_column == fold_name(name))
    if q is not None:
        # instr treats %, _ and quotes literally and all input remains bound parameters.
        query = query.where(func.instr(folded_column, fold_name(q)) > 0)
    return query


def get_by_name(session, model, name: str, **scopes):
    query = name_filters(select(model), model, name=name)
    allowed_scopes = {"building_id", "room_id", "parent_id", "device_type_id"}
    for key, value in scopes.items():
        if value is not None:
            if key not in allowed_scopes or not hasattr(model, key):
                raise HTTPException(422, "Location/type scope is not supported for this resource")
            query = query.where(getattr(model, key) == value)
    items = session.scalars(query.order_by(model.id).limit(21)).all()
    if not items:
        raise HTTPException(404, f"{model.__name__} name not found")
    if len(items) > 1:
        fields = ("id", "name", "building_id", "room_id", "parent_id", "device_type_id")
        matches = [
            {key: getattr(item, key) for key in fields if hasattr(item, key)} for item in items[:20]
        ]
        raise HTTPException(
            409,
            {
                "message": "Name matches multiple objects; narrow the lookup scope or use an alias/ID",
                "matches": matches,
                "more_matches": len(items) > 20,
            },
        )
    return items[0]
