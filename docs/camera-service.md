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


Owner-only **Local controls** are available beside each provisioned camera in
Settings → Local cameras. Initial provisioning saves its existing LAN key and
verified DP schema privately inside the separate camera module; it does not
rotate the key. Subsequent reads, changes and service restarts need no Smart Life
login or internet. Re-pairing/resetting hardware can change its key and require
provisioning again. Video still travels directly to the camera service.

The backend forwards `/api/v1/cameras/{id}/controls`, `/commands`, `/move`, `/stop`
and `/siren` to the module. No credentials are returned to the browser. Controls
show fresh LAN readings and report an unconfirmed write explicitly. Movement is
limited to 300 ms per step with an unconditional Stop; the siren test is one second
with an unconditional Off. Stop is also available separately. Camera Privacy mode
must be known to be off before either bounded action is allowed.

TRACER was tested with its WAN blocked: night vision Auto/Off/On, anti-flicker
Off/50/60 Hz, volume, motion detection, sensitivity and tracking all returned the
requested settings. Four movement commands returned Stop afterward; physical
orientation should still be checked visually. The siren On-to-Off interval was
1.011 seconds with Off readback. Original settings were restored and the temporary
camera-only firewall rules removed. The other camera remains in Privacy mode and
was not provisioned for local controls.


The deployed owner API also returned fresh LAN readings before and after a
camera-service restart while TRACER's WAN remained blocked, using only the saved
configuration. No Smart Life session was created or refreshed. TRACER may omit
volume from a later full-status query; the UI displays No reading and still lets
the owner set it. An explicit LAN change report confirms the new volume, while
an empty command ACK does not. The volume test changed 1 → 2 → 1 offline.


Bound cameras show the same owner-only Local controls panel directly beneath the
video in full device details and dashboard quick views. The panel opens
immediately; its arrows send bounded LAN movement without replacing the player or
allocating a second stream. Local Privacy readings gate playback, and enabling
Privacy in that panel removes the live player. Native camera previews in Settings
use the same viewer. Unbound cameras retain their existing player and settings;
household members do not query the owner camera registry.

Some firmware omits the momentary Stop DP while streaming. The module exposes
`stop_sent` separately from `confirmed`; absent readback is unknown, and an
explicit mismatch remains a failure. This avoids treating a missing reading as a
failed motor stop. Automatic Stop is still unconditional after each bounded move.


LAN DNS aliases `duszadomu.dom`, `damawik.dom` and `moj.dom` point to the same
server through the managed resolver at 192.168.70.1. The dashboard certificate
covers all four names using the existing TLS private key and CA. The camera
service explicitly accepts the corresponding preview origins. Public DNS cannot
resolve these private names; clients need the LAN DNS or a `.dom` resolver rule.
Root-router forwarding for new aliases on retained networks requires router
administrative access. Each browser origin keeps its own saved service access
key, so signing into an alias/IP uses the same existing key again.
