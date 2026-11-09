"""Latest received Tuya reports, scoped by account."""

import hashlib
import json
from contextlib import contextmanager

from sqlalchemy import delete, select

from .db import make_engine, upsert
from .models import cloud_status_reports


class SharingReports:
    def __init__(self, bridge, engine):
        self.bridge = bridge
        self.engine = engine

    @contextmanager
    def connection(self):
        settings = self.bridge.settings
        if settings.database_path == ":memory:" and not settings.database_url:
            yield None
            return
        if self.engine is not None:
            with self.engine.begin() as connection:
                yield connection
            return
        # Standalone bridge instances can persist reports without an application engine.
        engine = make_engine(settings.database_path, settings.database_url)
        try:
            with engine.begin() as connection:
                cloud_status_reports.create(connection, checkfirst=True)
                yield connection
        finally:
            engine.dispose()

    @property
    def scope(self):
        uid = self.bridge.auth["token_info"]["uid"]
        return hashlib.sha256(("sharing:" + uid).encode()).hexdigest()

    def load(self, id):
        table = cloud_status_reports
        with self.connection() as connection:
            if connection is None:
                return {}
            rows = connection.execute(
                select(table.c.code, table.c.value, table.c.observed_at, table.c.received_at)
                .where(table.c.scope == self.scope, table.c.device_id == id)
            )
            return {
                code: {"value": json.loads(value), "observed_at": observed, "received_at": received}
                for code, value, observed, received in rows
            }

    def save(self, id, reports):
        if not reports:
            return
        table = cloud_status_reports
        with self.connection() as connection:
            if connection is None:
                return
            statement = upsert(connection, table)
            connection.execute(
                statement.on_conflict_do_update(
                    index_elements=list(table.primary_key.columns),
                    set_={key: statement.excluded[key] for key in ("value", "observed_at", "received_at")},
                ),
                [
                    {
                        "scope": self.scope,
                        "device_id": id,
                        "code": code,
                        "value": json.dumps(report["value"]),
                        "observed_at": report["observed_at"],
                        "received_at": report["received_at"],
                    }
                    for code, report in reports.items()
                ],
            )

    def clear(self, id=None):
        table = cloud_status_reports
        with self.connection() as connection:
            if connection is not None:
                statement = delete(table).where(table.c.scope == self.scope)
                if id is not None:
                    statement = statement.where(table.c.device_id == id)
                connection.execute(statement)
