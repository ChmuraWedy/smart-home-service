"""Bounded LAN status collection leased by visible cards, separate from HTTP reads."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .models import Device, utcnow
from .service import record_observations

INTERVAL = 5.0
LEASE = 10.0
MAX_WATCHES = 64
WORKERS = 4


@dataclass
class Watch:
    expires: float
    due: float


class VisibleStatusPoller:
    def __init__(self, app, clock=time.monotonic):
        self.app, self.clock = app, clock
        self.lock = threading.Lock()
        self.watches = {}
        self.inflight = set()
        self.stopped = threading.Event()
        self.executor = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="visible-status")
        self.thread = None

    def start(self):
        self.thread = threading.Thread(
            target=self._loop, name="visible-status-scheduler", daemon=True
        )
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread:
            self.thread.join(timeout=2)
        self.executor.shutdown(wait=True, cancel_futures=True)

    def _prune(self, now):
        self.watches = {id: watch for id, watch in self.watches.items() if watch.expires > now}

    def touch(self, id):
        """A cache-read heartbeat renews interest without performing network I/O."""
        now = self.clock()
        with self.lock:
            self._prune(now)
            if id not in self.watches:
                if len(self.watches) >= MAX_WATCHES:
                    raise HTTPException(503, "Too many visible device watches")
                self.watches[id] = Watch(now + LEASE, now + INTERVAL)
            else:
                self.watches[id].expires = now + LEASE

    def tick(self):
        now = self.clock()
        with self.lock:
            self._prune(now)
            if self.stopped.is_set():
                return
            ready = sorted(
                (
                    (id, watch)
                    for id, watch in self.watches.items()
                    if watch.due <= now and id not in self.inflight
                ),
                key=lambda item: item[1].due,
            )[: max(0, WORKERS - len(self.inflight))]
            for id, watch in ready:
                watch.due = now + INTERVAL
                self.inflight.add(id)
                # Never queue beyond the worker limit, including slow gateways.
                self.executor.submit(self._read, id)

    def _loop(self):
        while not self.stopped.wait(0.25):
            self.tick()

    @staticmethod
    def _configuration(item):
        return (
            item.device_id,
            item.ip,
            item.local_key,
            item.version,
            item.transport,
            item.parent_id,
            item.cid,
            item.enabled,
            item.capabilities,
        )

    def _read(self, id):
        try:
            with self.lock:
                watch = self.watches.get(id)
                if self.stopped.is_set() or not watch or watch.expires <= self.clock():
                    return
            with Session(self.app.state.engine, expire_on_commit=False) as session:
                item = session.get(Device, id)
                if item is None or not item.enabled:
                    return
                parent = session.get(Device, item.parent_id) if item.parent_id else None
                root = parent or item
                if not root.enabled or not root.ip or not root.local_key or not root.version:
                    return
                # A manual read/command/display collector may have just populated
                # this same cache; do not immediately repeat its LAN status read.
                if item.last_seen_at:
                    age = (
                        utcnow() - item.last_seen_at.replace(tzinfo=timezone.utc)
                    ).total_seconds()
                    if age < INTERVAL:
                        return
                configuration = self._configuration(item)
                parent_configuration = self._configuration(parent) if parent else None
                session.commit()
                observed = self.app.state.controller.execute(item, parent)
                observed_at = utcnow()
                if self.stopped.is_set():
                    return
                session.expire_all()
                item = session.get(Device, id)
                if item is None or self._configuration(item) != configuration:
                    return
                if (
                    parent
                    and self._configuration(session.get(Device, parent.id)) != parent_configuration
                ):
                    return
                if (
                    item.last_seen_at
                    and item.last_seen_at.replace(tzinfo=timezone.utc) > observed_at
                ):
                    return
                record_observations(session, item, observed, observed_at)
                session.commit()
        except Exception:
            # Failed reads leave timestamps and values untouched. They never
            # enqueue a command, invent a reading, or switch to a cloud route.
            pass
        finally:
            with self.lock:
                self.inflight.discard(id)
