import os
from dataclasses import dataclass, field


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

    def __post_init__(self):
        if self.display_poll_interval != 0 and not 10 <= self.display_poll_interval <= 3600:
            raise ValueError("Display poll interval must be 0 (manual) or 10..3600 seconds")
        if not 0 < self.tuya_timeout <= 30 or not 0 < self.lock_timeout <= 60:
            raise ValueError("Timeouts must be positive: Tuya <=30s, lock <=60s")
        if not 0 < self.cloud_timeout <= 30:
            raise ValueError("Developer cloud timeout must be >0 and <=30s")
