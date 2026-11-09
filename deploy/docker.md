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

Open `http://<server-address>:8080`. The first-run wizard guides you through service access, Tuya sign-in, and optional local device import. Open **Connections → Open setup wizard** to revisit it. Browser credentials are stored per origin. The bridge configuration publishes only the frontend port. To change it, set `SMART_HOME_PORT` in `.env` and recreate the frontend.

For a new installation, you can let the wizard generate its first service key. Leave `SMART_HOME_API_TOKEN` empty and set `SMART_HOME_SETUP_CODE` to a random secret of at least 32 characters, for example one generated with `openssl rand -hex 32`. Open the wizard through HTTPS or a local loopback connection. With TLS termination, route `/api/v1/setup` through a trusted proxy that supplies the HTTPS scheme to the backend. The bundled HTTP nginx listener forwards its own scheme. Enter the setup code on the service access step and keep the generated key somewhere private. It is also stored in the persistent data volume beside the database. Remove the setup code from `.env` after provisioning. Existing service keys take precedence.

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

The backend applies pending database migrations at startup. SQLite stores the version in `PRAGMA user_version`. PostgreSQL stores it in `smart_home_schema_version`. A failed upgrade rolls back. Take a database backup before deploying a schema change. Developers append upgrades to `smarthome/migrations.py` in version order.

## Move an existing SQLite database to PostgreSQL

1. Provision a dedicated UTF-8 PostgreSQL database with an empty schema. Give the app database role permission to create and update objects in that schema. Make the database reachable from the backend. Use a private connection or configure PostgreSQL TLS.
2. Stop every backend writing to the SQLite database. Keep the existing volume and back up the SQLite database, service key, and Tuya session files. Keep the existing database path and back up `/app/data/smarthome.db.account-key-vault` if it exists so the service can still decrypt existing device keys. Keep the PostgreSQL URL in your protected `.env` as `SMART_HOME_DATABASE_URL`.
3. Build the backend and run the one-time transfer with the same Compose files used for your deployment. The Dell LAN stack uses both Compose files.

   ```sh
   docker compose -f compose.yaml -f compose.lan.yaml build backend
   docker compose -f compose.yaml -f compose.lan.yaml stop backend
   docker compose -f compose.yaml -f compose.lan.yaml run --rm --no-deps \
     --entrypoint smart-home-migrate-postgres backend --sqlite /app/data/smarthome.db
   ```

   For a Python installation, install `smart-home-service[postgres]`, export the PostgreSQL URL, and run `smart-home-migrate-postgres --sqlite /path/to/smarthome.db`.
4. Review the row counts and start the backend with the same URL. Verify authenticated inventory, room layouts, and device controls. Keep the current service key and the Tuya session files in their existing locations.

The transfer reads a consistent SQLite snapshot, upgrades that copy, and commits the PostgreSQL schema and data together. The source file stays intact. The command requires an empty target, so run it before starting the API with a new PostgreSQL URL. To return to SQLite before accepting writes in PostgreSQL, stop the backend, remove `SMART_HOME_DATABASE_URL`, and start with the original volume. After PostgreSQL accepts writes, returning to SQLite also requires reconciling those changes.

To run the PostgreSQL integration tests locally, install `.[dev,postgres]` and set `SMART_HOME_TEST_POSTGRES_URL` to a test database. The tests create and remove a separate schema for each case.

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
