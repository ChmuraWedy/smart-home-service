import importlib.util
import json
from pathlib import Path
from unittest.mock import patch

import pytest

SOURCE = Path(__file__).parents[1] / "deploy" / "observability" / "collector.py"
spec = importlib.util.spec_from_file_location("log_collector", SOURCE)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def test_credentials_are_redacted_recursively_and_in_urls_and_free_text():
    secret = "existing-owner-key-123456789"
    data = {"password": "hidden", "nested": {"local_key": "hidden", "value": secret},
            "message": 'GET /api/play/session?token=private&other=secret HTTP/1.1',
            "auth": "Bearer private-bearer", "url": "rtsp://owner:password@192.168.40.2/live",
            "text": 'access_token="private-token" password=private-pass'}
    result = json.dumps(collector.redact(data, [secret]))
    for private in (secret, "private", "owner:password", "hidden"):
        assert private not in result
    assert "192.168.40.2/live" in result


def test_embedded_json_is_redacted_without_losing_normal_state():
    result = json.loads(collector.redact('{"switch_1":true,"nested":{"refresh_token":"secret"}}'))
    assert result == {"switch_1": True, "nested": {}}


def test_dns_client_and_query_identity_are_retained_for_queries_and_replies():
    prefix = "dnsmasq[1]: 97 192.168.40.144/52710 "
    query = collector.dns_fields(prefix + "query[A] example.com from 192.168.40.144")
    answer = collector.dns_fields(prefix + "reply example.com is NXDOMAIN")
    assert query["dns.name"] == "example.com"
    assert query["dns.type"] == "A"
    assert query["client.ip"] == answer["client.ip"] == "192.168.40.144"
    assert query["dns.query_id"] == answer["dns.query_id"] == "97"
    assert answer["dns.response_code"] == "NXDOMAIN"


def test_dns_without_extra_metadata_and_dhcp_are_supported():
    row = collector.dns_fields("dnsmasq[1]: query[AAAA] example.com from 192.168.70.20")
    assert row["dns.type"] == "AAAA"
    assert row["client.ip"] == "192.168.70.20"
    assert collector.dns_fields("dnsmasq-dhcp[1]: DHCPACK(br40) 192.168.40.2 device")["event.category"] == "dhcp"


def test_queue_and_source_cursor_survive_restart_together(tmp_path):
    path = tmp_path / "queue.db"
    queue = collector.Queue(path, 10000)
    row = {"event.id": "test-1", "_msg": "state"}
    queue.enqueue("source", 42, [row])
    queue.db.close()
    reopened = collector.Queue(path, 10000)
    assert reopened.cursor("source") == 42
    reopened.enqueue("source", 42, [row])
    assert reopened.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 1


def test_queue_pressure_never_advances_source_cursor(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 20)
    with pytest.raises(BufferError):
        queue.enqueue("source", 2, [{"event.id": "test-1", "_msg": "payload"}])
    assert queue.cursor("source") is None
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 0


def test_ingestion_failure_retains_batch_for_retry(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 10000)
    queue.enqueue("source", 1, [{"event.id": "test-1", "_msg": "payload"}])
    with patch.object(collector, "urlopen", side_effect=OSError("down")):
        with pytest.raises(OSError):
            queue.deliver("http://127.0.0.1:9428")
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 1
    assert queue.cursor("source") == 1


def test_successful_delivery_removes_only_acknowledged_rows(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 10000)
    queue.enqueue("source", 1, [{"event.id": "test-1", "_msg": "payload"}])
    with patch.object(collector, "urlopen") as send:
        send.return_value.__enter__.return_value.status = 200
        assert queue.deliver("http://127.0.0.1:9428")
        request = send.call_args.args[0]
        assert request.data.endswith(b"\n")
        assert b'"event.id": "test-1"' in request.data
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 0
    assert queue.cursor("source") == 1


def test_same_timestamp_records_resume_without_loss_or_repeated_entries(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 100000)
    stamp = collector.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
    source = {"name": "app", "service": "backend", "environment": "8082"}
    config = {"initial_log_hours": 24}
    records = [f"{stamp} first\n", f"{stamp} second\n"]

    def logs(_args, *, stdout, **_kwargs):
        stdout.write("".join(records).encode())

    with patch.object(collector, "docker", return_value="a" * 64), patch.object(collector.subprocess, "run", side_effect=logs):
        collector.collect_logs(queue, config, source, [])
        records.append(f"{stamp} third\n")
        collector.collect_logs(queue, config, source, [])
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 3
    assert queue.cursor("logs:" + "a" * 64) == [stamp, 3]


def test_history_preserves_timestamps_source_and_command_outcome():
    row = {"id": 77, "at": "2026-11-14T10:00:00+00:00", "observed_at": None,
           "kind": "command", "code": "command", "value": {"switch_1": False},
           "outcome": "accepted", "scope": "account", "device_id": "outlet", "device": {"ip": "192.168.40.2"}}
    event = collector.history_event({"environment": "8082"}, row)
    assert event["event.id"] == "activity:8082:77"
    assert event["event.kind"] == "command"
    assert event["event.outcome"] == "accepted"
    assert event["_time"] == row["at"]
    assert event["device.ip"] == "192.168.40.2"
    assert event["event.category"] == "device"


def test_large_backfill_yields_to_other_sources_and_resumes(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 10000000)
    stamp = collector.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
    source = {"name": "app", "service": "backend", "environment": "8082"}

    def logs(_args, *, stdout, **_kwargs):
        stdout.write("".join(f"{stamp} message {n}\n" for n in range(1001)).encode())

    with patch.object(collector, "docker", return_value="b" * 64), patch.object(collector.subprocess, "run", side_effect=logs):
        collector.collect_logs(queue, {}, source, [])
        assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 1000
        collector.collect_logs(queue, {}, source, [])
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 1001


def test_dns_backfill_skips_dhcp_packet_debug_without_losing_queries(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 10000000)
    stamp = collector.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
    source = {"name": "dns", "service": "dnsmasq", "environment": "lan"}
    records = [f"{stamp} dnsmasq-dhcp[1]: 55 sent size: 3 option: 6 dns-server 192.168.40.1\n"] * 2000
    records += [f"{stamp} dnsmasq[1]: 1 192.168.40.10/123 query[A] example.com from 192.168.40.10\n"]
    records += [f"{stamp} dnsmasq-dhcp[1]: 55 sent size: 3 option: 6 dns-server 192.168.40.1\n"]

    def logs(_args, *, stdout, **_kwargs):
        stdout.write("".join(records).encode())

    with patch.object(collector, "docker", return_value="c" * 64), patch.object(collector.subprocess, "run", side_effect=logs):
        collector.collect_logs(queue, {}, source, [])
        collector.collect_logs(queue, {}, source, [])
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 1
    event = json.loads(queue.db.execute("SELECT payload FROM pending").fetchone()[0])
    assert event["dns.name"] == "example.com"
    assert queue.cursor("logs:" + "c" * 64) == [stamp, 2002]


def test_dns_activation_boundary_is_used_without_resetting_a_newer_cursor(tmp_path):
    queue = collector.Queue(tmp_path / "queue.db", 100000)
    identity = "d" * 64
    before, activation, after = [f"2026-11-14T10:00:0{n}.000000000Z" for n in range(3)]
    queue.enqueue("logs:" + identity, [before, 1], [])
    source = {"name": "dns", "service": "dnsmasq", "environment": "lan", "not_before": activation}
    calls = []

    def logs(args, *, stdout, **_kwargs):
        calls.append(args)
        stdout.write(f"{after} dnsmasq[1]: query[A] example.com from 192.168.40.10\n".encode())

    with patch.object(collector, "docker", return_value=identity), patch.object(collector.subprocess, "run", side_effect=logs):
        collector.collect_logs(queue, {}, source, [])
        collector.collect_logs(queue, {}, source, [])
    assert calls[0][calls[0].index("--since") + 1] == activation
    assert calls[1][calls[1].index("--since") + 1] == after
    assert queue.db.execute("SELECT count(*) FROM pending").fetchone()[0] == 1


def test_gateway_exposes_search_only_with_existing_owner_auth():
    config = (SOURCE.parent / "nginx.conf").read_text()
    assert "listen 8096 ssl" in config
    assert "auth_basic_user_file" in config
    assert "location /select/" in config
    assert "location / { return 404; }" in config
    assert 'proxy_set_header Authorization ""' in config
    assert "location /insert/" not in config
