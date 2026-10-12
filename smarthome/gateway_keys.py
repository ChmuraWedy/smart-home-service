"""Candidate keys from one authorized account; no inferred parent relationships."""

import time
from ipaddress import IPv4Network

from fastapi import HTTPException
from pydantic import SecretStr

from .models import Device
from .schemas import DeviceCreate
from .service import device_values

GATEWAY_CATEGORIES = {"wg", "wg2", "wgsxj", "lyqwg", "bywg", "dgnzk", "videohub"}
MAX_KEYS = 16
PROBE_SECONDS = 30
LAN_NETWORKS = tuple(IPv4Network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def candidates(devices, gateway_id):
    """Prefer the gateway and explicit children, then unlinked child candidates.

    A shared key never establishes a parent. An explicit different parent excludes
    a child, and gateways marked sub=True by Sharing are not child candidates.
    """
    ranked = []
    for device in devices:
        own = device.id == gateway_id
        parent = getattr(device, "gateway_id", None)
        if not own and (
            not getattr(device, "sub", False)
            or getattr(device, "category", None) in GATEWAY_CATEGORIES
            or (parent and parent != gateway_id)
        ):
            continue
        key = getattr(device, "local_key", None)
        if not isinstance(key, str) or len(key) != 16 or not key.isascii() or not key.isprintable():
            continue
        ranked.append((0 if own else 1 if parent == gateway_id else 2, device.id, key))
    result, seen = [], set()
    for _, source, key in sorted(ranked):
        if key not in seen:
            seen.add(key)
            result.append((source, key))
    if len(result) > MAX_KEYS:
        raise HTTPException(
            409,
            "Слишком много возможных ключей. Уточните шлюз в Smart Life или введите ключ вручную.",
        )
    return result


def validate_target(draft):
    if (
        not draft.is_gateway
        or draft.transport != "wifi"
        or draft.parent_id
        or draft.cid
        or not draft.enabled
        or not draft.ip
        or not any(draft.ip in network for network in LAN_NETWORKS)
    ):
        raise HTTPException(
            422,
            "Для проверки шлюза нужен его IP в домашней сети (10.x, 172.16–31.x или 192.168.x).",
        )
    if draft.version not in (None, "3.3", "3.4", "3.5"):
        raise HTTPException(
            422, "Поиск ключа поддерживает протоколы 3.3–3.5. Ответ 3.1 не подтверждает ключ."
        )


def discover(controller, draft, pool, clock=time.monotonic):
    if not pool:
        raise HTTPException(
            409,
            "Smart Life не передал подходящих ключей. Обновите список устройств или введите ключ вручную.",
        )
    versions = list(dict.fromkeys([draft.version or "3.5", "3.5", "3.4", "3.3"]))
    deadline = clock() + PROBE_SECONDS
    for source, key in pool:
        for version in versions:
            if clock() >= deadline:
                raise HTTPException(
                    504,
                    "Время проверки истекло. Проверьте IP и доступность шлюза, затем повторите.",
                )
            verified = DeviceCreate.model_validate(
                {
                    **draft.model_dump(),
                    "version": version,
                    "local_key": SecretStr(key),
                }
            )
            target = Device(**{k: v for k, v in device_values(verified).items() if k != "aliases"})
            if controller.verify_gateway_key(target):
                return verified, source
    raise HTTPException(
        409,
        "Ни один ключ не подтверждён. Проверьте IP шлюза и его доступность в домашней сети. Можно ввести ключ вручную.",
    )
