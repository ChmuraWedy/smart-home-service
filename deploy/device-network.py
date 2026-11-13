#!/usr/bin/env python3
"""Device-specific WAN deny rules. Run as root, expose only an allowlisted Unix socket.

No shell interpolation, client-selected addresses, global policy edits or Docker access.
MAC identifies outbound traffic; IP identifies return traffic. LAN destinations survive.
"""
import argparse
import ipaddress
import json
import os
import re
import socketserver
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from threading import Lock

TABLE = "device_wan"
PRIVATE = "{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 }"


def validate(config):
    if not isinstance(config, dict) or len(config) > 128:
        raise ValueError("Invalid device allowlist")
    for identifier, row in config.items():
        if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", identifier):
            raise ValueError("Invalid device ID")
        if not re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", row["mac"]):
            raise ValueError("Invalid MAC")
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", row["interface"]):
            raise ValueError("Invalid interface")
        address = ipaddress.IPv4Address(row["host"])
        if str(address) != identifier or not any(address in ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
            raise ValueError("Invalid device IP")
    if len({r["mac"] for r in config.values()}) != len(config):
        raise ValueError("Duplicate device MAC")


def rules(config, blocked, exists):
    lines = [f"delete table inet {TABLE}"] if exists else []
    lines += [f"table inet {TABLE} {{", "chain forward {", "type filter hook forward priority -30; policy accept;"]
    for identifier, row in sorted(config.items()):
        if not blocked.get(identifier, False):
            continue
        interface, mac, host = row["interface"], row["mac"], row["host"]
        lines += [
            f'iifname "{interface}" ether saddr {mac} ip daddr != {PRIVATE} counter drop comment "{identifier}:out"',
            f'iifname "{interface}" ether saddr {mac} meta nfproto ipv6 counter drop comment "{identifier}:v6"',
            f'oifname "{interface}" ip daddr {host} ip saddr != {PRIVATE} counter drop comment "{identifier}:in"',
        ]
    return "\n".join(lines + ["}", "}", ""])


def nft(*args, source=None):
    return subprocess.run(["/usr/sbin/nft", *args], input=source, text=True,
                          capture_output=True, timeout=5, check=True).stdout


def stable(value):
    if isinstance(value, list):
        return [stable(v) for v in value]
    if isinstance(value, dict):
        return {k: stable(v) for k, v in value.items() if k not in {"handle", "metainfo", "counter"}}
    return value


class Policy:
    def __init__(self, config, path):
        validate(config)
        self.config, self.path, self.lock = config, Path(path), Lock()
        self.blocked = json.loads(self.path.read_text()) if self.path.exists() else {}
        if not set(self.blocked) <= set(config) or any(type(v) is not bool for v in self.blocked.values()):
            raise ValueError("Invalid saved device policy")
        self.apply(self.blocked)

    def apply(self, blocked):
        listing = json.loads(nft("-j", "list", "tables"))
        exists = any(r.get("table", {}).get("name") == TABLE and r["table"].get("family") == "inet" for r in listing["nftables"])
        script = rules(self.config, blocked, exists)
        nft("-c", "-f", "-", source=script)
        nft("-f", "-", source=script)  # One atomic transaction, own table only.
        self.applied = stable(json.loads(nft("-j", "list", "table", "inet", TABLE)))

    def status(self, identifier):
        data = json.loads(nft("-j", "list", "table", "inet", TABLE))
        if stable(data) != self.applied:
            raise RuntimeError("Device firewall has changed")
        listing = data["nftables"]
        comments = {r["rule"].get("comment") for r in listing if "rule" in r}
        expected = {f"{i}:{direction}" for i, blocked in self.blocked.items() if blocked for direction in ("out", "in", "v6")}
        if comments != expected:
            raise RuntimeError("Device firewall differs from saved policy")
        return {"blocked": self.blocked.get(identifier, False), "verified": True, "mac": self.config[identifier]["mac"]}

    def set(self, identifier, value):
        previous = self.blocked
        updated = {**previous, identifier: value}
        self.apply(updated)
        temporary = None
        try:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", dir=self.path.parent, delete=False) as f:
                temporary = Path(f.name)
                os.chmod(f.name, 0o600)
                json.dump(updated, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, self.path)
            self.blocked = updated
        except BaseException:
            self.apply(previous)
            raise
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
        return self.status(identifier)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *args):
        pass

    def handle_request(self, update):
        identifier = self.path.removeprefix("/devices/")
        policy = self.server.policy
        if self.path != "/devices/" + identifier or identifier not in policy.config:
            self.send_error(404)
            return
        try:
            with policy.lock:
                if update:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 100:
                        raise ValueError()
                    body = json.loads(self.rfile.read(length))
                    if set(body) != {"blocked"} or type(body["blocked"]) is not bool:
                        raise ValueError()
                    result = policy.set(identifier, body["blocked"])
                else:
                    result = policy.status(identifier)
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, KeyError):
            self.send_error(400)
        except Exception:
            self.send_error(503, "Device policy unavailable")

    def do_GET(self):
        self.handle_request(False)

    def do_PUT(self):
        self.handle_request(True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--socket", required=True)
    args = parser.parse_args()
    policy = Policy(json.loads(Path(args.config).read_text()), args.state)
    path = Path(args.socket)
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    with socketserver.UnixStreamServer(str(path), Handler) as server:
        os.chown(path, 0, 1000)
        os.chmod(path, 0o660)
        server.policy = policy
        server.timeout = 10
        notify = os.getenv("NOTIFY_SOCKET")
        if notify:
            import socket
            address = "\0" + notify[1:] if notify.startswith("@") else notify
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as ready:
                ready.connect(address)
                ready.sendall(b"READY=1")
        server.serve_forever()
