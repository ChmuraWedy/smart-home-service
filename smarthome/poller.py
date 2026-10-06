"""One bounded background collector; dashboard HTTP reads never wait on devices."""

import threading

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .dashboard import display_read, selected_devices
from .models import Device, Display, utcnow
from .service import record_observations


class DisplayPoller:
    def __init__(self, app):
        self.app = app
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.lock = threading.Lock()
        self.pending = set()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._loop, name="display-status", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=10)

    def request_refresh(self, display_id):
        with self.lock:
            if len(self.pending) < 64:
                self.pending.add(display_id)
            else:
                raise HTTPException(503, "Display refresh queue is full")
        self.wake.set()

    def _loop(self):
        interval = self.app.state.settings.display_poll_interval
        while not self.stop_event.is_set():
            self.wake.wait(timeout=interval if interval else 60)
            self.wake.clear()
            if self.stop_event.is_set():
                break
            with self.lock:
                pending, self.pending = self.pending, set()
            if not pending and not interval:
                continue
            try:
                self.refresh(pending or None)
            except Exception:
                # No credentials or device payloads in logs. A later cycle retries reads.
                continue

    def refresh(self, display_ids=None):
        with Session(self.app.state.engine, expire_on_commit=False) as session:
            query = select(Display)
            if display_ids is not None:
                query = query.where(Display.id.in_(display_ids))
            ids = set()
            for display in session.scalars(query).all():
                try:
                    ids.update(
                        selected_devices(session, display.room_id, display_read(display).widgets)
                    )
                except HTTPException:
                    continue
            session.commit()
            for id in sorted(ids):
                if self.stop_event.is_set():
                    break
                item = session.get(Device, id)
                if item is None:
                    continue
                parent = session.get(Device, item.parent_id) if item.parent_id else None
                session.commit()
                try:
                    observed = self.app.state.controller.execute(item, parent)
                    if self.stop_event.is_set():
                        break
                    record_observations(session, item, observed, utcnow())
                    session.commit()
                except Exception:
                    session.rollback()
