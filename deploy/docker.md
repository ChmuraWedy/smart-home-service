# Docker deployment and Dell 5070

The [Dockerfile](../Dockerfile) builds two images. The `frontend` target serves the compiled React app through nginx on port **8080**. The `backend` target runs the Python API on port **8000**. Nginx forwards API requests so browsers continue to use one address. The backend alone receives the service key and mounts the persistent data volume.

## Build and start

From the repository root:

```sh
cp .env.example .env
chmod 600 .env
```

Set a generated `SMART_HOME_API_TOKEN`. Set `SMART_HOME_CLOUD_ENABLED=1` to enable cloud connections. Compose reads `.env` and passes it to the backend.

```sh
docker compose up -d --build --wait
```

Open `http://<server-address>:8080` and save the API address and service key in connection settings. Browser credentials are stored per origin. The bridge configuration publishes only the frontend port. To change it, set `SMART_HOME_PORT` in `.env` and recreate the frontend.

## Work on one image

Once both services are running, build and replace either one independently:

```sh
docker compose up -d --no-deps --build --wait frontend
docker compose up -d --no-deps --build --wait backend
```

Run only the line for the service you changed. Set `SMART_HOME_FRONTEND_IMAGE` and `SMART_HOME_BACKEND_IMAGE` in `.env` to select independently tagged builds. After loading a prebuilt image, use `--no-build` in place of `--build`. These operations preserve the service key.

For a second test stack, run the bridge configuration from a separate checkout with its own `.env`, key, and `SMART_HOME_PORT`. Use `docker compose -p smart-home-test up -d --build --wait` to create a separate project and volume. Disable cloud connections and passive discovery in test environments that use sample data.

## Linux LAN discovery

```sh
docker compose -f compose.yaml -f compose.lan.yaml up -d --build --wait
```

On the Dell, use both files for independent updates too. Host networking lets the backend listen for device announcements on the physical network. Nginx listens directly on 8080, and the API binds to `127.0.0.1:8000`. Check both ports first. The host-network setup uses port 8080 regardless of `SMART_HOME_PORT`.

Bridge networking sees container interfaces. See [Docker host networking](https://docs.docker.com/engine/network/drivers/host/) and [Compose merge rules](https://docs.docker.com/reference/compose-file/merge/#reset-value).

## Smart Life through ReDroid

Run the ReDroid controller API on the Linux host and set `SMART_HOME_REDROID_TOKEN_FILE` in the dashboard's `.env` to the controller token file. Set `SMART_HOME_REDROID_PORT` if the API uses a port other than 18765.

```sh
docker compose -f compose.yaml -f compose.lan.yaml -f compose.redroid.yaml up -d --build --wait
```

In Connections, choose **Smart Life / Android**, then **Use existing Android session**. The backend talks to the controller on the host's loopback interface. If you serve the dashboard over HTTPS, set `VITE_DASHBOARD_HTTPS_ORIGIN` to its HTTPS origin before building so HTTP clients can open the password form on the secure page.

## Automatic device label translations

The optional Linux service generates display translations after saving device names and aliases. It preserves saved translations and falls back to the original when the model skips a label or the service is unavailable. Short labels can produce incorrect translations, particularly in Belarusian. Device settings let you correct the translations.

```sh
docker compose -f compose.yaml -f compose.lan.yaml -f compose.label-translator.yaml up -d --build --wait
```

Building the image downloads the model files. Device labels are processed on the host at runtime over loopback. The service uses [Meta's M2M100 418M](https://huggingface.co/facebook/m2m100_418M) in an [INT8 conversion](https://huggingface.co/auralmira/m2m100-418M-ct2-int8) and [fastText language identification](https://fasttext.cc/docs/en/language-identification.html).

## Upgrade an existing Dell installation

Keep the existing project name `smart-home-service`, environment file, and volume. Save the previous release files and image tag for rollback. Back up SQLite with its backup API and copy the Tuya session files. Build both split images before stopping the old service.

Stop the old `smart-home-service-smart-home-1` container and leave it available for rollback. Then start the two services using the LAN command above. Verify the web app, authenticated inventory, and LAN discovery before removing the old container. If activation fails, stop the two new services and restart the old container. Keep a database backup in case an update also changes the database schema.

The `smart-home-service_smart-home-data` volume contains the database, reports, and session files at:

- `/app/data/smarthome.db`
- `/app/data/tuya-cloud.json`
- `/app/data/tuya-cloud.json.developer.json`

Ordinary updates preserve the volume. For a manual import into a new volume, use UID/GID `1000:1000`, directories with mode 0700, and files with mode 0600. Both containers run as unprivileged users. Keep HTTP access within a trusted LAN or use a VPN or HTTPS reverse proxy.

The backend applies pending SQLite migrations at startup. It records the schema version in `PRAGMA user_version` and rolls back the upgrade if a migration fails. Take a database backup before deploying a schema change. Developers append upgrades to `smarthome/migrations.py` in version order.

## Build on another computer

For an x86-64 Dell target:

```sh
docker buildx build --platform linux/amd64 --target frontend --load -t smart-home-frontend:dell5070 .
docker buildx build --platform linux/amd64 --target backend --load -t smart-home-backend:dell5070 .
```

Transfer either image with `docker save` and `docker load`, select its tag in `.env`, and use the corresponding Compose command with `--no-build`. The legacy `activate-dell.py` key-rotation helper applies only to the earlier single-container stack.

## Verification

```sh
docker compose ps
curl http://127.0.0.1:8080/health
```

Check that both services are healthy and that `/health` returns `status:ok` through nginx. An unauthenticated `/api/v1/devices` request should return 401. Verify authenticated inventory and the web app from another LAN computer. Check the selected discovery network when using the LAN configuration.
