import unicodedata

from fastapi import HTTPException
from sqlalchemy import or_, select


def fold_name(value: str) -> str:
    """Use the same Unicode normalization for stored names and search inputs."""
    return unicodedata.normalize("NFC", value).strip().casefold()


def name_filters(query, model, *, name=None, q=None):
    folded_column = model.folded_name
    if name is not None:
        query = query.where(folded_column == fold_name(name))
    if q is not None:
        # Escape LIKE wildcards so search terms match literally.
        query = query.where(folded_column.contains(fold_name(q), autoescape=True))
    return query


def alias_filters(query, model, alias):
    from .service import ALIAS_MODELS

    alias_model, owner_field = ALIAS_MODELS[model]
    owners = select(getattr(alias_model, owner_field)).where(alias_model.alias == fold_name(alias))
    return query.where(
        or_(model.folded_name == fold_name(alias), model.id.in_(owners))
    )


def unique_match(session, model, query, **scopes):
    allowed_scopes = {"building_id", "room_id", "parent_id", "device_type_id"}
    for key, value in scopes.items():
        if value is not None:
            if key not in allowed_scopes or not hasattr(model, key):
                raise HTTPException(422, "Location/type scope is not supported for this resource")
            query = query.where(getattr(model, key) == value)
    items = session.scalars(query.order_by(model.id).limit(21)).all()
    if not items:
        raise HTTPException(404, f"{model.__name__} not found")
    if len(items) > 1:
        fields = ("id", "name", "building_id", "room_id", "parent_id", "device_type_id")
        matches = [
            {key: getattr(item, key) for key in fields if hasattr(item, key)} for item in items[:20]
        ]
        raise HTTPException(
            409,
            {
                "message": "Name/alias matches multiple objects; narrow the lookup scope or use an ID",
                "matches": matches,
                "more_matches": len(items) > 20,
            },
        )
    return items[0]


def get_by_name(session, model, name: str, **scopes):
    return unique_match(session, model, name_filters(select(model), model, name=name), **scopes)


def get_by_alias(session, model, alias: str, **scopes):
    return unique_match(session, model, alias_filters(select(model), model, alias), **scopes)
