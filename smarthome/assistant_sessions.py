"""Short-lived credentials for the dashboard's embedded Classic Chat."""
from dataclasses import dataclass
from hashlib import sha256
from secrets import token_urlsafe
from threading import Lock
from time import monotonic

SESSION_PREFIX = "shc_"
TICKET_TTL = 60
SESSION_TTL = 1800
MAX_CREDENTIALS = 1024
CHAT_ROUTES = {
    "GET": frozenset({
        "/api/v1/accounts/me",
        "/api/v1/devices",
        "/api/v1/devices/{item_id}/state",
        "/api/v1/rooms",
        "/api/v1/cloud/topology",
        "/api/v1/cloud/devices",
        "/api/v1/cloud/devices/{device_id}/status",
        "/api/v1/cloud/devices/{device_id}/functions",
        "/api/v1/activity/devices/{device_id}",
    }),
    "POST": frozenset({
        "/api/v1/devices/{item_id}/commands/capabilities",
        "/api/v1/cloud/devices/{device_id}/commands",
    }),
}


@dataclass(frozen=True)
class DashboardCredential:
    key_id: str | None
    digest: str


def _digest(value: str) -> bytes:
    return sha256(value.encode()).digest()


class AssistantSessions:
    def __init__(self):
        self._tickets: dict[bytes, tuple[float, DashboardCredential]] = {}
        self._sessions: dict[bytes, tuple[float, DashboardCredential]] = {}
        self._lock = Lock()

    @staticmethod
    def _issue(entries, credential, prefix, ttl):
        key = prefix + token_urlsafe(32)
        while len(entries) >= MAX_CREDENTIALS:
            del entries[next(iter(entries))]
        entries[_digest(key)] = (monotonic() + ttl, credential)
        return key

    def issue_ticket(self, credential: DashboardCredential) -> str:
        with self._lock:
            return self._issue(self._tickets, credential, "", TICKET_TTL)

    def redeem(self, ticket: str) -> str | None:
        with self._lock:
            entry = self._tickets.pop(_digest(ticket), None)
            if entry and entry[0] > monotonic():
                return self._issue(self._sessions, entry[1], SESSION_PREFIX, SESSION_TTL)
        return None

    def resolve(self, key: str) -> DashboardCredential | None:
        with self._lock:
            entry = self._sessions.get(_digest(key))
            if entry and entry[0] > monotonic():
                return entry[1]
        return None
