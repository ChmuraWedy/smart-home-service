# Tuya Developer Access ID and Secret

This connection is independent of [Smart Life QR login](qr-login.md). In the [interface](../frontend/README.md), choose **Access ID / Secret**, enter the project credentials and data center, save them, then select **Check and connect**. Saving alone does not contact Tuya.

Find Access ID/Client ID and Access Secret/Client Secret in your cloud project's overview on the [Tuya Developer Platform](https://iot.tuya.com/). Link the Smart Life account through the project's device/account settings and authorize the required APIs. Access depends on project permissions and its active service plan. This application does not create projects or purchase subscriptions.

## Runtime and storage

The Developer client uses Python's standard library and Tuya HMAC-SHA256 request signatures. The core requirements are sufficient, with `SMART_HOME_CLOUD_ENABLED=1` and a nonempty service token. The optional Sharing SDK is needed for QR login, not for this client.

Supported region codes are `eu`, `eu-w`, `us`, `us-e`, `cn`, `in`, and `sg`. Select the project's region, not the server's location. An optional sample Device ID can identify its account when project-wide account listing is restricted. Without it, the client pages through linked account devices where permitted.

Credentials are atomically saved in a mode-0600 JSON file, by default the Sharing session path plus `.developer.json`. `SMART_HOME_DEVELOPER_SESSION` can select another path, which must differ from the Sharing session. This is an unencrypted secret file. Credentials are not returned by the API or stored in browser storage; fields are hidden after saving. Replacing them requires the complete pair.

Access tokens live in memory and are renewed when needed. After restart, saved credentials remain but the connection must be checked again. `connected` means successful validation in this process. Timeout is `SMART_HOME_CLOUD_TIMEOUT` (default 10 seconds, at most 30). Endpoints are fixed HTTPS addresses with TLS validation and no redirects. Commands are not automatically retried.

## API

All routes require the service `X-API-Key` and start at `/api/v1/cloud`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/developer/status` | Safe configured/connected/region indicators |
| PUT | `/developer/credentials` | Save `access_id`, `access_secret`, `region`, optional `sample_device_id` |
| POST | `/developer/connect` | Obtain a token and validate device access |
| DELETE | `/developer/credentials` | Remove local credentials/cache without revoking project permissions |
| GET | `/devices?provider=developer&refresh=true` | Authorized inventory without keys |
| GET | `/devices/{id}/status?provider=developer` | Read code-based status |
| GET | `/devices/{id}/functions?provider=developer` | Device definitions and writable functions |
| POST | `/devices/{id}/commands?provider=developer` | Validate and send commands |
| POST | `/imports/local-inventory?provider=developer` | Optional local inventory import |

Omitting `provider` selects Sharing. General cloud status exposes a separate Developer field. Developer scenes are not implemented and return 501; the Sharing scene list remains separate. Removing Developer credentials does not remove previously imported devices.

```sh
curl -sS -X PUT -H "X-API-Key: $TOKEN" -H 'Content-Type: application/json'   -d '{"access_id":"example-id","access_secret":"example-secret","region":"eu","sample_device_id":null}'   'http://127.0.0.1:8000/api/v1/cloud/developer/credentials'
curl -sS -X POST -H "X-API-Key: $TOKEN"   'http://127.0.0.1:8000/api/v1/cloud/developer/connect'
```

Import uses an explicit parent map in preference to provided gateway metadata. Shared keys do not establish parent links. Children need their actual node ID and an available parent. Use dry-run before saving; verify LAN IP, protocol, and capabilities afterward. A cloud command's code must exist in that device's writable functions. The app never automatically switches between Developer, Sharing, and local transport after a failure.

Sources: [Tuya signing](https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g) and [TinyTuya setup](https://github.com/jasonacox/tinytuya#setup-wizard---getting-local-keys). Mock API tests verify application behavior, not access to an arbitrary real Developer project.
