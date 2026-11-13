# Device local control and internet access

The **Local control** section is shared by device details. It shows the selected control route and verified gateway internet policy. **Use local control** first verifies the saved LAN connection, then opens that device using the local route. Missing credentials/mappings must be configured in **Local connections**; this never re-pairs a device or rotates its key.

The optional gateway service runs `deploy/device-network.py` as a restricted root systemd service. The application remains unprivileged and communicates over a mounted Unix socket. It can only block/unblock registered endpoints; clients cannot supply MACs, interfaces or shell commands.

Install the script at `/usr/local/libexec/device-network.py`, the CLI at `/usr/local/bin/device-internet`, and `deploy/device-network.service` in `/etc/systemd/system/`. Create a root-owned `/etc/device-network/devices.json`, mode 0600, keyed by reserved device IPv4 address:

```json
{"192.168.40.50":{"host":"192.168.40.50","mac":"00:11:22:33:44:55","interface":"br40"}}
```

Enable `device-network.service`. Mount `/run/device-network:/run/device-network` into the backend and set `SMART_HOME_DEVICE_NETWORK_SOCKET=/run/device-network/policy.sock`. UID/GID 1000 may use this socket. Do not grant the backend NET_ADMIN or mount the Docker socket.

On the gateway, the same policy can be managed by MAC:

```sh
sudo device-internet status 00:11:22:33:44:55
sudo device-internet block 00:11:22:33:44:55
sudo device-internet unblock 00:11:22:33:44:55
```

Rules live in a separate `inet device_wan` table, priority -30, before established-connection accepts. Outbound internet is denied by MAC; return traffic uses the registered IP. Private IPv4 LAN destinations remain reachable. IPv6 from blocked devices is denied to prevent a bypass. The gateway must carry the device's WAN traffic; a device using another gateway cannot be blocked here. LAN proxies may also provide an indirect internet path. Use DHCP reservations and update the root-owned allowlist when endpoint addresses change.

Policy writes are atomic and saved under `/var/lib/device-network`; the service reapplies them after restart. Restoring access removes only this service's deny rules and does not override other network policy. Missing/unverifiable policy is shown as unavailable, never as allowed. Zigbee children and shared gateways cannot be individually isolated by this UI. Blocking one device does not log out Smart Life or affect other devices.
