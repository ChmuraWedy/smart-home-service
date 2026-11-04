# Smart Home

A home dashboard and REST API for Tuya devices: control lights, read sensors, view camera video, and configure local connections from one interface.

Run it on your own server with Docker, or run the Python API and React interface separately. Local Wi-Fi and Zigbee gateway control uses TinyTuya; optional Smart Life and Tuya Developer connections provide cloud access. Each device has one card with an explicit choice of control method when several are available.

**English · Русский · Polski · Беларуская** | **System · Dark · Day themes**

[Quick start](#quick-start) · [Screenshots](#screenshots) · [Documentation](#documentation) · [API reference / Русский](docs/api-reference.md)

## What you can do

- Control power and individual switch channels directly from device cards. Open details for brightness, white temperature, color, timers, and supported lighting schedules/effects.
- Read temperature, humidity, motion, and battery information; inspect the device activity log and the source and age of readings.
- Search by name or alias, filter by room/building, edit device and channel aliases inline, and link directly to a device's details.
- View compatible camera HLS streams, including a small preview on the main card, with privacy and detection controls when the device exposes them.
- Discover LAN announcements and configure local device connections with separate discovery, verification, and confirmation before saving.
- Manage buildings, rooms, device types, groups, capabilities, and imports through the REST API.

Controls depend on the functions exposed by the device and the selected connection. Unknown or unsupported parameters remain read-only. Zigbee devices use a configured gateway; the network page observes LAN traffic and does not capture Zigbee radio traffic.

## Screenshots

Real device views captured in English, using Workroom lighting and WC2 sensors. WC2 appears as **Bathroom Second**, with device names **Bath2 temperature** and **Bath2 motion**, in this installation. Names and aliases are kept as configured.

### Workroom lighting

Main cards with power controls, independent switch channels, aliases, room, and connection status — Day theme.

![Workroom device overview with lamp power controls and a two-channel switch](docs/screenshots/workroom-overview-day.png)

| Bulb controls · Day | Two-channel switch · Dark |
| --- | --- |
| ![WorkRoomLamp1 details with power, white mode, brightness, color temperature, color, and lighting schedules](docs/screenshots/workroom-bulb-day.png) | ![WorkroomLigthSwith details with channel aliases, a channel timer, power-on state, and switch backlight settings](docs/screenshots/workroom-switch-dark.png) |

### WC2 sensors

Sensor details show labels, units, battery information, and connection context. The motion sensor also has a device activity log.

| Temperature and humidity · Day | Motion and activity log · Dark |
| --- | --- |
| ![Bath2 temperature sensor details with humidity, temperature, battery, and gateway connection](docs/screenshots/wc2-temperature-day.png) | ![Bath2 motion sensor details with motion status, battery, and the device log](docs/screenshots/wc2-motion-dark.png) |

[WC2 room overview](docs/screenshots/wc2-overview-day.png) · [Capture details and refresh instructions](docs/screenshots/README.md)

## Quick start

### Docker

Docker Compose builds the interface and API into a single service. From the repository root:

```sh
cp .env.example .env
chmod 600 .env
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Set `SMART_HOME_API_TOKEN` in `.env` to the generated value. To use Smart Life or Tuya Developer, also set `SMART_HOME_CLOUD_ENABLED=1`.

```sh
docker compose up -d --build --wait
```

Open `http://localhost:8080` or `http://<server-address>:8080`. In **Menu → Connections**, save the API address and the same service access key from `.env`. This key belongs to your own service; it is separate from Tuya account credentials and device local keys.

Devices and Tuya sessions are stored in the persistent Docker volume. For LAN discovery on a Linux server, use the host-network configuration in the [deployment guide](deploy/docker.md). The guide also covers Dell 5070 deployment, backups, and access-key rotation on each deployment.

### Connect your devices

1. **Smart Life:** enable cloud support, then follow the [User Code and QR login guide](docs/qr-login.md). Existing account devices appear without importing them into the local database.
2. **Tuya Developer:** configure your Access ID, Secret, and region using the [Developer connection guide](docs/developer-login.md).
3. **Local network:** use **Menu → Local connections** to discover and verify supported devices, review the results, and confirm which connections to save. Local control needs a device key and a reachable IP; Zigbee children also need their gateway and child address.

Cloud and local connections can coexist. A failed command is not automatically retried through another connection.

## Development

The backend requires Python 3.10+. The frontend requires Node.js `^22.22.2` or `>=24.15.0` and pnpm `11.19.0`, as declared in [frontend/package.json](frontend/package.json).

Start the API in one terminal:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[cloud,dev]'
export SMART_HOME_DB="$PWD/data/smarthome.db"
export SMART_HOME_API_TOKEN='replace-with-your-generated-service-key'
export SMART_HOME_CLOUD_ENABLED=1
export SMART_HOME_CORS_ORIGINS='http://127.0.0.1:5173,http://localhost:5173'
python -m uvicorn smarthome.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Start the interface in another terminal:

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173` and save `http://127.0.0.1:8000` and your service key in the connection settings. Swagger is available at `http://127.0.0.1:8000/docs`.

The standalone Python service does not automatically read `.env`; export its settings before starting it. Use one worker and one service instance because device/gateway command locks are held in memory.

### Checks

```sh
python -m pytest -q
ruff check .
cd frontend
pnpm test
pnpm build
```

[VERIFICATION.md](VERIFICATION.md) records previous verification results; [CHANGELOG.md](CHANGELOG.md) records changes.

## Architecture and data

The React + TypeScript + Vite interface calls a FastAPI service. SQLAlchemy and SQLite store configuration, mappings, and observations. TinyTuya handles local devices; the optional Sharing SDK and Developer connection handle cloud access. Production serves the built interface and proxies the API through nginx in one container.

Device local keys and Tuya credentials are handled by the server. The browser stores its service access key and UI preferences. Keep `.env`, databases, Tuya session files, and device exports out of Git; back them up privately. The included HTTP service is intended for a trusted LAN. Use a VPN or an HTTPS reverse proxy for remote access.

Command acceptance and a confirmed device reading are distinct. Logs contain events received since observation began, rather than the complete Smart Life history. See [status updates](docs/status-updates.md) and [activity logs](docs/device-activity.md).

## Documentation

Most detailed operating guides are currently in Russian; the interface supports all four languages.

| Topic | Guide |
| --- | --- |
| API, configuration, data model, imports, and examples | [API and operations reference](docs/api-reference.md) |
| UI, navigation, themes, local setup, and device controls | [Frontend guide](frontend/README.md) |
| Docker, Dell 5070, persistent storage, and deployment | [Deployment guide](deploy/docker.md) |
| Smart Life login / Tuya Developer login | [QR login](docs/qr-login.md) · [Developer access](docs/developer-login.md) |
| LAN discovery and packet observation | [Network guide](docs/packet-capture.md) |
| Lighting, switch channels, aliases, and mappings | [Switch controls](docs/switch-controls.md) · [Aliases](docs/device-aliases.md) · [Lighting and mappings](docs/device-linkage.md) |
| Camera controls and limitations | [Camera guide](docs/camera-controls.md) |
| Groups and room displays | [Displays](docs/displays.md) · [CYD firmware](firmware/cyd/README.md) |
| UI translation | [Localization guide](frontend/src/i18n/README.md) |
| Integration choices and supported profiles | [Integrations](docs/integrations.md) |
