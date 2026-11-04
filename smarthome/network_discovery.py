"""Allowlisted LAN announcements and neighbor cache; never retain raw payloads."""

import json
import platform
import re
import shutil
import socket
import struct
import subprocess
from ipaddress import ip_address, ip_interface, ip_network
from pathlib import Path

PRIVATE_NETWORKS = tuple(
    ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
MULTICAST = {5353: "224.0.0.251", 1900: "239.255.255.250"}
MAX_DEVICES = 256
MAX_EVENTS = 200


def private_ip(value):
    try:
        address = ip_address(value)
        return address.version == 4 and any(address in network for network in PRIVATE_NETWORKS)
    except ValueError:
        return False


def interface_row(name, address, mask):
    try:
        value = ip_interface(f"{address}/{mask}")
        if not private_ip(address) or not isinstance(name, str) or not name:
            return None
        return {
            "name": name[:100],
            "address": str(value.ip),
            "network": str(value.network),
            "broadcast": str(value.network.broadcast_address),
        }
    except (ValueError, TypeError):
        return None


def parse_interfaces(text, system):
    rows = []
    try:
        if system == "Linux":
            for item in json.loads(text[:131072]):
                for address in item.get("addr_info", []):
                    if address.get("family") == "inet":
                        row = interface_row(
                            item.get("ifname"), address.get("local"), address.get("prefixlen")
                        )
                        if row:
                            rows.append(row)
        elif system == "Windows":
            items = json.loads(text[:131072])
            for item in items if isinstance(items, list) else [items]:
                row = interface_row(
                    item.get("InterfaceAlias"), item.get("IPAddress"), item.get("PrefixLength")
                )
                if row:
                    rows.append(row)
        else:
            name = None
            for line in text[:131072].splitlines():
                if line and not line[0].isspace():
                    name = line.split(":", 1)[0]
                match = re.match(r"\s+inet (\S+) netmask (\S+)", line)
                if match:
                    mask = match[2]
                    if mask.startswith("0x"):
                        mask = str(ip_address(int(mask, 16)))
                    row = interface_row(name, match[1], mask)
                    if row:
                        rows.append(row)
    except (ValueError, TypeError, KeyError, AttributeError):
        return []
    return list({row["address"]: row for row in rows}.values())[:32]


def network_interfaces():
    """Read actual interface addresses and prefixes, never infer a /24 or cloud subnet."""
    system = platform.system()
    command = (
        ["ip", "-j", "-4", "addr", "show"]
        if system == "Linux"
        else [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress,PrefixLength | ConvertTo-Json -Compress",
        ]
        if system == "Windows"
        else ["ifconfig", "-a"]
    )
    executable = shutil.which(command[0])
    if not executable and system == "Darwin" and Path("/sbin/ifconfig").exists():
        executable = "/sbin/ifconfig"
    if not executable:
        return []
    try:
        result = subprocess.run(
            [executable, *command[1:]], capture_output=True, text=True, timeout=3, check=False
        )
        return parse_interfaces(result.stdout, system) if result.returncode == 0 else []
    except (OSError, subprocess.SubprocessError):
        return []


def dns_name(packet, offset):
    labels, seen, end = [], set(), None
    for _ in range(64):
        if offset in seen or offset >= len(packet):
            raise ValueError("Invalid DNS name")
        seen.add(offset)
        size = packet[offset]
        if size & 0xC0 == 0xC0:
            if offset + 1 >= len(packet):
                raise ValueError("Short DNS pointer")
            end = end if end is not None else offset + 2
            offset = ((size & 63) << 8) | packet[offset + 1]
            continue
        offset += 1
        if size == 0:
            return ".".join(labels).lower(), end if end is not None else offset
        if size > 63 or offset + size > len(packet):
            raise ValueError("Invalid DNS label")
        label = packet[offset : offset + size].decode("utf-8", errors="replace")
        if not label.isprintable():
            raise ValueError("Non-host DNS label")
        labels.append(label)
        if sum(len(item) + 1 for item in labels) > 254:
            raise ValueError("Long DNS name")
        offset += size
    raise ValueError("DNS name limit")


def mdns(packet, source):
    """Ignore TXT and service instance names; expose service types and own A name."""
    try:
        if len(packet) < 12 or len(packet) > 16384:
            return None
        _, flags, questions, answers, authority, additional = struct.unpack_from("!6H", packet)
        if not flags & 0x8000 or questions > 32 or answers + authority + additional > 128:
            return None
        offset, services, hostname = 12, set(), None
        for _ in range(questions):
            _, offset = dns_name(packet, offset)
            offset += 4
        for _ in range(answers + authority + additional):
            name, offset = dns_name(packet, offset)
            kind, _, _, length = struct.unpack_from("!HHIH", packet, offset)
            offset += 10
            if offset + length > len(packet):
                return None
            # The owner name gives the service type without decoding instance or TXT data.
            if kind == 12 and re.fullmatch(r"_[a-z0-9-]{1,63}\._(?:tcp|udp)\.local", name):
                services.add(name)
            if (
                kind == 1
                and length == 4
                and socket.inet_ntoa(packet[offset : offset + 4]) == source
            ):
                if re.fullmatch(r"[a-z0-9-]{1,63}\.local", name):
                    hostname = name
            offset += length
        return (
            {"services": sorted(services)[:16], "hostname": hostname}
            if services or hostname
            else None
        )
    except (ValueError, UnicodeError, struct.error, OSError):
        return None


def ssdp(packet):
    try:
        if len(packet) > 8192:
            return None
        lines = packet.decode("ascii").split("\r\n")
        if not lines or lines[0] not in ("NOTIFY * HTTP/1.1", "HTTP/1.1 200 OK"):
            return None
        services = set()
        for line in lines[1:]:
            key, _, value = line.partition(":")
            if key.lower() in ("nt", "st"):
                value = value.strip().lower()
                if re.fullmatch(
                    r"urn:[a-z0-9.-]{1,80}:(?:device|service):[a-z0-9_-]{1,64}:[0-9]{1,3}", value
                ):
                    services.add(value)
        return {"services": sorted(services)[:16], "hostname": None} if services else None
    except UnicodeError:
        return None


def parse_neighbors(text, linux=False):
    rows = {}
    for line in text[:131072].splitlines():
        if linux:
            parts = line.split()
            if len(parts) < 6:
                continue
            try:
                if not int(parts[2], 16) & 2:
                    continue
            except ValueError:
                continue
            address, mac = parts[0], parts[3]
        else:
            address_match = re.search(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b", line)
            mac_match = re.search(r"\b(?:[a-fA-F0-9]{1,2}[:-]){5}[a-fA-F0-9]{1,2}\b", line)
            if not address_match or not mac_match:
                continue
            address, mac = address_match[0], mac_match[0]
        if not private_ip(address) or not re.fullmatch(
            r"(?:[a-fA-F0-9]{1,2}[:-]){5}[a-fA-F0-9]{1,2}", mac
        ):
            continue
        octets = [int(part, 16) for part in re.split("[:-]", mac)]
        if octets[0] & 1 or not any(octets):
            continue
        rows[address] = {"ip": address, "mac": ":".join(f"{part:02x}" for part in octets)}
        if len(rows) >= MAX_DEVICES:
            break
    return list(rows.values())


def neighbors():
    try:
        if platform.system() == "Linux":
            return parse_neighbors(Path("/proc/net/arp").read_text(), linux=True), True
        executable = shutil.which("arp")
        if executable:
            result = subprocess.run(
                [executable, "-an" if platform.system() == "Darwin" else "-a"],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            if result.returncode == 0:
                return parse_neighbors(result.stdout), True
    except (OSError, subprocess.SubprocessError):
        pass
    return [], False


def request_tuya_announcements(interface=None):
    """Send TinyTuya's standard REQ_DEVINFO UDP frame, never TCP or DP commands."""
    import tinytuya
    from tinytuya import scanner

    sent = False
    try:
        if not tinytuya.AESCipher.CRYPTOLIB_HAS_GCM:
            return False
        targets = (
            {interface["broadcast"]: interface["address"]}
            if interface
            else scanner.get_ip_to_broadcast()
        )
        for broadcast, address in list(targets.items())[:8]:
            if not private_ip(address):
                continue
            destination = ip_address(broadcast)
            if destination.version != 4 or not (
                private_ip(broadcast) or broadcast == "255.255.255.255"
            ):
                continue
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as channel:
                    channel.settimeout(2)
                    channel.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                    channel.bind((address, 0))
                    message = tinytuya.TuyaMessage(
                        0,
                        tinytuya.REQ_DEVINFO,
                        None,
                        json.dumps({"from": "app", "ip": address}).encode(),
                        0,
                        True,
                        tinytuya.PREFIX_6699_VALUE,
                        True,
                    )
                    payload = tinytuya.pack_message(message, hmac_key=tinytuya.udpkey)
                    channel.sendto(payload, (broadcast, 7000))
                    sent = True
            except OSError:
                continue
        return sent
    except Exception:
        return False
