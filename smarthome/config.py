import os
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    database_path: str = field(
        default_factory=lambda: os.getenv("SMART_HOME_DB", "./data/smarthome.db")
    )
    api_token: str = field(
        default_factory=lambda: os.getenv("SMART_HOME_API_TOKEN", ""), repr=False
    )
    tuya_timeout: float = field(
        default_factory=lambda: float(os.getenv("SMART_HOME_TUYA_TIMEOUT", "3"))
    )
    lock_timeout: float = field(
        default_factory=lambda: float(os.getenv("SMART_HOME_LOCK_TIMEOUT", "5"))
    )

    network_monitor_enabled: bool = field(
        default_factory=lambda: (
            os.getenv("SMART_HOME_NETWORK_MONITOR_ENABLED", "1").lower() in {"1", "true", "yes"}
        )
    )

    display_poll_interval: float = field(
        default_factory=lambda: float(os.getenv("SMART_HOME_DISPLAY_POLL_INTERVAL", "30"))
    )

    cloud_enabled: bool = field(
        default_factory=lambda: (
            os.getenv("SMART_HOME_CLOUD_ENABLED", "0").lower() in {"1", "true", "yes"}
        )
    )
    cloud_session_path: str = field(
        default_factory=lambda: os.getenv("SMART_HOME_CLOUD_SESSION", "")
    )
    cloud_client_id: str = field(
        default_factory=lambda: os.getenv("SMART_HOME_CLOUD_CLIENT_ID", "HA_3y9q4ak7g4ephrvke")
    )
    cloud_schema: str = field(
        default_factory=lambda: os.getenv("SMART_HOME_CLOUD_SCHEMA", "haauthorize")
    )
    developer_session_path: str = field(
        default_factory=lambda: os.getenv("SMART_HOME_DEVELOPER_SESSION", "")
    )
    cloud_timeout: float = field(
        default_factory=lambda: float(os.getenv("SMART_HOME_CLOUD_TIMEOUT", "10"))
    )
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            value.strip()
            for value in os.getenv("SMART_HOME_CORS_ORIGINS", "").split(",")
            if value.strip()
        )
    )
    frontend_url: str = field(default_factory=lambda: os.getenv("SMART_HOME_FRONTEND_URL", ""))

    def __post_init__(self):
        if self.display_poll_interval != 0 and not 10 <= self.display_poll_interval <= 3600:
            raise ValueError("Display poll interval must be 0 (manual) or 10..3600 seconds")
        if not 0 < self.tuya_timeout <= 30 or not 0 < self.lock_timeout <= 60:
            raise ValueError("Timeouts must be positive: Tuya <=30s, lock <=60s")
        if not 0 < self.cloud_timeout <= 30:
            raise ValueError("Developer cloud timeout must be >0 and <=30s")
        for origin in self.cors_origins:
            self._http_url(origin, origin_only=True)
        if self.frontend_url:
            self._http_url(self.frontend_url)

    @staticmethod
    def _http_url(value, origin_only=False):
        try:
            parsed = urlsplit(value)
            valid = (
                isinstance(value, str)
                and not any(c.isspace() or not c.isprintable() for c in value)
                and parsed.scheme in {"http", "https"}
                and bool(parsed.hostname)
                and parsed.username is None
                and parsed.password is None
                and not parsed.query
                and not parsed.fragment
                and (not origin_only or parsed.path == "")
            )
            _ = parsed.port  # Validate the port, including out-of-range values.
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise ValueError("Configure an HTTP(S) URL; CORS entries must be exact origins")
