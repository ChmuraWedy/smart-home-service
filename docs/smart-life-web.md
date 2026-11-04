# Smart Life Web research

Historical check: **7 October 2026**. The owner confirmed a QR login to [Smart Life Web](https://eu.device.tuya.ai/login), and authorized inspection of that browser's network responses. The web session and this service's Sharing SDK are different clients; one login does not automatically authorize the other.

Tuya's [web product description](https://www.tuya.com/vas/commodity/OEM_WEB) described a public Smart Life/Tuya Smart web version. Product availability, advanced features, and subscription terms belong to Tuya and are not guaranteed by this historical check.

## Observed metadata

The tested account showed 44 devices, 19 online/25 offline, and topology with two gateways and 21 children. These are snapshot counts, not product limits.

| Data | Result |
| --- | --- |
| Names, device IDs, PID, category, online state | Present |
| Homes and rooms | Present in the tree/placement |
| Parent gateway | Visible in topology; `gateway_id`/`gatewayId` in child detail JSON |
| MAC and connection type | Present for the inspected Wi-Fi bulb |
| IP | Masked in UI; inspected JSON contained public WAN IPs, not usable LAN IPs |
| `local_key` / `localKey` | Absent from all 41 captured JSON responses |
| Zigbee node address | Matching separate `node_id`/`nodeId` fields in two sensor responses |
| LAN protocol 3.x | Not obtained; firmware/web API versions are not LAN versions |
| Export | UI export existed; its file was not verified. A local sanitized HAR was inspected |

Four devices were inspected through two detail APIs each: a direct Wi-Fi/Bluetooth bulb, a gateway, a Tuya Beacon child, and a Zigbee temperature sensor. All eight detail responses succeeded. Room trees, inventory/search, and service requests made up 41 captured JSON responses.

A graph node ID derived from `device.id` is not automatically the child `cid`. In the sensor's actual detail JSON, a separate node address differed from its cloud device ID, but using it for TinyTuya still requires LAN verification. A parent or node ID alone also does not prove Zigbee: the Beacon device had both.

Gateway flags contradicted each other across APIs. Future import must resolve that conflict rather than trust one flag. Absence of a key in these inspected routes does not prove no other Tuya route could return it.

## Observed web-client routes

These are research observations, not a stable public API contract:

- `/open-api/v1.0/m/sdf/space/trees` and `/space/home/tree`
- `/open-api/v1.0/m/sdf/device/pag/source-query`
- `/open-api/v1.0/m/sdf/device/capability/list`
- `/open-api/v1.0/m/sdf/device/index/<device_id>?project_id=<project_id>`
- `/open-api/v1.0/m/sdf/ss/industry/device/info/<project_id>/<device_id>?version=5.1`

The last route's `version=5.1` is a web-client API parameter, not Tuya LAN protocol 3.5. Inspected public client bundles referenced device export/task routes and topology construction. Missing secret field names in JavaScript cannot prove their absence from all server responses.

## Privacy and remaining work

HAR data was kept in private temporary files. A browser's “sanitized” export can still contain secrets in JSON bodies or custom headers. No account contents, real IDs, addresses, secrets, or raw captures were committed, and no device commands were sent.

A second browser session caused the first tab to return to QR login, but the cause was not established. A future web adapter would need verified login/refresh behavior, permissions, pagination, and parent reconciliation. No web adapter is implemented, and web tokens are not interchangeable with Sharing `token_info`.

The later [Sharing SDK check](qr-login.md#historical-hardware-check-7-october-2026) separately exposed key-presence metadata and gateway-key candidates in child records. That does not change the absence of keys from the inspected web JSON. Local control still needs a verified LAN IP, protocol, key, and, for Zigbee, gateway/child route.
