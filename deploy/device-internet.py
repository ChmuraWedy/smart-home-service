#!/usr/bin/env python3
"""Manage one registered device's WAN access by IP or MAC; run on the LAN gateway."""
import argparse
import http.client
import ipaddress
import json
import socket
from pathlib import Path


class Connection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect('/run/device-network/policy.sock')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'block', 'unblock'])
    parser.add_argument('device', help='Registered device IPv4 address or MAC address')
    args = parser.parse_args()
    config = json.loads(Path('/etc/device-network/devices.json').read_text())
    identifier = next((ip for ip, row in config.items() if row['mac'] == args.device.lower()), args.device)
    try:
        identifier = str(ipaddress.IPv4Address(identifier))
    except ValueError:
        parser.error('MAC is not registered on this gateway')
    if identifier not in config:
        parser.error('Device is not registered on this gateway')
    client = Connection('device-network')
    try:
        body = None if args.action == 'status' else json.dumps({'blocked': args.action == 'block'})
        client.request('GET' if body is None else 'PUT', '/devices/' + identifier, body, {'Content-Type': 'application/json'})
        response = client.getresponse()
        if response.status != 200:
            raise SystemExit('Could not verify device internet policy')
        value = json.loads(response.read(4096))
        print(json.dumps({'host': identifier, 'mac': config[identifier]['mac'], **value}))
    except (OSError, ValueError, http.client.HTTPException):
        raise SystemExit('Device policy service is unavailable; check device-network.service') from None
    finally:
        client.close()


if __name__ == '__main__':
    main()
