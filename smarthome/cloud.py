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


class CloudBridge:
    def __init__(self, settings, login_factory=None, manager_factory=None):
        self.settings = settings
        self.path = Path(settings.cloud_session_path or (settings.database_path + ".cloud.json"))
        self.login_factory = login_factory
        self.manager_factory = manager_factory
        self.lock = threading.RLock()
        self.pending = {}
        self.auth = None
        self.manager = None
        if settings.cloud_enabled and self.path.exists():
            if self.path.is_symlink():
                raise ValueError("Cloud session file must not be a symlink")
            with self.path.open() as stream:
                self.auth = json.load(stream)
            self._validate_auth(self.auth)
            self.path.chmod(0o600)

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
        self._validate_auth(self.auth)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.path.is_symlink():
            raise HTTPException(503, "Cloud session path must not be a symlink")
        fd, temporary = tempfile.mkstemp(prefix=".cloud-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump(self.auth, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def begin_login(self, user_code):
        self.require_enabled()
        with self.lock:
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
            self.auth = auth
            try:
                self._save()
            except Exception:
                self.auth = previous
                raise HTTPException(
                    503, "Cloud authorization could not be saved securely"
                ) from None
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

            class TokenListener:
                def update_token(self, token_info):
                    with bridge.lock:
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
                    manager.update_device_cache()
            except Exception:
                raise HTTPException(
                    502, "Tuya cloud device query failed; reauthenticate if needed"
                ) from None
            return list(manager.device_map.values())

    def device(self, id, refresh=False):
        matches = [d for d in self.devices(refresh) if d.id == id]
        if not matches:
            raise HTTPException(404, "Device is not part of the authorized account")
        return matches[0]

    def send_commands(self, id, commands):
        self.device(id)
        with self.lock:
            try:
                # Manager.send_commands discards the API response in SDK 0.2.15.
                # Use its public CustomerApi to check acknowledgement, without retries.
                result = self._manager().customer_api.post(
                    f"/v1.1/m/thing/{id}/commands", None, {"commands": commands}
                )
            except Exception:
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
            self.auth, self.manager, self.pending = None, None, {}
            if self.path.exists() and not self.path.is_symlink():
                self.path.unlink()
            return {
                "connected": False,
                "local_session_removed": True,
                "remote_authorization_revoked": False,
            }
