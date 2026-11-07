"""Lazy Sharing inventory and device reports; no command-derived state."""

import copy
import logging
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi import HTTPException

from .sharing_reports import SharingReports

REPORT_SETTLE_TIME = timedelta(minutes=1)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def managed_mq(*args):
    from tuya_sharing.mq import SharingMQ

    class ManagedMQ(SharingMQ):
        def run(self):
            try:
                super().run()
            finally:
                # SDK setup may finish after stop() while fetching credentials.
                # Dispose any late-created client when its worker exits.
                self.stop()

    return ManagedMQ(*args)


def status_values(rows):
    if not isinstance(rows, list) or any(
        not isinstance(row, dict) or not isinstance(row.get("code"), str) or "value" not in row
        for row in rows
    ):
        raise ValueError("Invalid device status")
    return {row["code"]: row["value"] for row in rows}


class SharingState:
    def __init__(self, bridge, mq_factory=None):
        self.bridge = bridge
        self.mq_factory = mq_factory
        self.metadata = set()
        self.watched = set()
        self.reports = {}
        self.online = {}
        self.http_readings = {}
        self.mq = None
        self.store = SharingReports(bridge)
        self.history_engine = None

    def history(self, device_id, reports):
        if self.history_engine is None:
            return
        try:
            from sqlalchemy.orm import Session

            from .activity import record_values
            with Session(self.history_engine) as session:
                record_values(session, self.store.scope, device_id,
                    {code: row["value"] for code, row in reports.items()}, source="report", observations=reports)
                session.commit()
        except Exception:
            logging.getLogger(__name__).warning("Device activity persistence unavailable")

    def stored(self, action, *args):
        try:
            return getattr(self.store, action)(*args)
        except Exception:
            # Preserve received reports in memory even when the optional disk
            # cache is unavailable; never log report values or account details.
            logging.getLogger(__name__).warning("Tuya report persistence unavailable")
            return {}

    def stop(self):
        # Listener callbacks do not acquire bridge.lock: stop/loop_stop can be
        # called during local logout without waiting for that same lock.
        mq, self.mq = self.mq, None
        self.watched.clear()
        self.metadata.clear()
        self.reports.clear()
        self.online.clear()
        self.http_readings.clear()
        if mq is not None:
            mq.stop()  # Do not use Manager.unload(): it revokes the terminal.
            if self.bridge.manager is not None:
                self.bridge.manager.mq = None

    @property
    def connected(self):
        client = getattr(self.mq, "client", None)
        return bool(client is not None and client.is_connected())

    def inventory(self, manager):
        if not hasattr(manager, "home_repository"):
            manager.update_device_cache()
            return
        # SDK update_device_cache performs four extra HTTP calls per device.
        # Load only the inventory here; metadata is needed only for visible
        # controls, an actual report, command validation or a mapping.
        homes = manager.home_repository.query_homes()
        devices = {}
        received = now_iso()
        for home in homes:
            result = manager.customer_api.get("/v1.0/m/life/ha/home/devices", {"homeId": home.id})
            if result.get("success") is not True or not isinstance(result.get("result"), list):
                raise ValueError("Invalid inventory response")
            for row in result["result"]:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                    raise ValueError("Invalid inventory device")
                values = status_values(row.get("status", []))
                previous = manager.device_map.get(row["id"])
                device = SimpleNamespace(**{**row, "status": values})
                for key, default in (
                    ("function", {}),
                    ("status_range", {}),
                    ("local_strategy", {}),
                    ("support_local", None),
                    ("set_up", False),
                ):
                    setattr(device, key, getattr(previous, key, default))
                devices[device.id] = device
        # Publish atomically only after every home succeeds. A failed refresh
        # must not leave half an account or silently remove authorized devices.
        self.http_readings = {id: (received, dict(device.status)) for id, device in devices.items()}
        manager.device_map = devices
        manager.user_homes = homes
        self.metadata.intersection_update(devices)
        self.reports = {id: report for id, report in self.reports.items() if id in devices}
        self.online = {id: value for id, value in self.online.items() if id in devices}
        for device in devices.values():
            self.watch(manager, device)

    def definitions(self, manager, device):
        if device.id in self.metadata or not hasattr(manager, "device_repository"):
            return device
        repository = manager.device_repository
        repository.update_device_specification(device)
        repository.update_device_strategy_info(device)
        repository.update_device_report_type(device)
        self.metadata.add(device.id)
        return device

    def refresh(self, manager, device):
        if not hasattr(manager, "device_repository"):
            manager.update_device_cache()
            return manager.device_map.get(device.id, device)
        result = manager.customer_api.get("/v1.0/m/life/ha/devices/detail", {"devIds": device.id})
        if result.get("success") is not True or not isinstance(result.get("result"), list):
            raise ValueError("Invalid device detail response")
        matches = [
            row for row in result["result"] if isinstance(row, dict) and row.get("id") == device.id
        ]
        if len(matches) != 1 or type(matches[0].get("online")) is not bool:
            raise ValueError("Unexpected device detail")
        row = matches[0]
        values = status_values(row.get("status"))
        # The SDK updates device.status before handing us each push, even when
        # our listener rejects that push as too old.
        self.http_readings[device.id] = (now_iso(), dict(values))
        device.status, device.online = values, row["online"]
        device.update_time = row.get("update_time")
        return device

    def watch(self, manager, device):
        if not hasattr(manager, "add_device_listener") or device.id in self.watched:
            return
        self.reports.setdefault(device.id, self.stored("load", device.id))
        state = self
        if self.mq is None:

            class Listener:
                def update_device(self, reported, properties=None, timestamps=None):
                    if state.bridge.manager is not manager or state.mq is None:
                        return
                    received = now_iso()
                    if properties is None:
                        state.online[reported.id] = bool(reported.online)
                        state.history(reported.id, {"online": {"value": bool(reported.online), "observed_at": None, "received_at": received}})
                        return
                    reports = dict(state.reports.get(reported.id, {}))
                    for code in properties:
                        if code not in reported.status:
                            continue
                        if code in {
                            "local_key",
                            "key",
                            "access_token",
                            "refresh_token",
                        } or reported.status[code] == getattr(reported, "local_key", None):
                            continue
                        observed = None
                        stamp = (timestamps or {}).get(code)
                        if type(stamp) in (int, float) and stamp > 0:
                            try:
                                observed = datetime.fromtimestamp(
                                    stamp / 1000, timezone.utc
                                ).isoformat()
                            except (ValueError, OverflowError, OSError):
                                pass
                        previous = reports.get(code, {}).get("observed_at")
                        if observed and previous and previous >= observed:
                            continue  # Delayed delivery must not reverse a newer report.
                        reports[code] = {
                            "value": copy.deepcopy(reported.status[code]),
                            "observed_at": observed,
                            "received_at": received,
                        }
                    state.reports[reported.id] = reports
                    state.stored("save", reported.id, reports)
                    state.history(reported.id, reports)

                def add_device(self, reported):
                    pass

                def remove_device(self, id):
                    if state.bridge.manager is not manager or state.mq is None:
                        return
                    state.reports.pop(id, None)
                    state.online.pop(id, None)
                    state.http_readings.pop(id, None)
                    state.stored("clear", id)

            manager.add_device_listener(Listener())
            factory = self.mq_factory
            if factory is None:
                factory = managed_mq
            mq = factory(manager.customer_api, [home.id for home in manager.user_homes], [device])
            mq.daemon = True
            self.mq = mq
            manager.mq = mq
            def on_message(message):
                if state.bridge.manager is not manager or state.mq is None:
                    return
                # Load DP conversion only when a device actually reports, without
                # the former four metadata requests for every inventory entry.
                device_id = message.get("data", {}).get("devId")
                reported = manager.device_map.get(device_id)
                if message.get("protocol") == 4 and reported is not None:
                    try:
                        state.definitions(manager, reported)
                    except Exception:
                        logging.getLogger(__name__).warning("Tuya report definitions unavailable")
                        return
                manager.on_message(message)
            mq.add_message_listener(on_message)
            mq.start()
        else:
            if self.connected:
                self.mq.subscribe_device(device.id, device)
            else:
                self.mq.device.append(device)  # Included by the pending on_connect.
        self.watched.add(device.id)

    def snapshot(self, device):
        result = copy.copy(device)
        received, base = self.http_readings.get(device.id, (None, device.status))
        result.status = {**device.status, **base}
        reports = self.reports.get(device.id, {})
        cutoff = (datetime.fromisoformat(received) - REPORT_SETTLE_TIME).isoformat() if received else None
        observations = {}
        for code, report in reports.items():
            # HTTP can lag a recent push. Once it has had time to catch up, a fresh
            # snapshot can recover a change missed by the event stream.
            if (
                cutoff
                and report["received_at"] <= cutoff
                and code in base
                and base[code] != report["value"]
            ):
                continue
            result.status[code] = report["value"]
            observations[code] = {key: report[key] for key in ("observed_at", "received_at")}
        if device.id in self.online:
            result.online = self.online[device.id]
        result.status_observations = observations
        result.snapshot_received_at = received
        result.event_stream_connected = self.connected
        return result

    def status(self, manager, device, refresh):
        try:
            self.definitions(manager, device)
            if refresh:
                device = self.refresh(manager, device)
            self.watch(manager, device)
            return self.snapshot(device)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(
                502, "Tuya device status query failed; cached state was not confirmed"
            ) from None
