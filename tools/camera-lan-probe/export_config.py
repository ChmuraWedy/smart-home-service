"""Run inside the backend container to prepare a private LAN-probe config."""

import argparse
import json
import os
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from smarthome.config import Settings
from smarthome.db import make_engine
from smarthome.models import Device


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rtc-config", type=Path)
    args = parser.parse_args()
    settings = Settings()
    engine = make_engine(settings.database_path, settings.database_url)
    try:
        with Session(engine) as session:
            camera = session.scalar(select(Device).where(Device.device_id == args.device_id))
            if camera is None or camera.category not in {"sp", "dghsxj"}:
                raise SystemExit("Select an existing locally mapped camera.")
            auth = json.loads(Path(settings.cloud_session_path).read_bytes())
            config = {
                "device_id": camera.device_id,
                "host": camera.ip,
                "version": camera.version,
                "local_key": camera.local_key,
                "uid": auth["token_info"]["uid"],
                "p2p_password": "",
            }
        if args.rtc_config:
            rtc = json.loads(args.rtc_config.read_bytes())
            p2p = rtc.get("p2pConfig", rtc.get("p2p_config", {}))
            if isinstance(p2p, str):
                p2p = json.loads(p2p)
            config["p2p_password"] = p2p.get("password", "")
            if not config["p2p_password"]:
                raise SystemExit("RTC configuration does not contain a P2P password.")
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as target:
            json.dump(config, target)
            target.write("\n")
        print("Saved private probe configuration. Verify the local key is current before testing.")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
