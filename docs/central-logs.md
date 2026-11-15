# Central device, service and DNS search

The Dell installation uses one VictoriaLogs instance for searchable device activity,
Docker service logs and dnsmasq DNS/DHCP logs. This complements the application's
existing activity API: no app database rows are removed or moved during rollout.

Search: `https://homeassistant.dom:8096/select/vmui/` (the other LAN aliases also work).
Username: `owner`. Password: the existing owner service key. The gateway stores only
its password hash and reuses the existing LAN TLS certificate/key. The collector
does not send an app key to the ingestion endpoint. This is an owner-only console:
it exposes both environments and LAN DNS queries, not household-member views.

## Sources and fields

| Category | Origin | Useful fields |
| --- | --- | --- |
| `device` | Read-only incremental export of `device_activity` from 8080 and 8082 | `device.id`, `device.parameter`, `device.value`, `event.kind`, `event.outcome`, `event.observed_at`, `device.scope` |
| `service` | Explicitly configured running Docker containers | `service.name`, `environment`, `container.name`, `log.level`, `_msg` |
| `dns` | Dell dnsmasq query logging (`log-queries=extra`) | `client.ip`, `dns.name`, `dns.type`, `dns.query_id`, `dns.answer`, `dns.response_code` |
| `dhcp` | Existing dnsmasq DHCP logs | `_msg`, `service.name` |

Queries in the built-in UI:

```text
event.category:device
event.category:device device.id:YOUR_DEVICE_ID
environment:8082 event.kind:command
event.category:dns client.ip:192.168.40.144
event.category:dns dns.response_code:NXDOMAIN
log.level:error
```

`device.ip` and names/room IDs are added where an existing local inventory record
provides them. Cloud-only IDs are not guessed from hostnames. Matching a DNS client
to a cloud-only device may require its saved LAN mapping. DNS query IDs are local
to a dnsmasq process and must be interpreted with the container ID/time/client.

## Collection and durability

`smart-home-log-collector.service` runs on the host; it uses the supported
`docker logs` interface (including Docker's binary `local` log driver). It polls
only the container names explicitly listed in `/etc/smart-home-logs/collector.json`.
Replacements with the same name are discovered by their actual container ID.
Initial service backfill is the last 24 hours of retained Docker logs. Initial
device backfill is all retained app activity within the 30-day central window.
Each app's own 2,000-entry cap still applies before export. DNS query history
starts when query logging is enabled; it cannot reconstruct older DNS queries.
The DNS source's `not_before` marks that activation time, avoiding a backlog of
older DHCP diagnostics. DHCP lease events are kept; verbose packet-option lines
are omitted from new ingestion.

The history adapter executes inside the current backend, using its existing
database connection with a read-only transaction and a statement timeout. It
does not initialize the application, refresh Smart Life, or send device commands.
The collector waits five seconds between bounded collection cycles; busy backfills
can take longer. There is no change to app/container logging drivers or app restarts.

An independent SQLite spool commits source cursors and pending events together.
Failed deliveries remain queued; a full 256 MiB queue stops advancing sources.
Collection resumes after the destination recovers. Delivery is **at least once**:
if the destination accepts a batch but its acknowledgement is lost, it may be
retried. `event.id` is stable; use it to identify duplicates. No exactly-once or
complete capture during an arbitrarily long outage is promised: upstream Docker
rotation or the app journal's cap can remove events before collection resumes.
This is an incremental exporter, not a transactional application outbox.

The separate camera service's existing stdout/stderr is included. Camera-native
commands/state changes absent from those logs and the app journal are **not yet
a complete device audit trail**. Device journal sources retain their original
meaning: accepted commands are distinct from physically observed state, and
snapshots remain distinguishable from actual reports.

Secrets are recursively removed from structured values, known secret strings are
redacted, and URL query strings, URL credentials, bearer/basic tokens and common
credential assignments are scrubbed before the durable queue. The deployment
creates a private exact-secret redaction inventory from current credentials;
refresh it when credentials are deliberately changed. No raw request bodies,
session files or container environments are shipped as logs. Redaction is defense
in depth: application producers must also avoid logging secrets.

## Isolation and limits

VictoriaLogs listens **only on host loopback port 9428**. Only authenticated
search routes are exposed through HTTPS 8096; remote ingestion, metrics and
administrative endpoints are not exposed. It uses a pinned image, unprivileged
UID, no capabilities, 384 MiB container memory and 0.5 CPU. The search gateway
is limited to 32 MiB. The collector has a 128 MiB systemd memory cap and 25% CPU.
The host collector has Docker access and must be treated as privileged even with
its hardened unit; no Docker socket is given to the log database or web gateway.

Central retention is 30 days with an 8 GiB retention threshold. VictoriaLogs drops
whole daily partitions: this threshold is not a strict filesystem quota, and
recent partitions can exceed it. Monitor free disk and ingestion rate. No
Elasticsearch/Kibana processes are added to the small Dell host.

## Deployment and rollback

Use `compose.logs.yaml` with private data/auth paths and the existing TLS directory.
Pin `SMART_HOME_LOGS_IMAGE` to the resolved digest and pin the compatible nginx
frontend image by its image ID. Install the collector/adapter under
`/usr/local/libexec`, its example configuration under `/etc/smart-home-logs`, and
the service unit under `/etc/systemd/system`. Never put credentials in Git.
`deploy/observability/deploy-dell.py` automates this additive installation on the
existing Dell layout. It checks both Smart Life sessions before and after, records
app container identities and key fingerprints, and stops only the new logging
services if verification fails. The runtime Compose environment pins the resolved
VictoriaLogs image digest and the existing nginx-compatible frontend image ID.

`deploy/observability/enable-dns-logging.py` updates both the managed DNS compiler
and its runtime image. It validates that logging is the entire generated config
diff, tests dnsmasq before a brief DNS-container restart, and verifies all three
DNS listeners afterwards. It preserves a timestamped compiler/config/image backup
and rolls back on verification failure. DNS/DHCP/firewall policies are unchanged.

To pause collection, stop `smart-home-log-collector`; the apps keep working. Stop
only the two `smart-home-logs` Compose containers to remove central search, keeping
their data/spool for recovery. DNS query logging can be reverted with the saved
compiler/config/image backup followed by a DNS-container restart. Never recreate
app containers or log out Smart Life as part of this rollback.

## App menu sign-in

On an owner dashboard, **Menu → Log search** opens the console in a new tab and
signs in automatically. Household members do not see this entry and cannot obtain
a handoff ticket. Set `SMART_HOME_LOG_SEARCH_URL=https://homeassistant.dom:8096`
on the backend serving the handoff and point the gateway's `/session` and internal
authorization subrequest at that backend. The example gateway uses preview 8082.

The owner key stays in the app's existing API request header. The app receives a
60-second, HMAC-signed ticket and submits it in an HTTPS POST body to `/session`.
The gateway exchanges it for a 30-minute signed cookie scoped to `/select/`, with
Secure, HttpOnly and SameSite=Lax. Tickets and cookies use distinct signing contexts
and are bound to the configured console origin. Neither contains the owner key;
no credentials appear in URLs or are forwarded to VictoriaLogs. This cookie only
authorizes the log console and cannot authenticate application API calls. Once it
expires, reopen Log search from the menu. App sign-out does not immediately revoke
an already-open console session; its maximum remaining lifetime is 30 minutes.
Existing owner Basic sign-in remains available, including if app handoff is down.

The backend and gateway must both be updated before enabling the menu capability.
No existing keys are rotated and no database migration is needed.

Validation: five backend tests cover owner/member access, expiration, tampering,
cookie scope, disabled setup and malformed handoffs. Nine UI tests cover the menu,
new-tab handoff, popup failure and existing tutorial navigation. Lint, TypeScript
and the frontend build pass. On 8082, the live menu click opened authenticated query
results without a credential prompt. Gateway checks also verified unauthenticated
rejection, Basic fallback and non-search route isolation. Both Smart Life sessions
and the existing key were preserved; production 8080 containers were unchanged.
