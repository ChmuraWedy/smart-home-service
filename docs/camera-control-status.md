# Camera actions and connection status

Dashboard camera actions use the shared square icon switch component, with visible
labels and On/Off readings in a single row. Motion detection and sound detection
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

## Validation

- Lint, TypeScript and the production frontend build passed.
- 33 backend camera/access tests passed.
- The complete UI suite passed 449/450 tests in one run; the owner-onboarding test
  passed when rerun with its whole six-test file. An earlier combined-navigation
  timing failure also passed in isolation. No application behavior was changed to
  accommodate these timing failures.
- On 8082, browser DOM geometry confirmed three 44px camera action buttons at the
  same vertical position, with Motion detection and its On/Off state visible.
- Browser and API checks confirmed local-video/cloud-control labels, the verified
  unblocked MAC policy for the newly registered endpoint, and TRACER's existing
  blocked policy. Both Smart Life connections and the existing access key were
  preserved. No camera settings were changed during live verification.
