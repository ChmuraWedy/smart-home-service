# Separate camera module

Discovery, ONVIF connections, local stream credentials, media processing and HLS relay live in [smart-home-cameras](https://github.com/ChmuraWedy/smart-home-cameras).

The backend checks device membership, camera type and privacy mode, asks the module for playback, and returns its direct client URL. It does not read playlists, download segments, remux or proxy video. Local bindings take priority; otherwise the existing Smart Life or Tuya Developer connection allocates HLS and hands the URL privately to the camera module.

~~~dotenv
SMART_HOME_CAMERA_SERVICE_URL=http://127.0.0.1:8095
SMART_HOME_CAMERA_PUBLIC_URL=https://your-camera-service-origin
# Optional if the module uses the existing main service key:
SMART_HOME_CAMERA_SERVICE_TOKEN=
~~~

Deploy the module independently from its repository. Configure its matching CAMERA_API_TOKEN, CAMERA_PUBLIC_URL, dashboard CORS origins, discovery interfaces and WebRTC candidates. Existing application keys and PostgreSQL data do not need to change.

Use **Settings → Local cameras** to discover/connect cameras and optionally associate them with Smart Life devices. Independent ONVIF cameras can also be watched there. Native playback uses WebRTC; cloud-only cameras use HLS. Optional H.264/Opus conversion handles browsers needing another codec.

Keep the camera origin reachable from clients. HTTPS dashboards require HTTPS camera URLs and WSS signalling. WebRTC media reaches the module directly over its configured candidate port, bypassing the smart-home backend and frontend reverse proxy.

The authenticated camera control API remains here under /api/v1/cameras. The existing /api/v1/cloud/devices/{id}/stream/relay allocation path stays compatible but returns a camera-module URL. Old backend /api/v1/camera/play/* media endpoints are removed. An unconfigured backend returns a clear 503 for playback. Deploy the module and backend together when enabling this integration.

Provider access uses thirty-second scope leases renewed every five seconds. Disconnected providers are revoked. If the backend becomes unavailable, the module expires the lease within thirty seconds. This control traffic carries no media.

TRACER FOCUS 3 has been tested in the separate image and a real browser. A separate Tuya camera research probe starts H.264 WebRTC through authenticated LAN signalling with WAN blocked, including after a fresh client container starts. Camera power-cycle recovery and credential longevity remain unverified. The module image includes that on-demand adapter and retains its standard Tuya HLS fallback. See the camera repository's research/tuya-camera.md for evidence.

The optional compose.cameras.yaml builds the module directly from its pinned GitHub commit. No camera-module source is copied into this app repository. Supply the private-repository GIT_AUTH_TOKEN to BuildKit for the build; it is not a runtime environment variable or image layer. The module records its upstream repositories and exact revisions in upstreams.json and fetches the LAN/WebRTC dependencies as remote Go modules. Reuse the existing application credential for camera control.

For HTTPS dashboards, serve the camera origin over HTTPS too. The module supports mounted CAMERA_TLS_CERT and CAMERA_TLS_KEY. A backend using a private LAN CA must trust that CA through a combined SSL_CERT_FILE bundle; retain the public roots. Camera playback uses the direct origin and the configured WebRTC media port. An isolated Docker backend should reach the host through its bridge gateway rather than the host's external LAN address.

The 8082 preview preserves its separate PostgreSQL database and existing key. Open Settings, expand Local cameras, and use Watch video on either connected camera. This owner-only path works independently of the preview's disabled cloud session; the production Smart Life connection is unchanged. Camera hardware restart testing is deferred.
