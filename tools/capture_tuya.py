"""Receive and record Tuya UDP discovery without polling or controlling devices.

Run with the service's Python environment. Raw packets and decrypted payloads
stay in a private, Git-ignored capture directory; stdout never prints payloads.
"""

import argparse
import json
import logging
import os
import select
import socket
import time
from datetime import datetime, timezone
from pathlib import Path

import tinytuya

PORTS = (6666, 6667, 7000)


def decode_packet(data):
    try:
        payload = json.loads(tinytuya.decrypt_udp(data))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def private_write(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def capture(folder, seconds):
    logging.getLogger("tinytuya").disabled = True
    folder.mkdir(parents=True, mode=0o700, exist_ok=False)
    folder.chmod(0o700)
    sockets, inventory = [], {}
    count = decoded = 0
    started = datetime.now(timezone.utc).isoformat()
    deadline = time.monotonic() + seconds
    status = {"started_at": started, "ports": list(PORTS), "polling": False, "active": True}
    raw_fd = os.open(folder / "packets.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        for port in PORTS:
            listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sockets.append(listener)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("", port))
        with os.fdopen(raw_fd, "w", buffering=1) as output:
            raw_fd = None
            private_write(folder / "status.json", status)
            print(
                f"READY: UDP {','.join(map(str, PORTS))}; {seconds}s; capture={folder}", flush=True
            )
            while time.monotonic() < deadline and not (folder / "stop").exists():
                ready, _, _ = select.select(
                    sockets, [], [], min(1, max(0, deadline - time.monotonic()))
                )
                for listener in ready:
                    data, peer = listener.recvfrom(65535)
                    now = datetime.now(timezone.utc).isoformat()
                    payload = decode_packet(data)
                    count += 1
                    decoded += payload is not None
                    packet = {
                        "at": now,
                        "source_ip": peer[0],
                        "source_port": peer[1],
                        "destination_port": listener.getsockname()[1],
                        "hex": data.hex(),
                        "payload": payload,
                    }
                    output.write(json.dumps(packet, ensure_ascii=False) + "\n")
                    if payload and isinstance(payload.get("gwId"), str) and payload["gwId"]:
                        id = payload["gwId"]
                        first = id not in inventory
                        row = inventory.setdefault(id, {"id": id, "first_seen": now, "packets": 0})
                        changed = (
                            first
                            or row.get("ip") != peer[0]
                            or row.get("version") != payload.get("version")
                        )
                        row.update(
                            ip=peer[0],
                            last_seen=now,
                            version=payload.get("version"),
                            packets=row["packets"] + 1,
                        )
                        if changed:
                            candidate = row["version"]
                            version = (
                                candidate
                                if isinstance(candidate, str)
                                and candidate in {"3.1", "3.2", "3.3", "3.4", "3.5"}
                                else "unknown"
                            )
                            print(
                                f"DISCOVERY device#{list(inventory).index(id) + 1}: IP={peer[0]} version={version}",
                                flush=True,
                            )
                        private_write(
                            folder / "discovery.json", {"devices": list(inventory.values())}
                        )
                    status.update(
                        packets=count, decoded=decoded, devices=len(inventory), last_packet_at=now
                    )
                    private_write(folder / "status.json", status)
                if count >= 100000 or output.tell() >= 100 * 1024 * 1024:
                    status["stop_reason"] = "capture_limit"
                    break
    except KeyboardInterrupt:
        status["stop_reason"] = "interrupt"
    finally:
        if raw_fd is not None:
            os.close(raw_fd)
        for listener in sockets:
            listener.close()
        status.update(
            active=False,
            finished_at=datetime.now(timezone.utc).isoformat(),
            packets=count,
            decoded=decoded,
            devices=len(inventory),
        )
        private_write(folder / "status.json", status)
        print(f"FINISHED packets={count} decoded={decoded} devices={len(inventory)}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=900)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600:
        parser.error("seconds must be 1..3600")
    folder = args.output or Path("data/captures") / datetime.now(timezone.utc).strftime(
        "%Y%m%dT%H%M%SZ"
    )
    capture(folder, args.seconds)


if __name__ == "__main__":
    main()
