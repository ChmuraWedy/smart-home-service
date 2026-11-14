"""Bounded, shared LAN camera probes. Discovery is a hint, authenticated replies are proof."""
import copy
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from urllib.parse import quote

from fastapi import HTTPException


class CameraStatus:
    def __init__(self, service):
        self.service = service
        self.lock = Lock()
        self.registry_lock = Lock()
        self.rows = []
        self.registry_at = None
        self.entries = {}
        self.pending = set()
        self.last_started = {}
        self.closed = False
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="camera-lan-status")

    def update(self, camera_id, result):
        if not isinstance(result, dict) or result.get("transport") != "local" or not isinstance(result.get("observed_at"), (int, float)):
            return
        with self.lock:
            previous = self.entries.get(camera_id, {})
            if result["observed_at"] < previous.get("controls", {}).get("observed_at", 0):
                return
            self.entries[camera_id] = {
                "online": True, "checked_at": time.time(), "controls": copy.deepcopy(result),
                "generation": previous.get("generation", 0) + 1,
            }

    def _probe(self, camera_id, generation):
        try:
            result = self.service.request("GET", "/v1/cameras/" + quote(camera_id, safe="") + "/controls", timeout=12)
            self.update(camera_id, result)
        except HTTPException as error:
            with self.lock:
                previous = self.entries.get(camera_id, {})
                if previous.get("generation", 0) == generation and error.status_code != 409:
                    self.entries[camera_id] = {
                        **previous, "online": False if error.status_code == 503 else None,
                        "checked_at": time.time(),
                    }
        finally:
            with self.lock:
                self.pending.discard(camera_id)

    def snapshot(self, network=None):
        with self.registry_lock:
            if self.registry_at is None or time.monotonic() - self.registry_at >= 5:
                rows = self.service.request("GET", "/v1/cameras", timeout=5)
                if not isinstance(rows, list):
                    raise HTTPException(502, "Invalid camera inventory")
                self.rows, self.registry_at = rows, time.monotonic()
        result = []
        with self.lock:
            for row in self.rows:
                if not row.get("connected"):
                    continue
                camera_id = row["id"]
                entry = self.entries.get(camera_id, {})
                if row.get("controls_available") and not self.closed and camera_id not in self.pending and time.monotonic() - self.last_started.get(camera_id, float("-inf")) >= 5:
                    self.pending.add(camera_id)
                    self.last_started[camera_id] = time.monotonic()
                    self.pool.submit(self._probe, camera_id, entry.get("generation", 0))
                public = {k: copy.deepcopy(v) for k, v in entry.items() if k != "generation"}
                announcement = network.observation(row.get("device_id"), row.get("device_id"), "direct", row.get("host")) if network else {}
                result.append({**row, "lan": public, "announcement": {
                    "observed_ip": announcement.get("observed_ip"), "last_seen": announcement.get("last_seen"),
                }})
        return {"cameras": result}

    def close(self):
        with self.lock:
            self.closed = True
        self.pool.shutdown(wait=False, cancel_futures=True)
