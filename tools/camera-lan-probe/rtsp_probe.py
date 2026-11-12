"""Measure native local RTSP video; discard all media and redact stream URLs."""

import argparse
import ipaddress
import json
import stat
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--duration", type=int, default=15)
    parser.add_argument("--container", help="Run ffprobe in an existing Docker container")
    args = parser.parse_args()
    if not 10 <= args.duration <= 300:
        parser.error("duration must be between 10 and 300 seconds")
    try:
        info = args.config.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError()
        config = json.loads(args.config.read_bytes())
        uri = config["uri"]
        address = urlsplit(uri)
        if address.scheme != "rtsp" or not ipaddress.ip_address(address.hostname).is_private:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        parser.error("config must be a private regular JSON file containing a local RTSP uri")

    prefix = ["docker", "exec", args.container] if args.container else []
    command = prefix + [
        "ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
        "-read_intervals", f"%+{args.duration}", "-show_packets", "-show_streams",
        "-show_entries", "packet=pts_time,size:stream=codec_name,width,height",
        "-of", "json", uri,
    ]
    try:
        process = subprocess.run(command, capture_output=True, text=True, timeout=args.duration + 25)
        data = json.loads(process.stdout or "{}")
        timestamps = [float(packet["pts_time"]) for packet in data.get("packets", [])
                      if packet.get("pts_time") not in (None, "N/A")]
        streams = [{key: stream.get(key) for key in ("codec_name", "width", "height")}
                   for stream in data.get("streams", [])
                   if stream.get("width", 0) > 0 and stream.get("height", 0) > 0]
        span = round(max(timestamps) - min(timestamps), 2) if timestamps else 0
        result = {
            "phase": "native_local_rtsp", "video_packets": len(timestamps),
            "video_span_seconds": span, "streams": streams,
            "passed": process.returncode == 0 and len(timestamps) >= 10
                      and len(set(timestamps)) >= 5 and span >= 5 and bool(streams),
        }
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        result = {"phase": "native_local_rtsp", "passed": False,
                  "error": "stream measurement failed or timed out"}
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
