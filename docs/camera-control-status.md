# Camera actions and connection status

Dashboard camera actions use the same full-height icon cells as other device power
controls, in one uninterrupted row with equal-width cells filling the card. Labels and On/Off readings are available through
tooltips and accessible switch state, without extra captions or generic field grids.
Quick details use ordinary labeled buttons; there is no second Open in a frame
action inside an already-open camera popup. Motion detection and sound detection
are settings: On enables detection; they are not live motion/sound event indicators.
Only advertised writable controls are rendered. Unknown readings remain unknown,
and existing command confirmation/pending behavior is preserved.

Stale badges have an accessible explanation and tooltip: the displayed reading is
the last report, while the current physical state is unconfirmed. A stale badge in
a combined member summary no longer stretches to the row's full height.

Local video and local device controls are separate capabilities. A native video
binding without local controls returns `control: unavailable`. When a cloud device
uses that video binding, its access section uses the actual cloud device/provider
route. Both the header and access section therefore describe the settings route
consistently. The section explains that video can remain local while settings use
the selected cloud connection.

Unverified internet policy is distinct from a block. The access response identifies
missing MAC registration, unavailable policy service and absence of an individual
network endpoint. A verified unblocked result is described as “No device block at
the gateway”; this is not a claim that every possible upstream firewall allows
internet. Shared Zigbee gateways remain protected from individual-child blocking.

## Manual playback intent

The versioned browser preference `smart-home.ui.camera-playback-stopped.v1` remembers
an explicit Stop per API server and physical camera. Closing details, hiding and
remounting a preview, navigating rooms or reloading cannot override it. Watch video
clears that camera's preference and starts playback explicitly. Native and cloud
playback IDs share the physical camera identity supplied by CameraViewer. Automatic
privacy/visibility cleanup is not recorded as a manual Stop. Failed storage writes
retain the preference in memory for the current page, without claiming persistence
across a browser reload when storage is unavailable.

The local-control action is disabled and labeled Local control active when the
selected control route is already local. Refresh controls remains the explicit
LAN recheck action; the active-route button does not re-activate the device.

## Validation

Lint, TypeScript, the production frontend build and 46 focused tests passed. Tests cover
manual Stop across remounts, cloud/native identity changes, aborted allocations,
storage write failure, privacy cleanup, active local routes, ordinary quick-detail
buttons and the existing playback/control paths. All live validation preserves
camera privacy, physical device settings, WAN policies and existing credentials.
The 8082 browser check confirmed three full-width 64px-high action cells, the
disabled Local control active action, and manual Stop surviving details navigation
and a page reload. Both 8080 and 8082 remain healthy and connected to Smart Life;
the existing API key hashes match the deployment baseline.
