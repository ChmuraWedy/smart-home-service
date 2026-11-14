"""Enable persistent dnsmasq query logs without changing DNS/DHCP/firewall policy.

Run on the managed Dell host as root. Patches the configuration compiler AND its
container image, since future `netctl` commands execute inside that image.
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--container", default="network-management-dns-1")
    parser.add_argument("--image", default="local/netmgr:1")
    parser.add_argument("--collector-config", type=Path, default=Path("/etc/smart-home-logs/collector.json"))
    args = parser.parse_args()
    root = args.source.resolve()
    source, config = root / "netctl.py", root / "data/generated/dnsmasq.conf"
    original, original_config = source.read_bytes(), config.read_bytes()
    if b'"log-queries=extra"' in original and b"log-queries=extra\n" in original_config:
        print("DNS query logging is already enabled")
        return
    needle = b'"log-dhcp", "log-facility=-"'
    assert original.count(needle) == 1, "Unrecognized compiler; refusing an ambiguous edit"
    updated = original.replace(needle, b'"log-dhcp", "log-queries=extra", "log-async=100", "log-facility=-"')
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = root / ("before-central-logs-" + stamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(source, backup / "netctl.py")
    shutil.copy2(config, backup / "dnsmasq.conf")
    previous_image = run("docker", "image", "inspect", args.image, "--format", "{{.Id}}").strip()
    base_tag = "local/netmgr:before-central-logs-" + stamp
    run("docker", "tag", previous_image, base_tag)
    restarted = False
    try:
        with tempfile.TemporaryDirectory() as context:
            Path(context, "netctl.py").write_bytes(updated)
            Path(context, "Dockerfile").write_text(f"FROM {base_tag}\nCOPY --chmod=755 netctl.py /usr/local/bin/netctl\n")
            run("docker", "build", "--network=none", "-t", args.image, context, timeout=90)
        source.write_bytes(updated)
        os.environ["NETMGR_DATA"] = str(root / "data")
        spec = importlib.util.spec_from_file_location("dns_logging_compiler", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        rendered = module.render(module.read_state(), "production")
        # Logging must be the entire diff. Never silently recompile a different live policy.
        assert rendered.replace("log-queries=extra\n", "").replace("log-async=100\n", "").encode() == original_config
        module.atomic(config, rendered)
        run("docker", "exec", args.container, "dnsmasq", "--test", "--conf-file=/data/generated/dnsmasq.conf")
        restarted = True
        query_logging_started = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000000Z")
        run("docker", "restart", args.container, timeout=30)
        for address in ("192.168.40.1", "192.168.70.1", "192.168.90.2"):
            answer = run("dig", "@" + address, "homeassistant.dom", "+short", "+time=2", "+tries=3")
            assert "192.168.70.10" in answer, "DNS alias verification failed"
        if args.collector_config.is_file():
            collector = json.loads(args.collector_config.read_text())
            for item in collector["containers"]:
                if item["name"] == args.container:
                    item.setdefault("not_before", query_logging_started)
            # Avoid draining obsolete DHCP packet logs before the first DNS queries.
            with tempfile.NamedTemporaryFile(mode="w", dir=args.collector_config.parent, delete=False) as file:
                json.dump(collector, file, indent=2)
                temporary = file.name
            os.replace(temporary, args.collector_config)
            run("systemctl", "try-restart", "smart-home-log-collector", timeout=40)
        print("DNS query logging enabled; aliases verified on all three Dell DNS listeners")
        print("DNS, DHCP and internet policy unchanged; compiler/image backups:", backup)
    except BaseException:
        source.write_bytes(original)
        config.write_bytes(original_config)
        run("docker", "tag", previous_image, args.image)
        if restarted:
            run("docker", "restart", args.container, timeout=30)
        raise


if __name__ == "__main__":
    main()
