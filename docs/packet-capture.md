# LAN discovery and packet observation

The menu's **Network and packets** page works independently of Smart Life. It receives available LAN announcements, displays known network identities, and exports a local report. It does not reveal Zigbee radio traffic or automatically configure devices.

## Select the real network

The service lists its actual IPv4 interfaces and prefixes; select the subnet where the devices live before starting. The page does not assume a fixed third octet or silently scan another network. On a Linux container, use the [host-network override](../deploy/docker.md#linux-lan-discovery) to see the target's real interfaces.

Observation can receive Tuya UDP discovery on ports 6666/6667/7000, mDNS/SSDP announcements, and available neighbor-cache information. An explicit discovery action requests standard Tuya announcements. It is not a switch command, a TCP connection to every host, or a full TLS packet capture.

Rows can include the sender IP, declared Tuya ID and verified protocol version, MAC from the neighbor table, mDNS/SSDP service types, a validated host A-record name, counters, and recent IP changes. An ARP-only row is not evidence of a received packet or current reachability. Discovery is unauthenticated; it does not prove identity or justify automatically replacing inventory IPs.

A Zigbee sensor has no independent Wi-Fi IP. The page may see a gateway, but a Tuya announcement alone does not prove that it is a Zigbee gateway or identify its children. Missing packets do not mean offline.

## Network page API

All endpoints require the service key and use no-store responses:

| Method | Route under `/api/v1/network` | Purpose |
| --- | --- | --- |
| GET | `/interfaces` | Actual available interface addresses/prefixes |
| POST | `/scans` | Start with `{"interface_address":"192.168.1.10"}` |
| GET | `/scans/{scan_id}` | Read results and renew the lease |
| POST | `/scans/{scan_id}/discover` | Explicit standard discovery request |
| DELETE | `/scans/{scan_id}` | Stop observation |

The selected address must belong to an existing interface. Sessions share listeners with per-device watches: at most four network scans and 32 total watches, a 15-second renewable lease, and a 900-second maximum lifetime. The UI reads every three seconds and stops when hidden, navigated away, or reconnected elsewhere. Abandoned sessions expire and release sockets.

Memory holds up to 256 records, the last 200 events, and up to 20 IP changes per identity. Port and neighbor-table failures are reported independently. Stopping keeps the last UI snapshot. Export includes the selected network, addresses/IDs, services, changes, events, and counters, without session IDs, keys, tokens, raw packets, TXT records, or HTTP content. The report is downloaded locally.

## Observation from a device card

The device's home-network section starts a watch for its exact Tuya ID. A Zigbee watch uses an explicitly known local parent or cloud `gateway_id`; names, rooms, and neighboring packets do not establish that parent.

`POST /network/devices/{id}/watch?provider=sharing|developer|local` starts it. GET/DELETE `/network/watches/{watch_id}` reads/renews or stops it. The observed address comes from the packet's sender rather than an untrusted payload IP. History belongs only to this in-memory watch; it does not change saved connection settings. The same lease/lifetime behavior applies.

## Standalone capture tool

```sh
python tools/capture_tuya.py --seconds 900
```

Run from the repository root with dependencies installed. The tool passively receives and decodes Tuya UDP discovery; it does not issue commands. Duration is 1–3600 seconds, default 900, with limits of 100,000 packets/100 MiB. A new private `data/captures/<UTC timestamp>` directory holds mode-0600 output. `--output` selects a new directory without overwriting an existing one. Stop with Ctrl+C or a `stop` file in that directory.

| File | Contents |
| --- | --- |
| `packets.jsonl` | Times, addresses/ports, raw packet hex, decoded payload |
| `discovery.json` | Device/IP/version, first/last seen, counters |
| `status.json` | Active/finished state and totals |

Wait for READY before the owner's pairing/reconnection actions. Some devices only announce after a standard discovery request. `productKey` is a product identifier, not `local_key`; a Boolean `token` field is not an access token. UDP discovery is not the full activation exchange and does not supply an authenticated local key. Raw captures can contain private data and belong outside Git.

Ordinary Wi-Fi clients do not necessarily see other devices' unicast traffic. Full IP capture needs a traffic observation point and appropriate permissions; capturing TLS does not decrypt it. Zigbee radio analysis needs a suitable radio sniffer.

## Historical checks: 7 October 2026

A reconnection capture contained 498 decoded packets: 496 device messages and two explicit standard discovery requests. Thirteen devices were identified; four announced passively and nine more after requests. Three reconnected bulbs used protocol 3.5/6699 frames on UDP 7000. Payloads included identity/protocol/product metadata but no local-key field. Authorized Sharing metadata provided the keys separately; no device commands or database imports were performed.

A new-device capture contained 216 decoded packets: 163 device messages, 51 requests from another app client, and two explicit requests. One new account device's exact ID matched a UDP response and recent activation metadata. This established identity/address correlation, not verified local control. Real IDs, keys, raw captures, TLS activation, and Zigbee radio traffic are not included in Git.
