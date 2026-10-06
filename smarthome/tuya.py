import hashlib
import socket
import threading
from contextlib import contextmanager

import tinytuya
from fastapi import HTTPException

from .models import Device


class TuyaController:
    """One connection per command; commands for a gateway and its children are serialized.

    Locks are bounded in memory and process-local. Run exactly one Uvicorn worker.
    A shared connection across commands needs a receive loop and heartbeat management;
    it is deliberately not used in this first lightweight implementation.
    """

    def __init__(self, settings, device_factory=None):
        self.settings = settings
        self.device_factory = device_factory or tinytuya.Device
        self._locks = tuple(threading.Lock() for _ in range(64))

    @contextmanager
    def connection(self, device: Device, parent: Device | None):
        root = parent or device
        if not device.enabled or not root.enabled:
            raise HTTPException(409, "Device or parent gateway is disabled")
        if not root.ip or not root.local_key or not root.version:
            raise HTTPException(
                409, "Direct device/gateway requires ip, local_key and version before control"
            )
        if device.transport == "zigbee" and (parent is None or not device.cid):
            raise HTTPException(409, "Zigbee child requires a parent gateway and cid")
        lock_index = int.from_bytes(
            hashlib.sha256(root.device_id.encode()).digest()[:2], "big"
        ) % len(self._locks)
        lock = self._locks[lock_index]
        if not lock.acquire(timeout=self.settings.lock_timeout):
            raise HTTPException(503, "Device/gateway is busy; retry later")
        connection = None
        try:
            connection = self.device_factory(
                root.device_id,
                root.ip,
                root.local_key,
                version=float(root.version),
                connection_timeout=self.settings.tuya_timeout,
                connection_retry_limit=1,
                connection_retry_delay=0,
                persist=True,
            )
            connection.set_retry(False)
            target = connection
            if parent is not None:
                # Child's IP/key/version are intentionally not used. TinyTuya inherits
                # transport, encryption and protocol framing from the actual parent.
                target = self.device_factory(device.device_id, parent=connection, cid=device.cid)
            yield target
        finally:
            try:
                if connection is not None:
                    connection.close()
            finally:
                lock.release()

    def execute(self, device, parent, *, dps=None):
        try:
            with self.connection(device, parent) as target:
                result = target.status() if dps is None else target.set_multiple_values(dps)
        except HTTPException:
            raise
        except (TimeoutError, socket.timeout):
            raise HTTPException(
                504, "Tuya device/gateway timed out; command outcome may be unknown"
            ) from None
        except Exception:
            # TinyTuya exceptions and Payload fields can contain credentials; never echo them.
            raise HTTPException(
                502, "Tuya communication failed; verify gateway/IP/key/version/cid"
            ) from None
        if result is None:
            raise HTTPException(504, "No Tuya acknowledgement; command outcome may be unknown")
        if not isinstance(result, dict):
            raise HTTPException(502, "Unexpected Tuya response")
        data = result.get("data") if isinstance(result.get("data"), dict) else result
        if any(name in result or name in data for name in ("Error", "Err")):
            raise HTTPException(502, "Tuya reported an error; verify connectivity/key/version/cid")
        response_cid = data.get("cid", result.get("cid"))
        if parent is not None and response_cid is not None and response_cid != device.cid:
            raise HTTPException(502, "Gateway returned a response for a different child")
        observed_dps = data.get("dps", result.get("dps"))
        if dps is None and (not isinstance(observed_dps, dict) or not observed_dps):
            raise HTTPException(
                502, "No DPS in status response; child may be sleeping or not pollable"
            )
        if observed_dps is not None and not isinstance(observed_dps, dict):
            raise HTTPException(502, "Malformed Tuya DPS response")
        return observed_dps or {}
