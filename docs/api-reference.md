# API and operations reference

[Project overview](../README.md) · [Interface guide](../frontend/README.md) · [Docker deployment](../deploy/docker.md)

The service uses FastAPI, SQLAlchemy 2, SQLite, TinyTuya, and PyCryptodome. Python 3.10+ is required. The React interface is a separate application during development; the Docker image serves both through nginx. See the [quick start](../README.md#quick-start) for installation.

## Authentication and configuration

All `/api/v1/*` requests use `X-API-Key` when `SMART_HOME_API_TOKEN` is configured. `/health`, `/docs`, and `/openapi.json` are public. Standalone Python does not load `.env` automatically; Docker Compose does. An empty API token disables local API authentication; cloud endpoints require a configured service token.

| Setting | Default | Purpose |
| --- | --- | --- |
| `SMART_HOME_DB` | `./data/smarthome.db` | SQLite database |
| `SMART_HOME_API_TOKEN` | empty | Service access key |
| `SMART_HOME_TUYA_TIMEOUT` | `3` | Socket timeout, seconds |
| `SMART_HOME_LOCK_TIMEOUT` | `5` | Device/gateway lock timeout, seconds |
| `SMART_HOME_CORS_ORIGINS` | empty | Allowed browser origins, comma-separated |
| `SMART_HOME_FRONTEND_URL` | empty | Optional redirect from the old `/cloud` page |
| `SMART_HOME_DISPLAY_POLL_INTERVAL` | `30` | Poll selected display devices; `0` disables periodic polling |
| `SMART_HOME_NETWORK_MONITOR_ENABLED` | `1` | Start the shared passive Tuya announcement receiver |
| `SMART_HOME_CLOUD_ENABLED` | `0` | Enable optional Tuya cloud access |
| `SMART_HOME_CLOUD_SESSION` | application default | Sharing session file |
| `SMART_HOME_DEVELOPER_SESSION` | Sharing path + `.developer.json` | Developer credentials file |
| `SMART_HOME_CLOUD_TIMEOUT` | `10` | Cloud request timeout, seconds |

Use one worker and one service instance. Device/gateway locks and pending discovery results are held in memory. A request can include several bounded socket operations. Do not automatically retry commands: a missing HTTP response does not prove the device rejected the command.

Swagger at `/docs` and the generated `/openapi.json` describe request bodies, limits, and response schemas. Select **Authorize** in Swagger and enter the service key.

## Data model

```text
Building -> Room -> Device
DeviceType -> capability definitions -> Device
Gateway Device (wifi, is_gateway=true) -> child Device (zigbee, parent_id + cid)
Group -> local member devices
Display -> selected device/group widgets
```

- `id` is the numeric database identifier. `device_id` is the physical Tuya identifier; they are not interchangeable.
- A device can belong to a building without a room. Assigning a room derives its building. A conflicting explicit building returns 422.
- Clearing `room_id` leaves the building; clear both fields to remove all placement.
- A gateway is an ordinary Wi-Fi device with `is_gateway=true`. List gateways with `GET /api/v1/devices?is_gateway=true`.
- A Zigbee child uses the gateway's IP, protocol, and key. `cid` is its actual child address, not its Tuya device ID. `node_id` is an input alias for `cid`.
- Parent/child pairs must have compatible buildings. Nested gateways, cycles, and duplicate `(parent_id, cid)` pairs are rejected.
- Deleting records with dependent rooms, devices, children, groups, or display selections returns a conflict rather than silently removing dependencies.
- PATCH changes only supplied fields. `null` clears nullable fields. A supplied capability map replaces the map at that level.

## CRUD, search, and aliases

`buildings`, `rooms`, `device-types`, and `devices` support POST, GET list/detail, PATCH, and DELETE. List pagination uses `offset=0&limit=100`, with a maximum limit of 500.

Device filters include `building_id`, `room_id`, `device_type_id`, `parent_id`, `is_gateway`, `transport`, `unassigned`, `alias`, `name`, and `q`. `q` searches a Unicode-aware name substring; `name` searches an exact name. `%` and `_` are literal search characters. Rooms can also be filtered by building.

Names need not be globally unique. Use `/lookup/devices?name=...&room_id=...` to resolve an exact name within a scope. The corresponding building, room, and device-type lookup endpoints are listed below. No match returns 404; ambiguity returns 409 with a bounded, safe list of candidates. No command is sent when lookup is ambiguous.

Building, room, and device paths accept a numeric ID, a user alias, or an explicit `name:...` reference. URL-encode names in paths. For names containing `/`, use a query lookup instead. Device types use numeric IDs or their dedicated profile/slug interfaces.

Buildings, rooms, and devices have their current name as an automatic alias and up to 32 additional aliases. Alias lists are replaced as a whole; omitted fields preserve them, `[]` clears additional aliases, and `null` is rejected. Device aliases support Unicode letters and combining marks, spaces, digits, `.`, `-`, and `_`, with NFC normalization, trimmed edges, and lowercase normalization; the first character must be a letter. See [device aliases](device-aliases.md) for UI behavior and storage rules. Scope and validation for each resource are defined in OpenAPI. Alias conflicts return 409 atomically.

```sh
export BASE=http://127.0.0.1:8000/api/v1
export TOKEN='replace-with-your-service-key'
curl -sS -G -H "X-API-Key: $TOKEN" --data-urlencode 'q=light' "$BASE/devices"
curl -sS -G -H "X-API-Key: $TOKEN" --data-urlencode 'name=Desk light' \
  --data-urlencode 'room_id=1' "$BASE/lookup/devices"
```

## Control and capabilities

Local commands use numeric Tuya DPS. Cloud commands use Tuya function codes and explicitly select `provider=sharing|developer`. The service never silently falls back to another transport.

`GET /devices/{ref}/state` reads cached normalized observations; `?refresh=true` requests a device status. `/status` performs a live TinyTuya request. Each capability observation includes `value`, `known`, `stale`, and `observed_at`. A command ACK does not create a confirmed observation.

A local device's effective capabilities combine its type and device definitions. Supported concepts include Boolean switches, numbers, enums, read-only sensors, colors, and write-only actions. Profiles are explicit examples, not automatic product detection. Verify DP numbers, units, ranges, and formats for your hardware before using them.

| Capability field | Meaning |
| --- | --- |
| `dp` / `read_dp` | Write DP and optional separate feedback DP |
| `scale`, `offset` | `API value = raw value * scale + offset` |
| `minimum`, `maximum`, `step` | Limits in API units |
| `raw_type` | Raw numeric representation; integer writes round to a raw tick |
| `invert` | Invert Boolean values or reflect a numeric range |
| `value_map` | Explicit `{value, raw}` enum mapping with unambiguous reverse reading |
| `write_dps` | Constant companion values sent in the same packet |

Color encodings include HSV16, RGB+HSV8, and JSON HSV. The normalized HSV API uses hue 0–360 and saturation/value 0–1000. Color commands can include the required `colour` mode; white brightness and color temperature can include `white`. The color value's brightness component controls colored light; a separate brightness capability commonly controls white light.

```sh
curl -sS -H "X-API-Key: $TOKEN" "$BASE/profiles/bulb-v2"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/devices/desk_light/state?refresh=true"
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"values":{"switch":true,"color":{"h":120,"s":1000,"v":500}}}' \
  "$BASE/devices/desk_light/commands/capabilities"
```

The batch endpoint validates conflicting values for the same DP before sending. Hardware may require separate writes even when a combined packet is valid. Read-only definitions cannot be written. Raw `set_dps` is a low-level interface for known device commands, not a guarantee of support for every vendor format.

## Dashboard layouts

`GET` and `PUT /api/v1/dashboard-layouts/{browser_id}` use the usual service authentication. The browser keeps a random 32-character hexadecimal identifier. SQLite stores the layout separately for each identifier and combination of `building`, `room`, `columns`, and `page`.

`GET` and `PUT /api/v1/dashboard-layouts/{browser_id}/room-navigation` use the same browser identifier. The body has a `rooms` array of entries with a numeric `id` and a Boolean `hidden` flag. The array order determines room navigation across dashboard views. New rooms appear after the saved order.

Read or replace the layout as `{"slots":[null,"device-physical-id","group-2"]}`. Slots are ordered row by row, with `null` for empty cells. An unconfigured view returns `{"slots":[]}`.

## Smart Life topology

**Edit device room** saves the dashboard room assignment in this service. Local inventory uses its existing device record. Cloud-only devices use an account-scoped room override that takes precedence over imported placement.

**Sync Smart Life** reads homes and each device's room through Sharing. Homes become buildings; rooms and device placement are matched by Tuya IDs. Cloud cards can use this placement before local registration.

`POST /cloud/topology/sync` starts a background job; `GET /cloud/topology` returns the saved topology and progress. Refreshes preserve manual names, aliases, and placement. Automatically placed devices follow later cloud moves until placement is changed manually. Existing dependency constraints still apply; skipped moves appear as warnings.

A failed sync or account change does not partially replace the previous snapshot. Cache and jobs are account-scoped. Sharing discovers rooms through device assignments. A connected Tuya Developer project with access to the same homes can also provide the full room list, including empty rooms. Missing cloud entries do not automatically delete known rooms. This process does not change keys, IPs, capabilities, or Smart Life itself. Limits are 2,000 devices, 100 homes, and five minutes per job.

Device discovery uses existing room mappings and leaves unmatched devices under **No room**. Explicit room sync imports the rooms returned by Tuya, including rooms deleted locally, and refreshes device placement. App room assignments take precedence.

## Find, verify, and save local connections

The [local connection wizard](../frontend/README.md#local-connections) uses separate discovery and save endpoints. A search never writes configuration automatically.

1. `POST /local-connections/find`: supply the exact `device_id`, `provider`, and `interface_address` selected from `/network/interfaces`. `discovery_seconds` is 3–12, default 8.
2. Review the returned device preview, proposed `action`, changed fields, verified route, and `finding_id`. Key values are never returned.
3. `POST /local-connections/save` with `{"finding_id":"returned-id","confirmed":true}` saves only that verified preview. Confirmation must be the Boolean `true`.

The compatible `/gateways/find` and `/gateways/save` pair handles gateways. Results expire after five minutes, are single-use, and are limited to 16 pending results. Expiration, reuse, or a server restart requires a new search. Before saving, the service rechecks the account, network, key source, connection, and unchanged record.

Direct devices use only their own authorized key. Zigbee routing requires an explicit cloud gateway ID or an existing local parent; matching names, equal keys, or `sub=true` do not prove a parent relationship. Child requests configure the verified gateway connection, not an invented direct connection to the sensor. Gateway keys may be available in authorized child metadata but still require verification against the physical gateway.

Discovery matches an exact Tuya ID in the selected subnet, then verifies the key by reading through supported local protocols. Existing names, aliases, placement, capabilities, and child links are preserved; only verified connection fields are updated. No switching commands are sent. Allow at least 50 seconds for the gateway search and bounded verification operations.

Errors include 404 for no announcement/expired result, 409 for inconsistent or changed configuration, 429 for discovery throttling, 503 for unavailable ports, and 504 for verification timeout. The LAN packet page remains independent of Smart Life; the separate local connection setup explicitly uses an authorized account.

## Commissioning and imports

The optional commissioning endpoints collect device samples before registration. Observed changes alone do not identify a DP's purpose. Confirmed metadata can supply known writable capabilities; unknown DPS remain read-only. The obsolete per-function approval screen is no longer required by the UI.

TinyTuya JSON import accepts devices and an optional snapshot, upserts by physical device ID, and handles parents before children. It never guesses a missing gateway from shared keys. A child needs a real parent and `cid`/`node_id`. Alias conflicts and invalid links roll back the entire import. `dry_run:true` validates and rolls back without changing inventory.

```sh
python -m smarthome.cli --devices examples/devices.example.json \
  --snapshot examples/snapshot.example.json --dry-run
```

Use `POST /imports/tinytuya` for already-parsed JSON. Cloud imports use `/cloud/imports/local-inventory` with `device_ids`, optional explicit `parent_map`, and `dry_run`. Secrets go directly to the database, not the API response. WAN addresses are not imported as local IPs; missing usable fields preserve existing connection settings. Old snapshot DPS are not treated as fresh observations.

## Security, backup, and errors

`local_key` is write-only: supply it at creation, replace it through PATCH, or clear it with `null`. Responses expose only `has_local_key`. A key is 16 printable ASCII characters. Device and session secrets are stored unencrypted on the server; use private file permissions and private backups. The database is created with mode 0600. Keep real exports, databases, `.env`, and sessions out of Git.

Back up SQLite through its backup API or stop the service before copying its database. Include Tuya session files separately. Existing Docker data survives container recreation; do not use `down -v` when preserving data. Schema startup creates missing tables; future column changes require migrations.

| HTTP status | Meaning |
| --- | --- |
| 401 | Invalid/missing service key |
| 404 | Object or pending result not found |
| 409 | Conflict, ambiguity, or missing required configuration |
| 422 | Invalid fields, links, or capability values |
| 502 | Tuya failure or unusable device response |
| 503 | Busy device/gateway, database, or unavailable listener |
| 504 | Device/verification timeout |

Validation errors identify fields and error types without reflecting secret input. A timeout leaves the physical command outcome unknown. See [status updates](status-updates.md), [activity logs](device-activity.md), [camera controls](camera-controls.md), [groups and displays](displays.md), and [deployment](../deploy/docker.md).

## Endpoint index

This index is generated from the application's OpenAPI routes. Consult the live `/docs` for exact schemas and optional parameters.

### Buildings

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/buildings` | Add Building |
| GET | `/api/v1/buildings` | List Buildings |
| GET | `/api/v1/buildings/{item_id}` | Read Building |
| PATCH | `/api/v1/buildings/{item_id}` | Edit Building |
| DELETE | `/api/v1/buildings/{item_id}` | Delete Building |
| GET | `/api/v1/buildings/{item_id}/rooms` | Building Rooms |
| GET | `/api/v1/buildings/{item_id}/hierarchy` | Hierarchy |

### Rooms

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/rooms` | Add Room |
| GET | `/api/v1/rooms` | List Rooms |
| GET | `/api/v1/rooms/{item_id}` | Read Room |
| PATCH | `/api/v1/rooms/{item_id}` | Edit Room |
| DELETE | `/api/v1/rooms/{item_id}` | Delete Room |
| GET | `/api/v1/rooms/{item_id}/devices` | Room Devices |

### Profiles

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/profiles` | List Profiles |
| GET | `/api/v1/profiles/{identifier}` | Read Profile |

### Device types

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/device-types` | Add Type |
| GET | `/api/v1/device-types` | List Types |
| GET | `/api/v1/device-types/{item_id}` | Read Type |
| PATCH | `/api/v1/device-types/{item_id}` | Edit Type |
| DELETE | `/api/v1/device-types/{item_id}` | Delete Type |

### Devices

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/devices` | Add Device |
| GET | `/api/v1/devices` | List Devices |
| GET | `/api/v1/devices/{item_id}` | Read Device |
| PATCH | `/api/v1/devices/{item_id}` | Edit Device |
| DELETE | `/api/v1/devices/{item_id}` | Delete Device |
| GET | `/api/v1/devices/{item_id}/children` | Children |
| PUT | `/api/v1/devices/{item_id}/translations` | Save Local Translations |

### Control

`refresh=false` reads saved state. Add `watch=true` while a local card is visible to renew its three-second background collection lease; the server reads that device at a five-second interval. The HTTP response still comes from the cache. `refresh=true` explicitly performs an immediate device read.

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/devices/{item_id}/state` | Normalized State |
| POST | `/api/v1/devices/{item_id}/commands/capabilities` | Set Capabilities |
| POST | `/api/v1/devices/{item_id}/commands/status` | Status |
| GET | `/api/v1/devices/{item_id}/status` | Status |
| POST | `/api/v1/devices/{item_id}/commands/on` | Turn On |
| POST | `/api/v1/devices/{item_id}/commands/off` | Turn Off |
| POST | `/api/v1/devices/{item_id}/commands/set_dps` | Set Dps |
| PUT | `/api/v1/devices/{item_id}/capabilities/{capability}` | Capability Value |
| POST | `/api/v1/devices/{item_id}/commands/brightness` | Brightness |
| POST | `/api/v1/devices/{item_id}/commands/color` | Color |
| POST | `/api/v1/devices/{item_id}/commands/temperature` | Temperature |

### Import

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/imports/tinytuya` | Import Devices |

### Search

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/lookup/buildings` | Buildings Lookup By Name |
| GET | `/api/v1/lookup/rooms` | Rooms Lookup By Name |
| GET | `/api/v1/lookup/devices` | Devices Lookup By Name |
| GET | `/api/v1/lookup/device-types` | Device-Types Lookup By Name |
| GET | `/api/v1/lookup/buildings/alias` | Buildings Lookup By Alias |
| GET | `/api/v1/lookup/rooms/alias` | Rooms Lookup By Alias |
| GET | `/api/v1/lookup/devices/alias` | Devices Lookup By Alias |

### Aliases

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/buildings/{item_id}/aliases` | Buildings Aliases |
| POST | `/api/v1/buildings/{item_id}/aliases` | Buildings Add Alias |
| DELETE | `/api/v1/buildings/{item_id}/aliases/{alias}` | Buildings Delete Alias |
| GET | `/api/v1/rooms/{item_id}/aliases` | Rooms Aliases |
| POST | `/api/v1/rooms/{item_id}/aliases` | Rooms Add Alias |
| DELETE | `/api/v1/rooms/{item_id}/aliases/{alias}` | Rooms Delete Alias |
| GET | `/api/v1/devices/{item_id}/aliases` | Devices Aliases |
| POST | `/api/v1/devices/{item_id}/aliases` | Devices Add Alias |
| DELETE | `/api/v1/devices/{item_id}/aliases/{alias}` | Devices Delete Alias |

### Groups

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/groups` | Create Group |
| GET | `/api/v1/groups` | List Groups |
| GET | `/api/v1/groups/{group_id}` | Read Group |
| PATCH | `/api/v1/groups/{group_id}` | Edit Group |
| DELETE | `/api/v1/groups/{group_id}` | Delete Group |
| GET | `/api/v1/groups/{group_id}/state` | Read Group State |
| POST | `/api/v1/groups/{group_id}/commands/{command}` | Group Command |

### Displays

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/displays` | List Displays |
| GET | `/api/v1/displays/{display_id}` | Read Display |
| PUT | `/api/v1/displays/{display_id}` | Save Display |
| DELETE | `/api/v1/displays/{display_id}` | Delete Display |
| GET | `/api/v1/displays/{display_id}/rooms` | Display Rooms |
| GET | `/api/v1/displays/{display_id}/options` | Display Options |
| GET | `/api/v1/displays/{display_id}/dashboard` | Read Dashboard |
| POST | `/api/v1/displays/{display_id}/refresh` | Refresh Display |

### Cloud

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/cloud/status` | Cloud Status |
| GET | `/api/v1/cloud/developer/status` | Developer Status |
| PUT | `/api/v1/cloud/developer/credentials` | Developer Credentials |
| DELETE | `/api/v1/cloud/developer/credentials` | Developer Logout |
| POST | `/api/v1/cloud/developer/connect` | Developer Connect |
| PUT | `/api/v1/cloud/user-code` | Save User Code |
| POST | `/api/v1/cloud/login/qr` | Begin Login |
| GET | `/api/v1/cloud/login/{session_id}/qr.svg` | Qr Code |
| POST | `/api/v1/cloud/login/{session_id}/confirm` | Confirm Login |
| DELETE | `/api/v1/cloud/session` | Logout |
| GET | `/api/v1/cloud/devices` | Devices |
| POST | `/api/v1/cloud/imports/local-inventory` | Import Local Inventory |
| GET | `/api/v1/cloud/devices/{device_id}/status` | Cloud Device Status |
| GET | `/api/v1/cloud/devices/{device_id}/functions` | Cloud Device Functions |
| PUT | `/api/v1/cloud/devices/{device_id}/channel-labels` | Save Channel Labels |
| POST | `/api/v1/cloud/devices/{device_id}/commands` | Cloud Commands |
| GET | `/api/v1/cloud/scenes` | Cloud Scenes |
| PUT | `/api/v1/cloud/devices/{device_id}/room` | Assign Device Room in App |
| GET | `/api/v1/cloud/topology` | Get Topology |
| POST | `/api/v1/cloud/topology/sync` | Sync Topology |
| GET | `/api/v1/cloud/devices/{device_id}/aliases` | Read Aliases |
| PUT | `/api/v1/cloud/devices/{device_id}/aliases` | Save Aliases |
| PUT | `/api/v1/cloud/devices/{device_id}/translations` | Save Cloud Translations |

### Camera

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/cloud/devices/{device_id}/stream` | Camera Stream |

### Commissioning

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/commissioning` | Start |
| POST | `/api/v1/commissioning/devices/{device_id}` | Start Existing |
| POST | `/api/v1/commissioning/{token}/samples` | Sample |
| DELETE | `/api/v1/commissioning/{token}` | Cancel |
| POST | `/api/v1/commissioning/{token}/register` | Register |

### Network

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/network/devices/{device_id}/observation` | Read Shared Device Observation |
| POST | `/api/v1/network/devices/{device_id}/watch` | Start Watch |
| GET | `/api/v1/network/watches/{watch_id}` | Read Watch |
| DELETE | `/api/v1/network/watches/{watch_id}` | Stop Watch |
| GET | `/api/v1/network/interfaces` | List Interfaces |
| POST | `/api/v1/network/scans` | Start Scan |
| GET | `/api/v1/network/scans/{scan_id}` | Read Scan |
| DELETE | `/api/v1/network/scans/{scan_id}` | Stop Scan |
| POST | `/api/v1/network/scans/{scan_id}/discover` | Discover Scan |

### Gateways

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/gateways/find` | Find |
| POST | `/api/v1/gateways/save` | Save |

### Local connections

| Method | Path | Operation |
| --- | --- | --- |
| POST | `/api/v1/local-connections/find` | Find Connection |
| POST | `/api/v1/local-connections/save` | Save Connection |

### Activity

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/api/v1/activity/devices/{device_id}` | History |

### System

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/health` | Health |
