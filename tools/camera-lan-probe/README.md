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
- Smart Life's Sharing API rejected the tested RTC configuration endpoints. The camera P2P password is not yet available to the probe.
- The existing Android session could not complete boot and was unavailable over ADB, so automatic camera web-login approval could not proceed.
- The associated CamSwitch socket was offline and had no usable local mapping, preventing a remote power cycle.

Sustained local video, camera-WAN-blocked streaming, and streaming after a blocked-internet restart remain unverified. A physical camera restart was requested; after the user requested another retry, protocol 3.5 still timed out. The retry alone does not confirm that the camera restarted. These results do not establish that this firmware supports or rejects the `IPC_LAN_302` streaming offer, because authentication has not completed.

## Second camera: TRACER FOCUS 3

Smart Life reports this camera online and provides a current local key. It has no saved LAN mapping. Ordinary Tuya discovery on the camera network did not return its device ID. A DHCP entry named `IPCamera` has TCP 6668 open and the usual RTSP and HTTP ports closed, but its identity is **not confirmed**. The probe failed to authenticate that candidate with TRACER's key on protocols 3.5, 3.4, and 3.3; TinyTuya also failed on 3.4 and 3.3, including its device22 query variant.

TRACER declares a restart capability. No restart or internet restriction has been issued to either camera. Camera web-login QR approval is pending to obtain RTC credentials and continue investigating both cameras. No media has been recorded.

Sources are the [upstream implementation](https://github.com/luukvisser/tuya-lan) and [Tuya's RTC configuration documentation](https://developer.tuya.com/en/docs/cloud/c6370837a8?id=Kag2cwbctsmza).
