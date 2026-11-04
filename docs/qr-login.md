# Smart Life User Code and QR login

[Interface guide](../frontend/README.md) · [Independent Developer connection](developer-login.md)

Sharing uses the optional official `tuya-device-sharing-sdk==0.2.15`. It does not require this application's user to create a Tuya Developer project. Tuya's [integration guide](https://developer.tuya.com/en/docs/iot/Smart_Life_Integration?id=Kd0gk9baikbb7) explains User Code and QR confirmation. Availability and commercial terms belong to Tuya; historical availability is not a promise about future plans.

The default integration client ID and `haauthorize` schema are public identifiers used by the Home Assistant integration, not personal secrets. Mobile authorization can therefore be labeled Home Assistant. A commercial integration should obtain its own suitable client/schema and verify Tuya's terms. The service supports overriding these through environment settings.

## Setup

```sh
python -m pip install -e '.[cloud]'
export SMART_HOME_CLOUD_ENABLED=1
export SMART_HOME_API_TOKEN='replace-with-your-service-key'
export SMART_HOME_CLOUD_SESSION="$PWD/data/tuya-cloud.json"
python -m uvicorn smarthome.main:app --host 127.0.0.1 --port 8000 --workers 1
```

1. Start the [interface](../frontend/README.md) or use the Docker deployment.
2. In connection settings, save the API address and its service key. This is your server's key, separate from Tuya credentials.
3. Find **User Code** in Smart Life/Tuya Smart under **Me → Settings → Account and Security**, then save it in the interface.
4. Request a QR code, scan it with the mobile app, and confirm there.
5. Select the confirmation action in the web interface. Expired QR codes must be regenerated; their maximum lifetime is 120 seconds.

The application does not ask for your Tuya password or send the QR image to an external image generator. The old API `/cloud` URL can redirect to the separate interface when `SMART_HOME_FRONTEND_URL` is set.

## Persistence and account changes

The server stores User Code and confirmed access/refresh tokens atomically in a mode-0600 session file. Tokens are refreshed and persisted for restart. The file contains unencrypted secrets and must stay out of Git and public backups. The API does not return those values.

Saving a User Code alone makes no Tuya request and does not replace the active account. A new account becomes active only after its QR login is confirmed. Saving a new code cancels pending QR sessions. The UI hides saved fields behind an edit action without filling them with stored secrets.

A new browser needs the service key, but can use the Tuya account already connected on the server. Its key is saved in that browser's localStorage only after explicit saving and verification. Same-origin scripts can access it; hidden fields are not a substitute for API authentication. Updating this browser value does not change `SMART_HOME_API_TOKEN` on the server.

Deleting the local session also removes the saved User Code. It does not revoke another integration's Tuya authorization; manage remote permissions in Tuya. Sharing and Developer are independent sessions, and this service does not extract an installed Home Assistant's tokens.

## API

All routes below start with `/api/v1/cloud` and require `X-API-Key`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/status` | Safe enabled/connected/saved-code indicators |
| PUT | `/user-code` | Save `{user_code:...}` without a cloud request |
| POST | `/login/qr` | Create a login from an explicit or saved code |
| GET | `/login/{session_id}/qr.svg` | Authorized local SVG, no-store |
| POST | `/login/{session_id}/confirm` | Finish mobile-confirmed login |
| DELETE | `/session` | Remove the local Sharing session |
| GET | `/devices?refresh=true` | Device metadata and key-presence flags, never keys |
| GET | `/devices/{id}/status?refresh=true` | Selected-device HTTP snapshot plus newer reports |
| POST | `/devices/{id}/commands` | Validated Tuya-code commands |
| POST | `/imports/local-inventory` | Optional metadata/key import into the local database |
| GET | `/scenes` | Available Sharing scene catalog |

`refresh=false` reads the saved device cache. Cloud commands use function codes and validate writable definitions, types, enums, and ranges. ACK is acceptance, not confirmed physical change. [Status updates](status-updates.md) explains MQTT reports, timestamps, and sleeping sensors.

## Optional local import

Use actual IDs from the cloud inventory and an explicit parent map where required:

```sh
curl -sS -X POST -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json'   -d '{"device_ids":["gateway-id","child-id"],"parent_map":{"child-id":"gateway-id"},"dry_run":true}'   'http://127.0.0.1:8000/api/v1/cloud/imports/local-inventory'
```

Review the dry run before repeating with `dry_run:false`. A child needs a real node ID and parent. Keys go directly into the server database. WAN IPs are not reused as LAN addresses; protocol versions are not guessed. Existing usable placement, aliases, and connection settings are preserved when missing from new metadata. The [local connection wizard](../frontend/README.md#local-connections) separately discovers and verifies a reachable route before saving it.

## Historical hardware check: 7 October 2026

An owner-confirmed login returned 44 devices: 22 online, 42 with available keys/local support, and 23 marked `sub=true` with node IDs. Both displayed gateway rows lacked their own key field. Further inspection found two shared keys among 21 child records, grouping 16 and 5 devices. These were gateway-key candidates, not proof of which physical gateway they belonged to.

`sub=true`, equal keys, and a node ID alone do not prove Zigbee routing. Verify gateway identity and the actual child address on LAN. This distinction is also described by [tuya-local-key](https://github.com/vineetchoudhary/tuya-local-key#gateways). This historical read did not import devices or send control commands; no real IDs or keys were committed. The confirmed session survived restart.
