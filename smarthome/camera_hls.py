"""Resolve and relay HTTPS HLS resources issued by the camera provider."""

import http.client
import re
import socket
import ssl
from dataclasses import dataclass, field
from ipaddress import ip_address, ip_network
from time import monotonic
from urllib.parse import urljoin, urlsplit

MANIFEST_TYPE = "application/vnd.apple.mpegurl"
MANIFEST_TYPES = {MANIFEST_TYPE, "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"}
MEDIA_EXTENSIONS = {
    ".ts": "video/mp2t", ".mp4": "video/mp4", ".m4s": "video/iso.segment",
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".mp3": "audio/mpeg",
    ".ac3": "audio/ac3", ".ec3": "audio/eac3", ".vtt": "text/vtt",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
}
MEDIA_TYPES = set(MEDIA_EXTENSIONS.values())
MANIFEST_LIMIT = 1024 * 1024
MEDIA_LIMIT = 64 * 1024 * 1024
TIMEOUT = 12
TRANSFER_DEADLINE = 36
TLS_CONTEXT = ssl.create_default_context()
PUBLIC_V6 = ip_network("2000::/3")
# Tuya's documented HTTPS HLS allocator also uses port 554.
HTTPS_PORTS = {443, 554}
REDIRECTS = {301, 302, 303, 307, 308}
URI_TAGS = {
    "#EXT-X-MEDIA": "playlist",
    "#EXT-X-I-FRAME-STREAM-INF": "playlist",
    "#EXT-X-IMAGE-STREAM-INF": "playlist",
    "#EXT-X-RENDITION-REPORT": "playlist",
    "#EXT-X-KEY": "media",
    "#EXT-X-SESSION-KEY": "media",
    "#EXT-X-MAP": "media",
    "#EXT-X-PART": "media",
    "#EXT-X-PRELOAD-HINT": "media",
}
ATTR = re.compile(r'(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,"]+)')
URI_ATTRIBUTE = re.compile(r'\b(?:(?:[A-Z0-9]+-)*URI|X-ASSET-LIST)\s*=', re.IGNORECASE)


class RelayError(Exception):
    """A provider response that cannot be safely relayed."""


def public_address(value):
    address = ip_address(value)
    return (
        address.is_global and not address.is_multicast and not address.is_reserved
        and (
            address.version == 4
            or (address in PUBLIC_V6 and address.sixtofour is None and address.teredo is None)
        )
    )


def stream_url(value):
    if (
        not isinstance(value, str) or not value.isascii() or len(value) > 8192
        or any(c.isspace() or not c.isprintable() or c == "\\" for c in value)
    ):
        raise RelayError()
    try:
        url = urlsplit(value)
        if (
            url.scheme != "https" or not url.hostname or url.username is not None
            or url.password is not None or "#" in value or "%" in url.netloc
            or (url.port is not None and url.port not in HTTPS_PORTS)
        ):
            raise RelayError()
        try:
            ip_address(url.hostname)
        except ValueError:
            if not re.fullmatch(r"[a-z0-9.-]{1,253}", url.hostname):
                raise RelayError() from None
        else:
            if not public_address(url.hostname):
                raise RelayError()
        return url
    except ValueError:
        raise RelayError() from None


def join_stream_url(base, reference):
    # urljoin normalizes certain unsafe characters, so check the reference first.
    if not reference or any(c.isspace() or not c.isprintable() or c == "\\" for c in reference):
        raise RelayError()
    try:
        url = urljoin(base, reference)
    except ValueError:
        raise RelayError() from None
    stream_url(url)
    return url


class PublicHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        records = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        if not records or any(not public_address(record[4][0]) for record in records):
            raise RelayError()
        deadline = monotonic() + self.timeout
        for family, kind, protocol, _, sockaddr in records:
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            raw = socket.socket(family, kind, protocol)
            try:
                # Connect to the checked address without a second DNS lookup.
                raw.settimeout(remaining)
                raw.connect(sockaddr)
                raw.settimeout(max(0.001, deadline - monotonic()))
                self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            except OSError:
                raw.close()
                continue
            self.sock.settimeout(self.timeout)
            return
        raise RelayError()


@dataclass
class Upstream:
    url: str = field(repr=False)
    connection: http.client.HTTPSConnection
    response: http.client.HTTPResponse
    deadline: float

    def close(self):
        try:
            self.response.close()
        finally:
            self.connection.close()

    def chunks(self, limit):
        total = 0
        while True:
            if monotonic() > self.deadline:
                raise RelayError()
            chunk = self.response.read1(min(64 * 1024, limit - total + 1))
            if not chunk:
                return
            total += len(chunk)
            if total > limit:
                raise RelayError()
            yield chunk


def open_upstream(url, method, byte_range=None):
    headers = {"Accept-Encoding": "identity"}
    if byte_range:
        headers["Range"] = byte_range
    deadline = monotonic() + TRANSFER_DEADLINE
    for _ in range(4):
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        target = stream_url(url)
        connection = PublicHTTPSConnection(
            target.hostname, target.port, timeout=min(TIMEOUT, remaining), context=TLS_CONTEXT,
        )
        path = target.path or "/"
        if target.query:
            path += "?" + target.query
        try:
            connection.request(method, path, headers=headers)
            response = connection.getresponse()
        except BaseException:
            connection.close()
            raise
        upstream = Upstream(url, connection, response, deadline)
        if response.status not in REDIRECTS:
            return upstream
        try:
            url = join_stream_url(url, response.getheader("Location"))
        finally:
            upstream.close()
    raise RelayError()


def rewrite_playlist(body, resource_url):
    """Replace every supported HLS reference with a relay resource URL."""
    try:
        lines = body.decode("utf-8").replace("\r\n", "\n").split("\n")
    except UnicodeDecodeError:
        raise RelayError() from None
    if not lines or lines[0] != "#EXTM3U":
        raise RelayError()
    output = [lines[0]]
    variant_next = False
    references = 0

    def rewrite(uri, kind):
        nonlocal references
        references += 1
        if references > 256 or "{\x24" in uri:
            raise RelayError()
        return resource_url(uri, kind)

    for line in lines[1:]:
        if re.search(r"[\x00-\x1f\x7f-\x9f]", line):
            raise RelayError()
        if not line or (line.startswith("#") and not line.startswith("#EXT")):
            continue
        if not line.startswith("#"):
            output.append(rewrite(line, "playlist" if variant_next else "media"))
            variant_next = False
            continue
        tag, _, attributes = line.partition(":")
        if tag in {"#EXT-X-CONTENT-STEERING", "#EXT-X-SESSION-DATA"}:
            # These optional tags may link to secondary metadata outside HLS.
            continue
        if tag == "#EXT-X-DEFINE":
            raise RelayError()
        if tag == "#EXT-X-STREAM-INF":
            variant_next = True
        if tag == "#EXTINF":
            # Segment titles are optional and need not carry provider metadata.
            output.append(tag + ":" + attributes.partition(",")[0] + ",")
        elif tag in URI_TAGS:
            parts = []
            end = 0
            for attr in ATTR.finditer(attributes):
                name, value = attr.groups()
                if attr.start() != end:
                    raise RelayError()
                end = attr.end()
                if name == "URI":
                    if not value.startswith('"'):
                        raise RelayError()
                    value = '"' + rewrite(value[1:-1], URI_TAGS[tag]) + '"'
                elif name.endswith("-URI"):
                    raise RelayError()
                parts.append(name + "=" + value)
            if end != len(attributes):
                raise RelayError()
            output.append(tag + ":" + ",".join(parts))
        elif not URI_ATTRIBUTE.search(attributes):
            # Drop extensions that could introduce additional fetches, such as
            # interstitial asset lists, rather than exposing their URLs.
            output.append(line)
    if variant_next:
        raise RelayError()
    return ("\n".join(output) + "\n").encode("utf-8")
