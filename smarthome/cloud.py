"""Optional official Device Sharing login. Tokens never leave the server."""

import io
import json
import logging
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import HTTPException

from .sharing_state import SharingState, missing_light_reading

INVENTORY_REFRESH_INTERVAL = 60
MISSING_LIGHT_REFRESH_INTERVAL = 60


class CloudBridge:
    def __init__(self, settings, login_factory=None, manager_factory=None, mq_factory=None):
        self.settings = settings
        self.path = Path(settings.cloud_session_path or (settings.database_path + ".cloud.json"))
        self.login_factory = login_factory
        self.manager_factory = manager_factory
        self.lock = threading.RLock()
        self.pending = {}
        self.auth = None
        self.saved_user_code = None
        self.manager = None
        self.next_inventory_refresh = 0.0
        self.next_light_refresh = {}
        self.next_room_lookup = {}
        self.state = SharingState(self, mq_factory)
        if settings.cloud_enabled and self.path.exists():
            if self.path.is_symlink():
                raise ValueError("Cloud session file must not be a symlink")
            with self.path.open() as stream:
                stored = json.load(stream)
            if not isinstance(stored, dict):
                raise ValueError("Invalid cloud session structure")
            if "saved_user_code" in stored:
                code = stored["saved_user_code"]
                if not isinstance(code, str) or not code.strip() or len(code) > 128:
                    raise ValueError("Invalid saved User Code")
                self.saved_user_code = code
            if set(stored) != {"saved_user_code"}:
                self._validate_auth(stored)
                self.auth = {key: value for key, value in stored.items() if key != "saved_user_code"}
            self.path.chmod(0o600)

    @property
    def login_user_code(self):
        return self.saved_user_code or (self.auth["user_code"] if self.auth else None)

    @property
    def saved_code_requires_login(self):
        return bool(self.login_user_code) and (
            self.auth is None or self.login_user_code != self.auth["user_code"]
        )

    def require_enabled(self):
        if not self.settings.cloud_enabled:
            raise HTTPException(
                503,
                "Cloud adapter is disabled; enable SMART_HOME_CLOUD_ENABLED and install the cloud extra",
            )
        if not self.settings.api_token:
            raise HTTPException(503, "Cloud login requires a configured SMART_HOME_API_TOKEN")

    def _factories(self):
        if self.login_factory and self.manager_factory:
            return self.login_factory, self.manager_factory
        try:
            from tuya_sharing import LoginControl, Manager
        except ImportError:
            raise HTTPException(
                503, "Install smart-home-service[cloud] to enable QR login"
            ) from None
        # SDK debug/error messages can include raw auth/device payloads.
        logging.getLogger("tuya_sharing").disabled = True
        return self.login_factory or LoginControl, self.manager_factory or Manager

    @staticmethod
    def _validate_auth(auth):
        required = {"user_code", "terminal_id", "endpoint", "token_info"}
        if not isinstance(auth, dict) or not required.issubset(auth):
            raise ValueError("Invalid cloud session structure")
        for field in ("user_code", "terminal_id"):
            if not isinstance(auth[field], str) or not auth[field] or len(auth[field]) > 4096:
                raise ValueError("Invalid cloud session fields")
        token = auth["token_info"]
        if not isinstance(token, dict) or not {
            "t",
            "uid",
            "expire_time",
            "access_token",
            "refresh_token",
        }.issubset(token):
            raise ValueError("Invalid cloud token structure")
        for name in ("access_token", "refresh_token", "uid"):
            if not isinstance(token[name], str) or not token[name] or len(token[name]) > 4096:
                raise ValueError("Invalid cloud token fields")
        url = urlsplit(auth["endpoint"])
        allowed = (
            "iotbing.com",
            "tuya.com",
            "tuyacn.com",
            "tuyaus.com",
            "tuyaeu.com",
            "tuyain.com",
        )
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.port not in (None, 443)
            or not any(
                url.hostname == host or url.hostname.endswith("." + host) for host in allowed
            )
        ):
            raise ValueError("Unexpected Tuya cloud endpoint")

    def _save(self):
        if self.auth is not None:
            self._validate_auth(self.auth)
        stored = dict(self.auth or {})
        if self.saved_user_code is not None:
            stored["saved_user_code"] = self.saved_user_code
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink():
            raise HTTPException(503, "Cloud session path must not be a symlink")
        fd, temporary = tempfile.mkstemp(prefix=".cloud-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(stored, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def save_user_code(self, user_code):
        self.require_enabled()
        with self.lock:
            previous = self.saved_user_code
            self.saved_user_code = user_code
            try:
                self._save()
            except Exception:
                self.saved_user_code = previous
                raise HTTPException(503, "User Code could not be saved securely") from None
            self.pending.clear()
            return {
                "has_saved_user_code": True,
                "connected": bool(self.auth),
                "saved_user_code_requires_login": self.saved_code_requires_login,
            }

    def begin_login(self, user_code=None):
        self.require_enabled()
        with self.lock:
            if user_code is None:
                user_code = self.login_user_code
            if user_code is None:
                raise HTTPException(422, "Enter User Code first; no saved code is available")
            now = time.time()
            self.pending = {
                key: value for key, value in self.pending.items() if value["expires"] > now
            }
            if len(self.pending) >= 8:
                raise HTTPException(429, "Too many pending QR logins")
            login_factory, _ = self._factories()
            login = login_factory()
            try:
                result = login.qr_code(
                    self.settings.cloud_client_id, self.settings.cloud_schema, user_code
                )
                if result.get("success") is not True:
                    raise ValueError("Login unavailable")
                qr = result["result"]["qrcode"]
                if not isinstance(qr, str) or not qr or len(qr) > 4096:
                    raise ValueError("Malformed QR")
            except Exception:
                raise HTTPException(
                    502, "Tuya QR request failed; check User Code and internet connection"
                ) from None
            id = secrets.token_urlsafe(24)
            self.pending[id] = {
                "user_code": user_code,
                "qr": qr,
                "login": login,
                "expires": now + 120,
            }
            return {
                "session_id": id,
                "qr_url": f"/api/v1/cloud/login/{id}/qr.svg",
                "expires_in": 120,
                "instruction": "Scan with Smart Life/Tuya Smart and approve login, then confirm this session",
            }

    def _pending(self, id):
        item = self.pending.get(id)
        if item is None:
            raise HTTPException(404, "Login session not found")
        if item["expires"] < time.time():
            self.pending.pop(id, None)
            raise HTTPException(410, "QR session expired; request a new QR code")
        return item

    def qr_svg(self, id):
        self.require_enabled()
        with self.lock:
            item = self._pending(id)
            try:
                import qrcode
                from qrcode.image.svg import SvgPathImage
            except ImportError:
                raise HTTPException(503, "Install the cloud extra for QR rendering") from None
            qr = qrcode.make("tuyaSmart--qrLogin?token=" + item["qr"], image_factory=SvgPathImage)
            output = io.BytesIO()
            qr.save(output)
            return output.getvalue()

    def confirm(self, id):
        self.require_enabled()
        with self.lock:
            item = self._pending(id)
            try:
                success, info = item["login"].login_result(
                    item["qr"], self.settings.cloud_client_id, item["user_code"]
                )
            except Exception:
                raise HTTPException(
                    502, "Tuya confirmation failed; check internet connection"
                ) from None
            if not success:
                raise HTTPException(
                    409,
                    "QR login is not approved or has expired; scan/approve or request another QR",
                )
            auth = {
                "user_code": item["user_code"],
                "terminal_id": info.get("terminal_id"),
                "endpoint": info.get("endpoint"),
                "token_info": {
                    key: info.get(key)
                    for key in ("t", "uid", "expire_time", "access_token", "refresh_token")
                },
            }
            try:
                self._validate_auth(auth)
            except (ValueError, TypeError):
                raise HTTPException(502, "Tuya returned invalid authorization data") from None
            previous = self.auth
            previous_code = self.saved_user_code
            self.auth = auth
            self.saved_user_code = auth["user_code"]
            try:
                self._save()
            except Exception:
                self.auth = previous
                self.saved_user_code = previous_code
                raise HTTPException(
                    503, "Cloud authorization could not be saved securely"
                ) from None
            self.state.stop()
            self.next_light_refresh.clear()
            self.next_room_lookup.clear()
            self.manager = None
            self.pending.clear()
            return {"connected": True, "tokens_stored_on_server": True}

    def _manager(self):
        self.require_enabled()
        if self.auth is None:
            raise HTTPException(409, "Complete QR login first")
        if self.manager is None:
            _, factory = self._factories()
            bridge = self
            authorization = self.auth

            class TokenListener:
                def update_token(self, token_info):
                    with bridge.lock:
                        if bridge.auth is not authorization:
                            return  # A late callback must not overwrite another account.
                        bridge.auth["token_info"] = dict(token_info)
                        bridge._save()

            self.manager = factory(
                self.settings.cloud_client_id,
                self.auth["user_code"],
                self.auth["terminal_id"],
                self.auth["endpoint"],
                self.auth["token_info"],
                TokenListener(),
            )
        return self.manager

    def devices(self, refresh=False):
        with self.lock:
            manager = self._manager()
            try:
                if refresh or not manager.device_map:
                    self.next_inventory_refresh = time.monotonic() + INVENTORY_REFRESH_INTERVAL
                    self.state.inventory(manager)
            except Exception:
                raise HTTPException(
                    502, "Tuya cloud device query failed; reauthenticate if needed"
                ) from None
            return list(manager.device_map.values())

    def schedule_inventory_refresh(self, background_tasks):
        with self.lock:
            now = time.monotonic()
            if self.auth is None or now < self.next_inventory_refresh:
                return
            self.next_inventory_refresh = now + INVENTORY_REFRESH_INTERVAL
            background_tasks.add_task(self._refresh_visible_inventory, self.auth)

    def _refresh_visible_inventory(self, authorization):
        with self.lock:
            if self.auth is not authorization:
                return
            try:
                self.devices(refresh=True)
            except HTTPException:
                # The next heartbeat can retry after the cooldown. Keep the cache.
                pass

    def schedule_missing_light_refresh(self, background_tasks, device):
        with self.lock:
            now = time.monotonic()
            if self.auth is None or now < self.next_light_refresh.get(device.id, 0) or not missing_light_reading(device):
                return
            self.next_light_refresh[device.id] = now + MISSING_LIGHT_REFRESH_INTERVAL
            background_tasks.add_task(self._refresh_visible_light, self.auth, device.id)

    def _refresh_visible_light(self, authorization, device_id):
        with self.lock:
            if self.auth is not authorization:
                return
            try:
                if missing_light_reading(self.device_status(device_id)):
                    self.device_status(device_id, refresh=True)
            except HTTPException:
                # Preserve the last report. A later watch can retry after the cooldown.
                pass

    def device(self, id, refresh=False):
        with self.lock:
            self.devices()
            device = self._manager().device_map.get(id)
            if device is None:
                raise HTTPException(404, "Device is not part of the authorized account")
            if refresh:
                return self.device_status(id, True)
            return device

    def writable_device(self, id):
        with self.lock:
            device = self.device(id)
            try:
                return self.state.definitions(self._manager(), device)
            except Exception:
                raise HTTPException(502, "Tuya device definitions query failed") from None

    def device_status(self, id, refresh=False):
        with self.lock:
            return self.state.status(self._manager(), self.device(id), refresh)

    def close(self):
        with self.lock:
            self.state.stop()
            self.next_light_refresh.clear()
            self.next_room_lookup.clear()

    def send_commands(self, id, commands):
        self.device(id)
        with self.lock:
            try:
                # Manager.send_commands discards the API response in SDK 0.2.15.
                # Use its public CustomerApi to check acknowledgement, without retries.
                result = self._manager().customer_api.post(
                    f"/v1.1/m/thing/{id}/commands", None, {"commands": commands}
                )
            except Exception as error:
                code = str(getattr(error, "error_code", ""))
                if code == "2001":
                    raise HTTPException(
                        409, "Устройство не в сети по данным Tuya (код 2001). Команда отклонена."
                    ) from None
                if code.isascii() and code.isdecimal() and len(code) <= 12:
                    raise HTTPException(502, f"Tuya rejected the cloud command (code {code})") from None
                raise HTTPException(
                    502, "Tuya cloud command failed; physical outcome may be unknown"
                ) from None
            if not isinstance(result, dict) or result.get("success") is not True:
                raise HTTPException(502, "Tuya did not acknowledge the cloud command")
            return {
                "device_id": id,
                "acknowledged": True,
                "source": "tuya_cloud",
                "state_confirmed": False,
            }

    def scenes(self):
        self.devices()
        with self.lock:
            try:
                scenes = self._manager().query_scenes()
            except Exception:
                raise HTTPException(502, "Tuya scene query failed") from None
            return [
                {
                    "id": s.scene_id,
                    "name": s.name,
                    "home_id": str(s.home_id),
                    "enabled": bool(s.enabled),
                }
                for s in scenes
            ]

    def logout(self):
        self.require_enabled()
        with self.lock:
            # Local deletion only. SDK unload() can revoke the shared HA terminal remotely.
            self.state.stop()
            self.next_light_refresh.clear()
            self.next_room_lookup.clear()
            if self.auth is not None:
                self.state.stored("clear")
            self.auth, self.saved_user_code, self.manager, self.pending = None, None, None, {}
            if self.path.exists() and not self.path.is_symlink():
                self.path.unlink()
            return {
                "connected": False,
                "local_session_removed": True,
                "remote_authorization_revoked": False,
            }
