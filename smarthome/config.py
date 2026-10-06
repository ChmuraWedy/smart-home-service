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

    def __post_init__(self):
        if not 0 < self.tuya_timeout <= 30 or not 0 < self.lock_timeout <= 60:
            raise ValueError("Timeouts must be positive: Tuya <=30s, lock <=60s")
