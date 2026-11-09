import argparse
import json
import sys
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .config import Settings
from .db import init_db, make_engine
from .importer import import_tinytuya
from .schemas import ImportRequest


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else None


def main():
    parser = argparse.ArgumentParser(description="Import TinyTuya JSON into the local inventory")
    parser.add_argument(
        "--db", help="Override the configured database with an explicit SQLite path"
    )
    parser.add_argument("--devices", required=True, help="devices.json or snapshot.json")
    parser.add_argument(
        "--snapshot", help="Merge snapshot IP/version/key updates by Tuya device ID"
    )
    parser.add_argument(
        "--parent-map", help="JSON file: child Tuya device ID -> gateway Tuya device ID"
    )
    parser.add_argument("--building-id", type=int)
    parser.add_argument("--room-id", type=int)
    parser.add_argument("--device-type-id", type=int)
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate and report, then roll back all changes"
    )
    args = parser.parse_args()
    engine = None
    try:
        request = ImportRequest(
            devices=load_json(args.devices),
            snapshot=load_json(args.snapshot),
            parent_map=load_json(args.parent_map) or {},
            building_id=args.building_id,
            room_id=args.room_id,
            device_type_id=args.device_type_id,
            dry_run=args.dry_run,
        )
        settings = Settings()
        engine = make_engine(args.db or settings.database_path, "" if args.db else settings.database_url)
        init_db(engine)
        with Session(engine, expire_on_commit=False) as session:
            result = import_tinytuya(session, request)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except HTTPException as exc:
        print(f"Import failed ({exc.status_code}): {exc.detail}", file=sys.stderr)
        raise SystemExit(1) from None
    except (OSError, ValueError, ValidationError, SQLAlchemyError):
        print(
            "Import failed: unreadable/invalid JSON, metadata or database conflict; no credentials printed",
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == "__main__":
    main()
