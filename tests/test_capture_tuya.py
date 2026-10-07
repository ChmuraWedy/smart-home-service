import json
import struct

import pytest
import tinytuya

from tools.capture_tuya import PORTS, capture, decode_packet, private_write


def datagram(payload, kind="gcm"):
    raw = json.dumps(payload).encode()
    if kind == "gcm":
        message = tinytuya.TuyaMessage(
            0, tinytuya.REQ_DEVINFO, None, raw, 0, True, tinytuya.PREFIX_6699_VALUE, True
        )
        return tinytuya.pack_message(message, hmac_key=tinytuya.udpkey)
    if kind == "ecb":
        raw = tinytuya.AESCipher(tinytuya.udpkey).encrypt(raw, use_base64=False)
    message = tinytuya.TuyaMessage(0, tinytuya.UDP_NEW, None, struct.pack(">I", 0) + raw, 0)
    return tinytuya.pack_message(message)


@pytest.mark.parametrize("kind", ["plain", "ecb", "gcm"])
def test_decoder_accepts_discovery_frames_without_a_device_local_key(kind):
    payload = {"gwId": "test-id", "version": "3.5", "token": "discovery-token"}
    assert decode_packet(datagram(payload, kind)) == payload


@pytest.mark.parametrize("value", [b"not-a-tuya-frame", datagram(["unexpected-list"])])
def test_decoder_rejects_unparseable_or_nonobject_packets(value):
    assert decode_packet(value) is None


def test_private_output_enforces_permissions_when_replacing_a_file(tmp_path):
    path = tmp_path / "result.json"
    path.write_text("old")
    path.chmod(0o644)
    private_write(path, {"devices": []})
    assert json.loads(path.read_text()) == {"devices": []}
    assert path.stat().st_mode & 0o777 == 0o600
    assert not path.with_suffix(".json.tmp").exists()


def test_capture_saves_raw_and_decoded_data_without_printing_secrets_or_sending(
    monkeypatch, tmp_path, capsys
):
    payload = {
        "gwId": "private-device-id",
        "token": "private-token",
        "local_key": "private-key",
        "version": {"unexpected": "object"},
    }
    packet = datagram(payload)
    listeners = []

    class Listener:
        def __init__(self, *args):
            self.port = None
            self.closed = False
            listeners.append(self)

        def setsockopt(self, *args):
            pass

        def bind(self, address):
            self.port = address[1]

        def recvfrom(self, size):
            return packet, ("192.168.1.20", 6667)

        def getsockname(self):
            return "0.0.0.0", self.port

        def close(self):
            self.closed = True

    ticks = iter([0, 0, 0, 2])
    monkeypatch.setattr("tools.capture_tuya.socket.socket", Listener)
    monkeypatch.setattr("tools.capture_tuya.time.monotonic", lambda: next(ticks))
    monkeypatch.setattr("tools.capture_tuya.select.select", lambda *args: ([listeners[0]], [], []))
    folder = tmp_path / "capture"
    capture(folder, 1)
    output = capsys.readouterr().out
    for secret in ("private-device-id", "private-token", "private-key"):
        assert secret not in output
    assert "unknown" in output
    assert tuple(listener.port for listener in listeners) == PORTS
    assert all(listener.closed for listener in listeners)
    raw = json.loads((folder / "packets.jsonl").read_text())
    assert raw["hex"] == packet.hex() and raw["payload"] == payload
    status = json.loads((folder / "status.json").read_text())
    assert status["packets"] == status["decoded"] == status["devices"] == 1
    assert status["active"] is False and status["polling"] is False
    assert folder.stat().st_mode & 0o777 == 0o700
    for name in ("packets.jsonl", "status.json", "discovery.json"):
        assert (folder / name).stat().st_mode & 0o777 == 0o600
