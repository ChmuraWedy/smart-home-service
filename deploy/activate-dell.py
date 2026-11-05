#!/usr/bin/env python3
"""Activate a legacy single-container Dell image and rotate the browser API key.

Run from the managing Mac. Tokens travel over SSH stdin, never command arguments
or output. For the split stack, use Compose and keep the existing key.
"""

import argparse
import fcntl
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_LINE = re.compile(r"^[ \t]*(?:export[ \t]+)?SMART_HOME_API_TOKEN[ \t]*=(.*)$", re.MULTILINE)
COMPOSE = ["sudo", "-n", "docker", "compose", "-f", "compose.yaml", "-f", "compose.lan.yaml"]
ROLLBACK_IMAGE = "smart-home-service:rollback-before-activation"


def read_token(text):
    matches = TOKEN_LINE.findall(text)
    if len(matches) != 1:
        raise ValueError("Expected exactly one service key")
    parts = shlex.split(matches[0], comments=True)
    if len(parts) != 1 or not parts[0] or "$" in parts[0]:
        raise ValueError("Use a literal service key in .env")
    return parts[0]


def with_token(text, token):
    read_token(text)
    return TOKEN_LINE.sub(lambda _: "SMART_HOME_API_TOKEN=" + token, text, count=1)


def private_write(path, text):
    """Replace a private file atomically without exposing a world-readable temp."""
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Refusing a symbolic link for private configuration")
    fd, temporary = tempfile.mkstemp(prefix=".env.deploy-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def command(args, directory, image=None):
    environment = os.environ.copy()
    environment.pop("SMART_HOME_API_TOKEN", None)
    if image:
        environment["SMART_HOME_IMAGE"] = image
    result = subprocess.run(
        args, cwd=directory, env=environment, capture_output=True, text=True, timeout=180,
    )
    if result.returncode:
        # Compose errors can include environment values. Never forward raw output.
        raise RuntimeError("Deployment command failed")
    return result.stdout.strip()


def check_api(token):
    request = urllib.request.Request(
        "http://127.0.0.1:8080/api/v1/devices", headers={"X-API-Key": token},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        devices = json.load(response)
    if not isinstance(devices, list):
        raise RuntimeError("Unexpected inventory response")
    try:
        urllib.request.urlopen("http://127.0.0.1:8080/api/v1/devices", timeout=10).close()
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return len(devices)
    raise RuntimeError("Unauthenticated inventory must be rejected")


def activate(directory, expected_token, token):
    directory = Path(directory)
    env_path = directory / ".env"
    if env_path.is_symlink():
        raise ValueError("Refusing a symbolic link for .env")
    original = env_path.read_text(encoding="utf-8")
    if not secrets.compare_digest(read_token(original), expected_token):
        return {"ok": False, "error": "Local and Dell keys differ; synchronize them first."}
    if not re.fullmatch(r"[a-f0-9]{64}", token) or token == expected_token:
        raise ValueError("A fresh random key is required")
    container = command([*COMPOSE, "ps", "-q", "smart-home"], directory)
    if not container or "\n" in container:
        raise RuntimeError("Expected one existing service container")
    image = command(["sudo", "-n", "docker", "inspect", container, "--format", "{{.Image}}"], directory)
    command(["sudo", "-n", "docker", "tag", image, ROLLBACK_IMAGE], directory)
    private_write(directory / ".env.before-deploy", original)
    private_write(env_path, with_token(original, token))
    try:
        command([*COMPOSE, "up", "-d", "--no-build", "--wait", "--wait-timeout", "120"], directory)
        count = check_api(token)
        return {"ok": True, "saved_devices": count}
    except Exception:
        private_write(env_path, original)
        try:
            command(
                [*COMPOSE, "up", "-d", "--no-build", "--wait", "--wait-timeout", "120"],
                directory, image=ROLLBACK_IMAGE,
            )
            check_api(expected_token)
            return {"ok": False, "rolled_back": True, "error": "Activation failed; previous image and key restored."}
        except Exception:
            return {"ok": False, "rolled_back": False, "error": "Activation and rollback failed. Inspect the Dell service."}


def remote():
    payload = json.load(sys.stdin)
    directory = Path(payload["directory"])
    # Serialize activations, including rollback, across managing computers.
    descriptor = os.open(directory / ".deploy-key.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = activate(directory, payload["expected_token"], payload["token"])
    print(json.dumps(result))


def main():
    if sys.argv[1:] == ["--remote"]:
        remote()
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-monolith", action="store_true", required=True,
                        help="Use only with the old single-container Compose configuration")
    parser.add_argument("--host", default="dell5070", help="SSH host or configured alias")
    parser.add_argument("--directory", default="/home/damawik/smart-home-service")
    parser.add_argument("--local-env", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    args = parser.parse_args()
    descriptor = os.open(args.local_env.parent / ".env.deploy.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return activate_from_mac(args)


def activate_from_mac(args):
    if args.host.startswith("-"):
        raise ValueError("Invalid SSH host")
    env_path = args.local_env.resolve(strict=True)
    if args.local_env.is_symlink():
        raise ValueError("Refusing a symbolic link for .env")
    original = env_path.read_text(encoding="utf-8")
    expected = read_token(original)
    token = secrets.token_hex(32)
    pending = env_path.with_name(".env.pending-deploy")
    if pending.exists():
        raise RuntimeError("Resolve the existing .env.pending-deploy before deploying again")
    private_write(env_path.with_name(".env.before-deploy"), original)
    private_write(pending, with_token(original, token))
    payload = json.dumps({"directory": args.directory, "expected_token": expected, "token": token})
    script = Path(__file__).read_text(encoding="utf-8")
    # The script has no secrets. Only its stdin payload contains the keys.
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.host,
         "python3 -c " + shlex.quote(script) + " --remote"],
        input=payload, capture_output=True, text=True, timeout=420,
    )
    try:
        status = json.loads(result.stdout) if result.returncode == 0 else None
    except ValueError:
        status = None
    if status is None:
        print("Remote result unknown. Keys are in .env.pending-deploy and .env.before-deploy; check Dell before retrying.", file=sys.stderr)
        return 1
    if not status.get("ok"):
        if status.get("rolled_back") or "keys differ" in status.get("error", ""):
            pending.unlink()
        print(status.get("error", "Activation failed; inspect Dell before retrying."), file=sys.stderr)
        return 1
    if env_path.read_text(encoding="utf-8") != original:
        print("Dell activated, but local .env changed. New key remains in .env.pending-deploy; reconcile it before retrying.", file=sys.stderr)
        return 1
    os.replace(pending, env_path)
    print(f"Dell healthy. Fresh service key saved locally and on Dell. Saved devices: {status['saved_devices']}.")
    print("Browsers must reconnect with the new key from .env (SMART_HOME_API_TOKEN).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # No exception repr or subprocess output: both can contain credentials.
        print("Activation could not finish. Check connectivity and private .env deployment files before retrying.", file=sys.stderr)
        sys.exit(1)
