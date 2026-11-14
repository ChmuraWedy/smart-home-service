"""Bounded, restartable host collector; no device commands or app credentials in requests.

Docker's local log driver is consumed through its supported `docker logs` interface.
Source cursors and a durable send queue commit together. Delivery is at least once:
event.id is stable so a receiver/query can identify a retry after an ambiguous send.
"""
import hashlib
import json
import logging
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

LOG = logging.getLogger("central-logs")
PRIVATE = re.compile(r"(?:^|[_.-])(?:password|passwd|secret|token|authorization|cookie|local_key|api_key|access_key|refresh_token|access_token)(?:$|[_.-])", re.I)
ASSIGNMENT = re.compile(r'''(?i)((?:[\w.-]*(?:password|passwd|secret|token|authorization|cookie|local_key|api_key|access_key)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)''')
AUTH = re.compile(r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+")
URL_QUERY = re.compile(r"((?:https?://[^\s\"<>?]+|/[A-Za-z0-9_./%-]+)\?)[^\s\"<>]+")
URL_LOGIN = re.compile(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@")
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$")


def utcnow():
    return datetime.now(timezone.utc)


def redact(value, secrets=()):
    if isinstance(value, dict):
        return {str(k): redact(v, secrets) for k, v in value.items()
                if not PRIVATE.search(str(k)) and str(k).lower() != "key"}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value[:64]]
    if not isinstance(value, str):
        return value
    if value.lstrip().startswith(("{", "[")):
        try:
            return json.dumps(redact(json.loads(value), secrets), ensure_ascii=False)
        except (ValueError, RecursionError):
            pass
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[redacted]")
    value = ANSI.sub("", value)
    value = URL_QUERY.sub(r"\1[redacted]", value)
    value = URL_LOGIN.sub(r"\1[redacted]@", value)
    value = AUTH.sub("[authorization redacted]", value)
    value = JWT.sub("[token redacted]", value)
    value = ASSIGNMENT.sub(r"\1[redacted]", value)
    return value[:8192]


def dns_fields(message):
    match = re.search(r"dnsmasq(?:-dhcp)?\[\d+\]:\s+(?:(\d+)\s+(\S+)\s+)?(.*)", message)
    if not match:
        return {}
    query_id, peer, body = match.groups()
    fields = {"event.category": "dhcp" if "dnsmasq-dhcp[" in message else "dns"}
    if query_id:
        fields["dns.query_id"] = query_id
    if peer and re.match(r"\d+\.\d+\.\d+\.\d+(?:/|$)", peer):
        fields["client.ip"] = peer.split("/")[0]
    query = re.match(r"query\[([^]]+)\]\s+(\S+)\s+from\s+(\S+)", body)
    if query:
        fields.update({"dns.type": query[1], "dns.name": query[2],
                       "client.ip": query[3], "event.action": "query"})
    else:
        answer = re.match(r"(reply|cached|forwarded|config|/etc/hosts|/data/\S+)\s+(\S+)\s+(?:is|to)\s+(.+)", body)
        if answer:
            fields.update({"event.action": answer[1], "dns.name": answer[2],
                           "dns.answer": answer[3]})
            if "NXDOMAIN" in answer[3]:
                fields["dns.response_code"] = "NXDOMAIN"
    return fields


def service_event(source, container_id, stamp, occurrence, message, secrets=()):
    # Hash the original record for stable identity; only the redacted payload is persisted.
    identity = hashlib.sha256(f"{container_id}:{stamp}:{occurrence}:{message}".encode()).hexdigest()
    clean = redact(message.rstrip(), secrets)
    row = {"_time": stamp, "_msg": clean, "event.id": "log:" + identity,
           "event.category": "service", "service.name": source["service"],
           "environment": source["environment"], "container.name": source["name"],
           "container.id": container_id[:12], "host.name": "dell"}
    if source["service"] == "dnsmasq":
        row.update(dns_fields(clean))
    if re.search(r"\b(error|exception|fatal|critical|traceback)\b", clean, re.I):
        row["log.level"] = "error"
    elif re.search(r"\bwarn(?:ing)?\b", clean, re.I):
        row["log.level"] = "warning"
    else:
        row["log.level"] = "info"
    # Never forward arbitrary structured attributes from an application logger.
    try:
        structured = json.loads(clean)
        if isinstance(structured, dict):
            for key in ("device_id", "command_id", "code", "outcome", "level"):
                if key in structured:
                    row["log." + key] = structured[key]
    except ValueError:
        pass
    return row


def history_event(source, row, secrets=()):
    value = redact(row["value"], secrets)
    result = {"_time": row["at"], "_msg": f'{row["kind"]}: {row["code"]} = {json.dumps(value, ensure_ascii=False)}',
              "event.id": f'activity:{source["environment"]}:{row["id"]}',
              "event.category": "device", "event.kind": row["kind"],
              "event.outcome": row["outcome"] or "", "event.observed_at": row["observed_at"] or "",
              "device.id": row["device_id"], "device.scope": row["scope"],
              "device.parameter": row["code"], "device.value": json.dumps(value, ensure_ascii=False),
              "environment": source["environment"], "service.name": "device-history", "host.name": "dell"}
    for key in ("name", "ip", "room_id"):
        if row.get("device", {}).get(key) is not None:
            result["device." + key] = row["device"][key]
    return result


class Queue:
    def __init__(self, path, max_bytes):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.commit()
        self.max_bytes = max_bytes
        self.queued_bytes = self.db.execute("SELECT coalesce(sum(length(cast(payload AS BLOB))),0) FROM pending").fetchone()[0]

    def cursor(self, source, default=None):
        row = self.db.execute("SELECT value FROM cursors WHERE source=?", (source,)).fetchone()
        return json.loads(row[0]) if row else default

    def enqueue(self, source, cursor, events):
        rows = [(e["event.id"], json.dumps(e, ensure_ascii=False)) for e in events]
        if self.queued_bytes + sum(len(payload.encode()) for _, payload in rows) > self.max_bytes:
            raise BufferError("Collector queue full; source cursor retained")
        added = 0
        with self.db:
            for identity, payload in rows:
                if self.db.execute("INSERT OR IGNORE INTO pending VALUES (?,?)", (identity, payload)).rowcount:
                    added += len(payload.encode())
            self.db.execute("INSERT INTO cursors VALUES (?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value", (source, json.dumps(cursor)))
        self.queued_bytes += added

    def deliver(self, endpoint):
        rows = self.db.execute("SELECT id,payload FROM pending ORDER BY rowid LIMIT 200").fetchall()
        if not rows:
            return False
        payload = ("\n".join(row[1] for row in rows) + "\n").encode()
        request = Request(endpoint + "/insert/jsonline?_stream_fields=service.name,environment,event.category",
                          data=payload, headers={"Content-Type": "application/stream+json"})
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise OSError("Log ingestion did not acknowledge the batch")
            response.read(1024)
        with self.db:
            self.db.executemany("DELETE FROM pending WHERE id=?", [(row[0],) for row in rows])
        self.queued_bytes -= sum(len(row[1].encode()) for row in rows)
        return True


def docker(*args, input=None, timeout=15):
    return subprocess.run(["/usr/bin/docker", *args], input=input, capture_output=True,
                          text=True, timeout=timeout, check=True).stdout


def collect_history(queue, config, source, secrets):
    key = "history:" + source["environment"]
    after = queue.cursor(key, 0)
    script = Path(config["history_adapter"]).read_text()
    output = docker("exec", "-i", source["name"], "python", "-", str(after), input=script)
    rows = [json.loads(line) for line in output.splitlines()]
    cutoff = utcnow() - timedelta(days=config.get("retention_days", 30))
    events = [history_event(source, row, secrets) for row in rows
              if datetime.fromisoformat(row["at"]).replace(tzinfo=timezone.utc) >= cutoff]
    if rows:
        queue.enqueue(key, rows[-1]["id"], events)
    return len(rows)


def collect_logs(queue, config, source, secrets, stopping=None):
    container_id = docker("inspect", "--format", "{{.Id}}", source["name"]).strip()
    if not re.fullmatch(r"[a-f0-9]{64}", container_id):
        raise ValueError("Invalid container identity")
    key = "logs:" + container_id
    initial = (utcnow() - timedelta(hours=config.get("initial_log_hours", 24))).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
    cursor = queue.cursor(key, [initial, 0])
    if source.get("not_before"):
        if not STAMP.fullmatch(source["not_before"]):
            raise ValueError("Source not_before must be a UTC nanosecond timestamp")
        if cursor[0] < source["not_before"]:
            cursor = [source["not_before"], 0]
            queue.enqueue(key, cursor, [])
    until = (utcnow() - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    # A private temporary file bounds RAM even for a large first-time backfill.
    with tempfile.TemporaryFile() as output:
        subprocess.run(["/usr/bin/docker", "logs", "--timestamps", "--since", cursor[0],
                        "--until", until, container_id], stdout=output, stderr=subprocess.STDOUT,
                       timeout=15, check=True)
        output.seek(0)
        batch, previous, occurrence, count = [], None, 0, 0
        position = cursor
        while raw := output.readline(65537):
            if len(raw) > 65536 and not raw.endswith(b"\n"):
                # Never index a tail fragment which could contain a credential.
                while raw and not raw.endswith(b"\n"):
                    raw = output.readline(65537)
                continue
            stamp, _, message = raw.decode("utf-8", errors="replace").partition(" ")
            if not STAMP.fullmatch(stamp):
                continue
            occurrence = occurrence + 1 if stamp == previous else 1
            previous = stamp
            if stamp < cursor[0] or (stamp == cursor[0] and occurrence <= cursor[1]):
                continue
            position = [stamp, occurrence]
            # Keep lease events and all DNS messages, without replaying thousands
            # of DHCP packet-option debug lines before today's DNS queries.
            if (source["service"] == "dnsmasq" and "dnsmasq-dhcp[" in message
                    and not re.search(r"\bDHCP(?:ACK|OFFER|REQUEST|DISCOVER|NAK|RELEASE|DECLINE|INFORM)\b", message)):
                continue
            batch.append(service_event(source, container_id, stamp, occurrence, message, secrets))
            count += 1
            if len(batch) == 100:
                queue.enqueue(key, position, batch)
                batch = []
                if count >= 1000 or (stopping and stopping.is_set()):
                    return  # Fair backfill: do not starve other sources or the sender.
        if batch or position != cursor:
            queue.enqueue(key, position, batch)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    config = json.loads(Path(sys.argv[1]).read_text())
    # Ingestion is intentionally host-loopback only; never send logs to a supplied public URL.
    if config["endpoint"] != "http://127.0.0.1:9428":
        raise ValueError("Collector endpoint must be the local logs service")
    secrets_path = config.get("redactions_file")
    secrets = json.loads(Path(secrets_path).read_text()) if secrets_path else []
    secrets = sorted((s for s in secrets if isinstance(s, str) and len(s) >= 8), key=len, reverse=True)
    queue = Queue(config["state"], config.get("max_queue_bytes", 268435456))
    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    LOG.info("Collector started; source values and credentials are never printed")
    while not stopping.is_set():
        try:
            for _ in range(100):
                if not queue.deliver(config["endpoint"]) or stopping.is_set():
                    break
        except Exception:
            LOG.warning("Central ingestion unavailable; pending batches retained")
        for source in config["containers"]:
            if stopping.is_set():
                break
            try:
                collect_logs(queue, config, source, secrets, stopping)
                if source.get("history"):
                    for _ in range(4):
                        if stopping.is_set():
                            break
                        if collect_history(queue, config, source, secrets) < 500:
                            break
            except Exception as error:
                # Exception text/output may contain device payloads. Print only safe identity/type.
                LOG.warning("Collection delayed: %s (%s)", source["name"], type(error).__name__)
            try:
                for _ in range(10):
                    if not queue.deliver(config["endpoint"]) or stopping.is_set():
                        break
            except Exception:
                LOG.warning("Central ingestion unavailable; pending batches retained")
        stopping.wait(config.get("interval", 5))
    queue.db.close()


if __name__ == "__main__":
    main()
