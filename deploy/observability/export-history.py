"""Read-only adapter, executed inside an existing application container over stdin."""
import json
import sys

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from smarthome.config import Settings
from smarthome.db import make_engine
from smarthome.models import Device, DeviceActivity

after = int(sys.argv[1])
settings = Settings()
engine = make_engine(settings.database_path, settings.database_url)
with Session(engine) as session:
    if engine.dialect.name == "postgresql":
        session.execute(text("SET TRANSACTION READ ONLY"))
        session.execute(text("SET LOCAL statement_timeout = '5s'"))
    else:
        session.execute(text("PRAGMA query_only = ON"))
    # Only metadata needed for identity joins; never return keys or authentication records.
    devices = {d.device_id: {"name": d.name, "ip": d.ip, "room_id": d.room_id}
               for d in session.scalars(select(Device)).all()}
    rows = session.scalars(select(DeviceActivity).where(DeviceActivity.id > after)
                           .order_by(DeviceActivity.id).limit(500)).all()
    for row in rows:
        print(json.dumps({"id": row.id, "scope": row.scope, "device_id": row.device_id,
            "at": row.at, "observed_at": row.observed_at, "kind": row.kind,
            "code": row.code, "value": row.value, "outcome": row.outcome,
            "device": devices.get(row.device_id, {})}, ensure_ascii=False))
engine.dispose()
