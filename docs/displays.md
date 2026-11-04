# Groups and room displays

A display selects a room, then an arbitrary ordered list of devices and groups. The saved main screen contains only those widgets. Empty, mixed, and device-only selections are allowed; there is no fixed lamp/switch/sensor layout. Each display has its own persisted selection.

Groups reference real local devices. A group can contain 1–16 unique members with a writable Boolean `switch` capability. The small-display configuration supports up to 12 widgets and 12 distinct devices including group members. A device widget may select up to eight capabilities; an empty selection shows the first eight definitions.

```sh
# Assumes room 1 and devices 1–6 already exist.
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json'   -d '{"name":"Lights","room_id":1,"device_ids":[1,2,3]}' "$BASE/groups"
curl -sS -X PUT -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json'   -d '{"name":"Room panel","room_id":1,"widgets":[{"kind":"group","id":1},{"kind":"device","id":4},{"kind":"device","id":5,"capabilities":["temperature","humidity"]},{"kind":"device","id":6,"capabilities":["motion"]}]}'   "$BASE/displays/wall-panel"
curl -sS -X POST -H "X-API-Key: $TOKEN" "$BASE/displays/wall-panel/refresh"
curl -sS -H "X-API-Key: $TOKEN" "$BASE/displays/wall-panel/dashboard"
```

`BASE` includes `/api/v1`. Groups support list/create, detail/PATCH/DELETE, `/state`, and `/commands/on|off`. Displays support list, detail/PUT/DELETE, `/rooms`, `/options`, `/dashboard`, and `/refresh`. See the [API index](api-reference.md#endpoint-index).

`rooms` works before saving a display. `options` pages devices and groups independently with continuation flags. Display IDs are ASCII slugs, potentially derived from a display's MAC. PUT replaces the whole selection and persists it in SQLite; firmware also keeps a successful selection locally. [CYD firmware](../firmware/cyd/README.md) implements the panel UI.

All widgets and members must belong to the selected room. Device deletion/movement and group changes respect dependent panels; remove the selection first when required. Dashboard payloads exclude IPs, keys, raw DPS, and private write conditions.

Group state is `on`, `off`, `mixed`, or `unknown`, with member counts. Writes run sequentially and report individual failures; hardware updates are not an atomic transaction. An ACK from every member still does not confirm every observed state.

One background collector polls only selected devices, deduplicating repeated references. `SMART_HOME_DISPLAY_POLL_INTERVAL=30` controls the interval; `0` disables periodic polling. Explicit refresh returns 202 and queues a bounded request. Dashboard reads do not wait for network timeouts. Sleeping Zigbee sensors may remain unknown/stale until an actual supported report arrives. Use a single process/worker.
