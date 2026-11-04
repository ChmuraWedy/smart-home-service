# Docker deployment and Dell 5070

The Dell 5070 is the target computer, not a port number. The web port defaults to **8080**. [Dockerfile](../Dockerfile) builds React and the Python API into one image, with nginx serving the static UI and proxying API requests. No Node.js runtime is needed on the target outside the build container.

## Build and start

From the repository root:

```sh
cp .env.example .env
chmod 600 .env
```

Set a generated `SMART_HOME_API_TOKEN`; use `SMART_HOME_CLOUD_ENABLED=1` for cloud connections. Keep credentials out of source files, Dockerfile, and frontend build variables. Compose reads `.env`; the standalone Python service does not.

```sh
docker compose up -d --build --wait
```

Open `http://<server-address>:8080`, then save the API address and service key in connection settings. Browser credentials from another origin do not automatically transfer. The Python API port is not separately published.

The ordinary Compose configuration binds `0.0.0.0:${SMART_HOME_PORT:-8080}`. Change `SMART_HOME_PORT` and recreate the service to use another host port.

## Linux LAN discovery

```sh
docker compose -f compose.yaml -f compose.lan.yaml up -d --build --wait
```

The LAN override uses Linux host networking so discovery sees the target computer's real interfaces. nginx listens directly on 8080 and the API only on `127.0.0.1:8000`; `SMART_HOME_PORT` does not change this override. Check both ports first. The container does not require privileged mode.

Bridge networking exposes container interfaces and is not equivalent to observing the host LAN. Docker Desktop host networking cannot provide the same direct access to a Mac's physical interfaces. See [Docker host networking](https://docs.docker.com/engine/network/drivers/host/) and [Compose merge/reset](https://docs.docker.com/reference/compose-file/merge/#reset-value).

## Persistent data and migration

The `smart-home-service_smart-home-data` volume contains the SQLite database, Tuya sessions, and reports. Container recreation and ordinary `docker compose down` preserve it; `down -v` deletes it.

Paths inside the container are:

- `/app/data/smarthome.db`
- `/app/data/tuya-cloud.json`
- `/app/data/tuya-cloud.json.developer.json`

Back up SQLite with its backup API or stop the old service before copying its database. Include session files. Never overwrite an existing target volume as part of a routine update. For an initial migration into an empty volume, ensure UID/GID `1000:1000`, directories 0700, and files 0600. Migration does not send device commands.

The app runs as an unprivileged user, restarts after failure, uses one API worker, and shuts nginx/API down together. The image excludes `.env` and runtime state. Keep its HTTP access within a trusted LAN or provide a VPN/HTTPS reverse proxy.

## Build on another computer

For an x86-64 Dell target:

```sh
docker buildx build --platform linux/amd64 --load -t smart-home-service:dell5070 .
```

Transfer with `docker save`/`docker load`, set `SMART_HOME_IMAGE=smart-home-service:dell5070` in the target `.env`, and run Compose without rebuilding. Transfer source separately if needed, excluding `.git`, `.venv`, `node_modules`, `.env`, and data.

## Deployment key rotation

The existing Dell activation helper is run from the controlling Mac after the merged image/source have been uploaded:

```sh
python3 deploy/activate-dell.py
```

Consult `--help` for target settings. The helper activates the ready image; it does not build or upload it. Each deployment generates a new random service key, transfers it over SSH standard input, atomically updates the private local/Dell environment files, recreates the container, waits for health, and checks authorization and inventory. Routine restart does not rotate the key.

Browser connections must then save the new `SMART_HOME_API_TOKEN` from the local `.env`. The key is never printed in deployment output or passed in command arguments. Existing Tuya sessions, device keys, and other environment settings are preserved. Local and target keys must initially match.

Failed activation/authorization checks restore the previous image and environment where possible. Private `.env.before-deploy` backups are ignored by Git. If SSH loses the final outcome, `.env.pending-deploy` retains recovery information privately: inspect the actual target state and reconcile before retrying. Unknown results are not automatically repeated. Concurrent activation is locked.

## Verification

```sh
docker compose ps
curl http://127.0.0.1:8080/health
```

Health should return `status:ok`; unauthenticated `/api/v1/devices` should return 401. Verify authenticated inventory and UI from another LAN computer. Check preservation of saved connections and the actual selected discovery network. Deployment verification does not require operating lights or other actuators.
