# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build/frontend
RUN npm install --global pnpm@11.19.0
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
# Resolve the API on the browser's current host, including LAN addresses.
ENV VITE_API_BASE_URL=same-origin
ARG VITE_DASHBOARD_HTTPS_ORIGIN
RUN pnpm build

FROM debian:bookworm-slim AS frontend
RUN apt-get update \
    && apt-get install --no-install-recommends -y nginx-light curl gettext-base \
    && rm -rf /var/lib/apt/lists/*
COPY --from=frontend-build /build/frontend/dist/ /app/web/
COPY deploy/nginx*.conf /app/deploy/
ENV SMART_HOME_BACKEND_HOST=backend
USER www-data
EXPOSE 8080
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["curl", "--fail", "--silent", "--max-time", "3", "http://127.0.0.1:8080/"]
CMD ["/bin/sh", "-ec", "envsubst '$SMART_HOME_BACKEND_HOST' < /app/deploy/nginx.conf > /tmp/smart-home-nginx.conf; exec nginx -c /tmp/smart-home-nginx.conf -g 'daemon off;'"]

FROM python:3.14-slim-bookworm AS backend
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    SMART_HOME_DB=/app/data/smarthome.db \
    SMART_HOME_CLOUD_SESSION=/app/data/tuya-cloud.json
WORKDIR /app
RUN apt-get update \
    && apt-get install --no-install-recommends -y iproute2 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 smarthome \
    && useradd --uid 1000 --gid smarthome --no-create-home smarthome \
    && mkdir -p /app/data \
    && chown smarthome:smarthome /app/data
COPY pyproject.toml requirements.txt requirements-cloud.txt ./
COPY smarthome/ ./smarthome/
RUN pip install --no-cache-dir '.[cloud,postgres]'
COPY deploy/docker-entrypoint.sh /app/deploy/docker-entrypoint.sh
USER smarthome
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).close()"]
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/app/deploy/docker-entrypoint.sh"]
