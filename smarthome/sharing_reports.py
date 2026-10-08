"""Latest received Tuya reports in the existing SQLite database, scoped by account."""

import hashlib
import json
import sqlite3
from contextlib import contextmanager


class SharingReports:
    def __init__(self, bridge):
        self.bridge = bridge

    @contextmanager
    def connection(self):
        # The optional adapter also supports injected in-memory test settings.
        if self.bridge.settings.database_path == ":memory:":
            yield None
            return
        db = sqlite3.connect(self.bridge.settings.database_path, timeout=2)
        try:
            with db:
                db.execute("""CREATE TABLE IF NOT EXISTS cloud_status_reports (
                    scope TEXT NOT NULL, device_id TEXT NOT NULL, code TEXT NOT NULL,
                    value TEXT NOT NULL, observed_at TEXT, received_at TEXT NOT NULL,
                    PRIMARY KEY(scope, device_id, code))""")
                yield db
        finally:
            db.close()

    @property
    def scope(self):
        uid = self.bridge.auth["token_info"]["uid"]
        return hashlib.sha256(("sharing:" + uid).encode()).hexdigest()

    def load(self, id):
        with self.connection() as db:
            if db is None:
                return {}
            return {
                code: {"value": json.loads(value), "observed_at": observed, "received_at": received}
                for code, value, observed, received in db.execute(
                    "SELECT code,value,observed_at,received_at FROM cloud_status_reports "
                    "WHERE scope=? AND device_id=?",
                    (self.scope, id),
                )
            }

    def save(self, id, reports):
        with self.connection() as db:
            if db is None:
                return
            db.executemany(
                "INSERT INTO cloud_status_reports VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(scope,device_id,code) DO UPDATE SET "
                "value=excluded.value,observed_at=excluded.observed_at,received_at=excluded.received_at",
                [
                    (
                        self.scope,
                        id,
                        code,
                        json.dumps(report["value"]),
                        report["observed_at"],
                        report["received_at"],
                    )
                    for code, report in reports.items()
                ],
            )

    def clear(self, id=None):
        with self.connection() as db:
            if db is not None:
                if id is None:
                    db.execute("DELETE FROM cloud_status_reports WHERE scope=?", (self.scope,))
                else:
                    db.execute(
                        "DELETE FROM cloud_status_reports WHERE scope=? AND device_id=?",
                        (self.scope, id),
                    )
