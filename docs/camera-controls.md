# Camera video and settings

Camera cards are generated from the selected device's real definitions. Supported categories such as `sp` and `dghsxj` receive a camera icon and Video action. Missing functions do not create invented controls.

## Main card and player

The main card offers privacy, motion detection, sound detection, and siren controls when writable functions exist. Privacy and Video are buttons; other quick Boolean controls use switches. These actions send immediately. Video expands a small live preview; collapsing it, opening full details, or hiding the page stops loading.

Full details place privacy beside the video action. Privacy blocks video while enabled or pending confirmation, stops active playback, and ignores late stream responses. Turning privacy off does not automatically start video.

The backend authorizes playback and returns a URL from the separate [camera module](camera-service.md). Connected local cameras use direct WebRTC playback from that module. Other cameras use temporary HTTPS HLS allocated through the selected Tuya connection, with playlists, media and keys relayed by the camera module. The smart-home backend carries no video bytes. HLS uses lazy-loaded hls.js or native browser support. Audio starts muted. Stopping playback releases the client connection. The application does not use the microphone or record browser video.

The player shows resolution, playback state, incoming video speed and a known Wi-Fi reading. HLS speed comes from segment transfers; WebRTC speed comes from received-video statistics. HD/SD selection uses actual HLS variants; a single profile has no quality switch. Download speed is not a Wi-Fi quality percentage.

The existing stream-allocation endpoint validates the selected account, device and privacy state, then returns a camera-module URL and playback type (WebRTC or HLS). These URLs are bearer capabilities and contain neither camera passwords nor the application key. The module holds tickets and signed provider URLs in memory. HLS tickets expire after three minutes without activity or two hours total; native tickets have a two-hour maximum. Both depend on a thirty-second backend-renewed lease, which stops when the Tuya connection changes. The deprecated stream endpoint also returns module playback. Reconnect after expiration or failure. Developer streaming needs the appropriate project permissions.

## Settings and explanations

Information icons open full descriptions of known functions and values, including disabled settings. They close through Escape, the close icon, or an outside click and do not send commands. Ordinary settings send changes automatically. Privacy sends immediately; formatting retains explicit confirmation.

| Section | Examples |
| --- | --- |
| Image and sound | Night vision, flip, timestamp overlay, anti-flicker |
| Detection and alerts | Motion/sound detection and sensitivity, human filter, region, siren |
| Recording and storage | Camera-side recording, mode, card capacity/state, format state |
| Additional parameters | Remaining declared functions and technical data |

Known Tuya values are translated without changing the command value or type:

| Code | Values |
| --- | --- |
| `basic_nightvision` | `0` Auto, `1` Off, `2` On |
| `basic_anti_flicker` | `0` Off, `1` 50 Hz, `2` 60 Hz |
| `motion_sensitivity` | `0` Low, `1` Medium, `2` High |
| `decibel_sensitivity` | `0` Low, `1` High |
| `record_mode` | `1` Event, `2` Continuous |

Sources: [camera commands](https://developer.tuya.com/en/docs/iot/f?id=K9gf47qbzhnj3) and [IPC functions](https://developer.tuya.com/en/docs/iot-device-dev/ipc_basic_solution_configuration?id=Kayhjmxb2v9li). Unknown modes retain their source value.

## Human detection

`humanoid_filter` is the declared Boolean human-event filter (standard DP 170). It identifies human-shaped motion, not an individual person's identity. The SDK passes the device's declared function and value; it does not establish whether that camera's firmware or subscription currently enables the algorithm.

Tuya documents both [device-side video detection](https://developer.tuya.com/en/docs/iot-device-dev/tuyaos-package-ipc-device?id=Kconga5qibmfx) and a separate [cloud image human-shape API](https://developer.tuya.com/en/docs/cloud/919e3d8d46?id=Kakfh3v9dyer2). The cloud API is not the DP switch. The available metadata does not prove that this specific model's feature is always free or paid. Check the model's Smart Life service terms.

## SD card and detection region

Recording and formatting require a known ready card. Absent/unknown storage disables those actions, even if a cached `record_switch` is true. Readiness is rechecked before submitting a draft. Formatting requires a deletion confirmation and is disabled while formatting is already in progress. Known raw `sd_status` codes are categorical rather than scaled measurements. The inspected Sleep Cam reported no ready card, despite a true cached recording switch.

The supported single-region format is `num:1` with `region0:{x,y,xlen,ylen}`. A red rectangle can be moved/resized over separately started video, using pointer, keyboard, or percentage inputs. Saving sends the selected area automatically. Cancellation keeps the original, unknown object fields are retained, and unsupported/multiple-region formats are not replaced by a fabricated rectangle.

## Limits

Two-way talk, browser snapshot/video saving, detection schedules, camera archive playback, cloud subscription pages, additional region formats, and P2P camera-quality control require separate APIs and implementation. Camera SD recording differs from browser recording. The application's device log is not the Smart Life video/event archive.

Historical playback testing confirmed direct Sleep Cam HLS at 640×360. The relay supports ordinary and low-latency HLS media over public HTTPS on ports 443, 554, and 8080. HLS variable substitution, content steering, external interstitial asset lists, and non-HTTPS key delivery are outside this relay's supported formats.
