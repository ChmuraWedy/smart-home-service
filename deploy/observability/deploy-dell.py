"""Install the additive central-search stack on Dell, preserving existing app containers."""
import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path("/home/damawik/smart-home-service/releases/central-logs/source")
CONF = Path("/etc/smart-home-logs")
DATA = Path("/home/damawik/smart-home-service/central-logs")
BACKENDS = {"8080": "smart-home-service-backend-1", "8082": "smart-home-postgres-backend-8082"}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout


def inspect(name):
    return json.loads(run("docker", "inspect", name))[0]


def environment(row):
    return dict(item.split("=", 1) for item in row["Config"]["Env"])


def cloud_status(port, key):
    request = Request(f"http://127.0.0.1:{port}/api/v1/cloud/status", headers={"X-API-Key": key})
    with urlopen(request, timeout=30) as response:
        result = json.load(response)
    assert result["enabled"] and result["connected"], f"Smart Life is not connected on {port}"


def private_file(path, data, *, uid=0, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as file:
        file.write(data)
    os.chown(path, uid, uid)
    os.chmod(path, mode)


def main():
    assert os.geteuid() == 0
    os.umask(0o077)
    CONF.mkdir(mode=0o700, exist_ok=True)
    DATA.mkdir(mode=0o700, exist_ok=True)
    os.chown(DATA, 1000, 1000)
    baseline = {port: inspect(name) for port, name in BACKENDS.items()}
    keys = {port: environment(row)["SMART_HOME_API_TOKEN"] for port, row in baseline.items()}
    assert keys["8080"] == keys["8082"] and len(keys["8080"]) >= 32
    for port, key in keys.items():
        cloud_status(port, key)
    fronts = {name: inspect(name)["Id"] for name in ("smart-home-service-frontend-1", "smart-home-frontend-feat-headless-ui-dashboard", "smart-home-cameras-8082")}
    print("Baseline: both Smart Life sessions connected; app and camera containers recorded", flush=True)

    # Exact-secret inventory is private, stays on this host, and is never printed.
    secrets = set(keys.values())
    config = json.loads((ROOT / "deploy/observability/collector.example.json").read_text())
    for source in config["containers"]:
        try:
            env = environment(inspect(source["name"]))
        except subprocess.CalledProcessError:
            continue
        for name, value in env.items():
            if any(word in name for word in ("TOKEN", "KEY", "SECRET", "PASSWORD")) and not name.endswith("_FILE") and len(value) >= 8:
                secrets.add(value)
    secret_adapter = '''
import json, os
from pathlib import Path
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from smarthome.config import Settings
from smarthome.db import make_engine
from smarthome.models import Device
secrets=[]
def visit(v):
    if isinstance(v,dict):
        for key,value in v.items():
            if any(x in key.lower() for x in ('token','secret','password','local_key')) and isinstance(value,str): secrets.append(value)
            else: visit(value)
    elif isinstance(v,list):
        for x in v: visit(x)
settings=Settings()
for filename in (settings.cloud_session_path,settings.developer_session_path):
    if filename and Path(filename).is_file(): visit(json.loads(Path(filename).read_text()))
engine=make_engine(settings.database_path,settings.database_url)
with Session(engine) as session:
    if engine.dialect.name=='postgresql': session.execute(text('SET TRANSACTION READ ONLY'))
    else: session.execute(text('PRAGMA query_only = ON'))
    secrets.extend(session.scalars(select(Device.local_key)).all())
print(json.dumps([s for s in secrets if s]))
engine.dispose()
'''
    for name in BACKENDS.values():
        secrets.update(json.loads(run("docker", "exec", "-i", name, "python", "-", input=secret_adapter)))
    private_file(CONF / "redactions.json", json.dumps(sorted(secrets)))
    config["redactions_file"] = str(CONF / "redactions.json")
    private_file(CONF / "collector.json", json.dumps(config, indent=2) + "\n")
    # Hash the existing key; do not create or rotate an application credential.
    password_hash = run("openssl", "passwd", "-6", "-stdin", input=keys["8080"] + "\n").strip()
    private_file(CONF / "log-users", "owner:" + password_hash + "\n", uid=33, mode=0o400)
    for source, destination in (("collector.py", "smart-home-log-collector.py"), ("export-history.py", "smart-home-log-history.py")):
        target = Path("/usr/local/libexec") / destination
        shutil.copyfile(ROOT / "deploy/observability" / source, target)
        os.chmod(target, 0o755)
    shutil.copyfile(ROOT / "deploy/observability/smart-home-log-collector.service", "/etc/systemd/system/smart-home-log-collector.service")
    os.chmod("/etc/systemd/system/smart-home-log-collector.service", 0o644)

    logs_image = run("docker", "image", "inspect", "victoriametrics/victoria-logs:v1.54.0", "--format", "{{index .RepoDigests 0}}").strip()
    gateway_image = inspect("smart-home-frontend-feat-headless-ui-dashboard")["Image"]
    private_file(CONF / "compose.env", "\n".join((
        "SMART_HOME_LOGS_IMAGE=" + logs_image,
        "SMART_HOME_LOGS_GATEWAY_IMAGE=" + gateway_image,
        "SMART_HOME_LOGS_DATA=" + str(DATA),
        "SMART_HOME_LOGS_AUTH_FILE=" + str(CONF / "log-users"),
        "SMART_HOME_LOGS_TLS_DIR=/home/damawik/smart-home-service/lan-https", "")))
    compose = ("docker", "compose", "--env-file", str(CONF / "compose.env"), "-f", str(ROOT / "compose.logs.yaml"))
    run(*compose, "config", "--quiet")
    try:
        run(*compose, "up", "-d", timeout=60)
        for attempt in range(20):
            try:
                with urlopen("http://127.0.0.1:9428/health", timeout=2) as response:
                    assert response.status == 200
                break
            except Exception:
                if attempt == 19:
                    raise
                time.sleep(1)
        run("docker", "exec", "smart-home-log-search", "nginx", "-t", "-c", "/etc/nginx/log-search.conf")
        run("systemctl", "daemon-reload")
        run("systemctl", "enable", "--now", "smart-home-log-collector.service")
        for port, name in BACKENDS.items():
            current = inspect(name)
            assert current["Id"] == baseline[port]["Id"]
            assert environment(current)["SMART_HOME_API_TOKEN"] == keys[port]
            cloud_status(port, keys[port])
        for name, identity in fronts.items():
            assert inspect(name)["Id"] == identity
    except BaseException:
        run("systemctl", "stop", "smart-home-log-collector.service", timeout=40)
        run(*compose, "stop", timeout=45)
        raise
    public_baseline = {"backends": {port: {"id": row["Id"], "image": row["Image"],
        "key_sha256": hashlib.sha256(keys[port].encode()).hexdigest()} for port, row in baseline.items()}, "other_containers": fronts}
    private_file(CONF / "baseline.json", json.dumps(public_baseline, indent=2))
    print("Central search running over HTTPS 8096; storage loopback-only; collector enabled", flush=True)
    print("Both app instances and camera container unchanged; Smart Life still connected; keys preserved", flush=True)


if __name__ == "__main__":
    main()
