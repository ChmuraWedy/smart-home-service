# Experimental Tuya camera LAN probe

This standalone tool tests the camera's authenticated LAN session and measures whether sustained H.264 video arrives. The library is pinned to `github.com/luukvisser/tuya-lan v0.1.0`. This is a compatibility experiment, separate from the dashboard's existing cloud video player.

The tool discards video and audio and prints a JSON result. A successful LAN handshake alone does not pass the video test. The video test requires packets with multiple timestamps, valid dimensions, and at least five seconds of continuing video delivery.

## Build and configure

Build from this directory with Go 1.26.2 or the included Dockerfile.

```sh
docker build -t smart-home-camera-lan-probe .
```

Create a mode-0600 configuration outside the repository, containing the camera's device ID, current private IPv4 address, explicit protocol version, current 16-byte local key, account UID, and camera P2P password. The P2P password comes from the device RTC configuration and is distinct from the Smart Life account password.

`export_config.py` can run inside the existing backend container to export the saved local mapping and UID. It accepts `--device-id`, `--output`, and optionally `--rtc-config`. It opens the output exclusively with mode 0600 and never prints credentials. Check that the saved local key still matches Tuya's current device record. The Sleep Cam investigation found that it did not.

## Test

Mount the private configuration read-only. Host networking permits the camera's UDP media to reach the probe on Dell.

```sh
docker run --rm --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -v /private/path/camera.json:/run/secrets/camera.json:ro \
  smart-home-camera-lan-probe --handshake-only

docker run --rm --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -v /private/path/camera.json:/run/secrets/camera.json:ro \
  smart-home-camera-lan-probe --duration 30s
```

The container uses UID 1000. Ensure it owns the configuration. Set the explicit camera protocol from verified metadata. Protocol 3.3 must be selected explicitly for a known camera address because it authenticates differently from 3.4 and 3.5.

### Native ONVIF / RTSP cameras

Use the camera's advertised ONVIF capabilities to find its media endpoint, then `GetProfiles` and `GetStreamUri` to obtain its native RTSP URI. Store that URI in a separate mode-0600 JSON file under the `uri` key. Never commit a stream URI, since it may contain credentials.

```sh
python3 rtsp_probe.py --config /private/path/stream.private.json
```

The native probe needs FFmpeg's `ffprobe`. If it is already installed in an existing Docker container with LAN access, add `--container CONTAINER_NAME` and run with the permissions needed for Docker. Only video packets are measured; media is discarded and stream URLs are omitted from output. This path does not use Tuya cloud signalling or the Go probe's P2P credentials.

## Offline verification sequence

1. Establish sustained local video with the camera online. Save the measurement and library version.
2. Schedule automatic removal of a temporary camera-specific gateway rule before applying it. Block the camera's WAN traffic in both directions, including established flows and IPv6, while retaining camera-to-Dell LAN access. Blocking internet only inside the probe container does not test the camera's independence.
3. Verify firewall counters and repeat the local video test with a fresh connection.
4. Keep the same WAN restriction while restarting the physical camera through a verified power source. Wait for its LAN address to return and repeat with the cached credentials.
5. Remove the temporary rule, verify ordinary connectivity, and restore any supporting services used by the experiment.

The upstream implementation reports that a tested camera needed cloud contact once after boot. Successful video before restart therefore does not establish full offline operation.

## Sleep Cam investigation, 12 November 2026

- The camera was online in Smart Life with privacy disabled.
- Its usual RTSP and HTTP ports were closed. Its Tuya TCP port was open.
- The database's saved local key differed from the current key in Tuya's device record. Only the isolated test configuration was updated.
- The pinned library timed out on LAN authentication using the fresh key with explicitly selected protocols 3.5, 3.4, and 3.3. The installed TinyTuya driver also failed to read local status.
- Smart Life's Sharing API rejected the tested RTC configuration endpoints. A separately approved camera web-login QR did retrieve the RTC configuration. It reports P2P type 4 and WebRTC credentials, without the P2P `password` field expected by this Go library. RTC `protocolVersion` is not the LAN protocol version.
- The existing Android session could not complete boot and was unavailable over ADB, so automatic camera web-login approval could not proceed.
- The associated CamSwitch socket was offline and had no usable local mapping, preventing a remote power cycle.

Sustained local video, camera-WAN-blocked streaming, and streaming after a blocked-internet restart remain unverified. A physical camera restart was requested; after the user requested another retry, protocol 3.5 still timed out. The retry alone does not confirm that the camera restarted. These results do not establish that this firmware supports or rejects the `IPC_LAN_302` streaming offer, because authentication has not completed.

## Second camera: TRACER FOCUS 3

Smart Life reports this camera online and provides a current local key. It has no saved LAN mapping. Ordinary Tuya discovery on the camera network did not return its device ID. An initial DHCP candidate named `IPCamera` did not authenticate with TRACER's key and was not identified as TRACER.

WS-Discovery located a different ONVIF camera. Both TinyTuya and the pinned Go probe authenticated it with TRACER's current key on LAN protocol **3.4**, confirming its identity. ONVIF reports model `IPC-G5A1D0F7-TY` and firmware `V3.2.16-Tuya_240109`. Its media endpoint is advertised through `GetCapabilities`; guessing a generic media-service path failed. ONVIF was already enabled.

The user did not find an ONVIF/NVR option in Smart Life. The native service was nevertheless already exposed and required no app setting changes for these tests.

- Native RTSP delivered H.265 video at **2304 × 1296**.
- With the camera's WAN access blocked, a fresh native RTSP connection delivered **248 video packets over 14.89 seconds**.
- A separate temporary nftables table ran before the normal established-flow accept rule. Camera MAC and destination-IP rules restricted WAN traffic while preserving LAN access. Its counters recorded 27 outbound and 9 inbound dropped packets before cleanup.
- Automatic rule removal was scheduled before applying the block; unconditional cleanup then removed the table and stopped the expiry timer.
- Standard ONVIF `SystemReboot` returned a success response, but the camera's HTTP port never went down during the two-minute observation. That command did not establish an actual restart.
- After removing the block, a fresh RTSP measurement again delivered 248 video packets over 14.89 seconds.
- FFmpeg decoded 165 video frames in a separate ten-second online test, with no decoder errors. Frames were discarded.

### Physical restart with WAN access continuously blocked

The user physically unplugged and reconnected TRACER while a fresh camera-specific WAN block was active. The monitor observed its HTTP port go down and return. The camera retained its LAN address. No cloud login, stream allocation, or URI refresh was performed for the following stream: the RTSP URI obtained before the restart was reused.

- A fresh native RTSP connection delivered **246 video packets over 14.77 seconds**, H.265 at **2304 × 1296**.
- FFmpeg then decoded **164 video frames over ten seconds with no decoder errors**. All frames were discarded.
- Firewall counters recorded **65 outbound and 108 inbound dropped packets** during this test. The rule remained active throughout power-off, startup, stream measurement, and decoding.
- Automatic expiry was scheduled for twelve minutes before applying the rule. After the checks, unconditional cleanup removed the table and stopped the timer.

An earlier physical attempt was inconclusive because its five-minute monitoring window ended before the camera returned; its cleanup removed the block. The successful repeat used a longer window and independently verified the continuously active restriction through the post-startup measurements.

**Result:** native TRACER streaming passed online, with internet blocked, and after a physical restart with internet still blocked. This verifies the tested firmware and observation periods; Sleep Cam remains unverified as described above.

TRACER's separately obtained RTC configuration also uses P2P type 4 and lacks the Go library's expected P2P password. Native RTSP avoids that limitation. No media has been recorded. Production camera mappings, application keys, and cloud-session files have not been changed.

Sources are the [upstream implementation](https://github.com/luukvisser/tuya-lan), [Tuya's RTC configuration documentation](https://developer.tuya.com/en/docs/cloud/c6370837a8?id=Kag2cwbctsmza), and [TRACER's official manual](https://www.tracer.pl/gfx-base/files/TRA/KAM/47377/inst_47377.pdf), which documents ONVIF on port 80.
