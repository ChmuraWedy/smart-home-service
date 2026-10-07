"""Independent Tuya Developer authorization; secrets stay on the server.

The small HTTPS client uses the standard library and Tuya's HMAC-SHA256
signature. It never retries a command or follows HTTP redirects.
"""

import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import HTTPException

REGIONS = {
    "eu": "openapi.tuyaeu.com",
    "eu-w": "openapi-weaz.tuyaeu.com",
    "us": "openapi.tuyaus.com",
    "us-e": "openapi-ueaz.tuyaus.com",
    "cn": "openapi.tuyacn.com",
    "in": "openapi.tuyain.com",
    "sg": "openapi-sg.iotbing.com",
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signature(
    access_id, secret, timestamp, method, path, body=b"", token="", nonce="", signed_headers=""
):
    string_to_sign = f"{method}\n{hashlib.sha256(body).hexdigest()}\n{signed_headers}\n{path}"
    message = access_id + token + timestamp + nonce + string_to_sign
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest().upper()


class DeveloperClient:
    def __init__(self, credentials, timeout=10, opener=None):
        self.credentials = dict(credentials)
        self.timeout = timeout
        self.opener = opener or build_opener(NoRedirect())
        self.token = None
        self.expires = 0

    def authenticate(self):
        result = self.request("GET", "/v1.0/token", query={"grant_type": "1"}, token_request=True)
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("access_token"), str)
            or not result["access_token"]
            or type(result.get("expire_time")) is not int
            or result["expire_time"] <= 0
        ):
            raise ValueError("Invalid token response")
        self.token = result["access_token"]
        self.expires = time.monotonic() + max(1, result["expire_time"] - 30)

    def request(self, method, path, query=None, body=None, token_request=False):
        if not token_request and (not self.token or time.monotonic() >= self.expires):
            self.authenticate()
        pairs = sorted((key, str(value)) for key, value in (query or {}).items())
        # Tuya signs the sorted query before URL encoding, as in TinyTuya Cloud.
        sign_path = path + ("?" + "&".join(f"{k}={v}" for k, v in pairs) if pairs else "")
        url_path = path + ("?" + urlencode(pairs) if pairs else "")
        payload = (
            b""
            if body is None
            else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        )
        timestamp = str(int(time.time() * 1000))
        nonce = secrets.token_hex(16)
        access_id = self.credentials["access_id"]
        token = "" if token_request else self.token
        headers = {
            "client_id": access_id,
            "t": timestamp,
            "sign_method": "HMAC-SHA256",
            "nonce": nonce,
            "sign": signature(
                access_id,
                self.credentials["access_secret"],
                timestamp,
                method,
                sign_path,
                payload,
                token,
                nonce,
            ),
            "Content-Type": "application/json",
        }
        if token:
            headers["access_token"] = token
        request = Request(
            "https://" + REGIONS[self.credentials["region"]] + url_path,
            data=payload if body is not None else None,
            headers=headers,
            method=method,
        )
        with self.opener.open(request, timeout=self.timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Cloud response too large")
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("success") is not True or "result" not in data:
            if isinstance(data, dict) and str(data.get("code")) in {"1010", "1011"}:
                self.token = None
            raise ValueError("Tuya rejected request")
        return data["result"]

    def devices(self):
        sample = self.credentials.get("sample_device_id")
        if sample:
            detail = self.request("GET", "/v1.0/devices/" + quote(sample, safe=""))
            if (
                not isinstance(detail, dict)
                or not isinstance(detail.get("uid"), str)
                or not detail["uid"]
            ):
                raise ValueError("Missing account UID")
            return self.request("GET", "/v1.0/users/" + quote(detail["uid"], safe="") + "/devices")
        rows, cursor, seen = [], None, set()
        for _ in range(200):
            query = {"size": 50}
            if cursor:
                query["last_row_key"] = cursor
            page = self.request("GET", "/v1.0/iot-01/associated-users/devices", query=query)
            if not isinstance(page, dict) or not isinstance(page.get("devices"), list):
                raise ValueError("Invalid device page")
            rows.extend(page["devices"])
            if not page.get("has_more"):
                return rows
            cursor = page.get("last_row_key")
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise ValueError("Invalid pagination cursor")
            seen.add(cursor)
        raise ValueError("Too many device pages")


def device_record(row):
    if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
        raise ValueError("Invalid device record")
    values = {
        key: row.get(key)
        for key in (
            "id",
            "name",
            "category",
            "product_id",
            "local_key",
            "ip",
            "node_id",
            "gateway_id",
            "update_time",
        )
    }
    values.update(
        online=row.get("online") is True,
        sub=row.get("sub") is True,
        support_local=bool(row.get("local_key")),
        function={},
        status={},
    )
    return SimpleNamespace(**values)


class DeveloperBridge:
    def __init__(self, settings, client_factory=DeveloperClient):
        self.settings, self.client_factory = settings, client_factory
        sharing_path = Path(settings.cloud_session_path or (settings.database_path + ".cloud.json"))
        self.path = Path(settings.developer_session_path or (str(sharing_path) + ".developer.json"))
        if self.path.resolve() == sharing_path.resolve():
            raise ValueError("Developer and QR credentials must use different files")
        self.lock = threading.RLock()
        self.credentials, self.client, self.cache = None, None, None
        if settings.cloud_enabled and self.path.exists():
            if self.path.is_symlink():
                raise ValueError("Developer credential file must not be a symlink")
            try:
                stored = json.loads(self.path.read_text())
                self.validate_credentials(stored)
            except (ValueError, TypeError):
                raise ValueError("Invalid Developer credentials file") from None
            self.credentials = stored
            self.path.chmod(0o600)

    @staticmethod
    def validate_credentials(values):
        if not isinstance(values, dict) or set(values) != {
            "access_id",
            "access_secret",
            "region",
            "sample_device_id",
        }:
            raise ValueError("Invalid credentials")
        for key in ("access_id", "access_secret"):
            value = values[key]
            if (
                not isinstance(value, str)
                or not 1 <= len(value) <= 256
                or any(c.isspace() or not c.isprintable() for c in value)
            ):
                raise ValueError("Invalid credentials")
        if values["region"] not in REGIONS:
            raise ValueError("Invalid region")
        sample = values["sample_device_id"]
        if sample is not None and (
            not isinstance(sample, str)
            or not 1 <= len(sample) <= 128
            or any(c.isspace() for c in sample)
        ):
            raise ValueError("Invalid device ID")

    def require_enabled(self):
        if not self.settings.cloud_enabled:
            raise HTTPException(503, "Enable SMART_HOME_CLOUD_ENABLED for Developer login")
        if not self.settings.api_token:
            raise HTTPException(503, "Developer login requires a configured SMART_HOME_API_TOKEN")

    def status(self):
        with self.lock:
            return {
                "enabled": self.settings.cloud_enabled,
                "configured": self.credentials is not None,
                "connected": self.client is not None,
                "region": self.credentials["region"] if self.credentials else None,
                "has_sample_device_id": bool(
                    self.credentials and self.credentials.get("sample_device_id")
                ),
                "transport": "internet",
                "scene_edit_supported": False,
            }

    def save_credentials(self, values):
        self.require_enabled()
        self.validate_credentials(values)
        with self.lock:
            temporary = None
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if self.path.is_symlink():
                    raise ValueError("Symlink path")
                fd, temporary = tempfile.mkstemp(prefix=".developer-", dir=self.path.parent)
                with os.fdopen(fd, "w") as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    json.dump(values, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            except Exception:
                raise HTTPException(
                    503, "Developer credentials could not be saved securely"
                ) from None
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
            self.credentials, self.client, self.cache = dict(values), None, None
            return self.status()

    def connect(self):
        self.require_enabled()
        with self.lock:
            if self.credentials is None:
                raise HTTPException(409, "Save Access ID and Access Secret first")
            try:
                client = self.client_factory(self.credentials, timeout=self.settings.cloud_timeout)
                client.authenticate()
                rows = self.normalize_devices(client.devices())
            except Exception:
                raise HTTPException(
                    502,
                    "Developer connection failed; check credentials, project region, linked app account and API permissions",
                ) from None
            self.client, self.cache = client, rows
            return {**self.status(), "device_count": len(rows)}

    @staticmethod
    def normalize_devices(rows):
        if not isinstance(rows, list) or len(rows) > 10000:
            raise ValueError("Invalid device list")
        result = [device_record(row) for row in rows]
        if len({d.id for d in result}) != len(result):
            raise ValueError("Duplicate device ID")
        return result

    def _client(self):
        self.require_enabled()
        if self.client is None:
            raise HTTPException(409, "Connect the saved Developer credentials first")
        return self.client

    def devices(self, refresh=False):
        with self.lock:
            client = self._client()
            if refresh or self.cache is None:
                try:
                    self.cache = self.normalize_devices(client.devices())
                except Exception:
                    raise HTTPException(
                        502,
                        "Developer device query failed; check project access and internet connection",
                    ) from None
            return self.cache

    def device(self, id, refresh=False):
        with self.lock:
            for device in self.devices(refresh):
                if device.id == id:
                    return device
            raise HTTPException(404, "Device is not part of the connected Developer inventory")

    def _request(self, method, path, **kwargs):
        try:
            return self._client().request(method, path, **kwargs)
        except HTTPException:
            raise
        except Exception:
            message = (
                "Developer cloud command failed; physical outcome may be unknown"
                if method == "POST"
                else "Developer cloud query failed; check project API permissions"
            )
            raise HTTPException(502, message) from None

    def device_status(self, id, refresh=False):
        with self.lock:
            device = self.device(id, refresh)
            rows = self._request("GET", "/v1.0/iot-03/devices/" + quote(id, safe="") + "/status")
            if not isinstance(rows, list) or any(
                not isinstance(row, dict)
                or not isinstance(row.get("code"), str)
                or "value" not in row
                for row in rows
            ):
                raise HTTPException(502, "Developer returned invalid device status")
            device.status = {row["code"]: row["value"] for row in rows}
            return device

    def writable_device(self, id):
        with self.lock:
            device = self.device(id)
            result = self._request(
                "GET", "/v1.0/iot-03/devices/" + quote(id, safe="") + "/functions"
            )
            rows = result.get("functions") if isinstance(result, dict) else None
            if not isinstance(rows, list):
                raise HTTPException(502, "Developer returned invalid device functions")
            functions = {}
            types = {
                "bool": "Boolean",
                "value": "Integer",
                "enum": "Enum",
                "string": "String",
                "json": "Json",
            }
            for row in rows:
                if (
                    not isinstance(row, dict)
                    or not isinstance(row.get("code"), str)
                    or not isinstance(row.get("type"), str)
                ):
                    raise HTTPException(502, "Developer returned invalid device function")
                values = row.get("values") or "{}"
                functions[row["code"]] = SimpleNamespace(
                    code=row["code"],
                    type=types.get(row["type"], row["type"]),
                    values=json.dumps(values) if isinstance(values, dict) else values,
                )
            device.function = functions
            return device

    def send_commands(self, id, commands):
        with self.lock:
            self.device(id)
            result = self._request(
                "POST",
                "/v1.0/iot-03/devices/" + quote(id, safe="") + "/commands",
                body={"commands": commands},
            )
            if result is not True:
                raise HTTPException(502, "Tuya did not acknowledge the Developer cloud command")
            return {
                "device_id": id,
                "acknowledged": True,
                "source": "tuya_developer_cloud",
                "state_confirmed": False,
            }

    def logout(self):
        self.require_enabled()
        with self.lock:
            try:
                if self.path.is_symlink():
                    raise ValueError("Symlink path")
                self.path.unlink(missing_ok=True)
            except Exception:
                raise HTTPException(503, "Developer credentials could not be removed") from None
            self.credentials, self.client, self.cache = None, None, None
            return {
                **self.status(),
                "local_credentials_removed": True,
                "remote_authorization_revoked": False,
            }
