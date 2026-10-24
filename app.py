"""Local web server and Overpass relay for the walking map.

Run with the project's Python environment: .venv/Scripts/python.exe app.py
"""

from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, local
from urllib.parse import urlsplit
import argparse
import json
import mimetypes
import socket
import time

import requests


ROOT = Path(__file__).resolve().parent
OVERPASS_ENDPOINTS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
USER_AGENT = "WalkingMap/1.0 (https://github.com/yakinikuningen2/walking)"
CACHE_TTL = 600
CACHE_LIMIT = 32
_CACHE = OrderedDict()
_CACHE_LOCK = Lock()
_SESSIONS = local()


class WalkingServer(ThreadingHTTPServer):
    # Windows otherwise permits two reused listeners on the same local port.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def map_data(query, provider=0, timeout_ms=60000):
    """Send the query as a POST so long geometry queries stay out of URLs."""
    key = (provider, query)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and time.monotonic() - cached[0] < CACHE_TTL:
            _CACHE.move_to_end(key)
            return cached[1]
        _CACHE.pop(key, None)

    if not hasattr(_SESSIONS, "session"):
        _SESSIONS.session = requests.Session()
        _SESSIONS.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    budget = timeout_ms / 1000
    connect_timeout = min(5, budget / 4)
    read_timeout = max(0.1, budget - connect_timeout - 1)
    with _SESSIONS.session.post(
        OVERPASS_ENDPOINTS[provider],
        data={"data": query},
        timeout=(connect_timeout, read_timeout),
        allow_redirects=False,
    ) as response:
        response.raise_for_status()
        data = response.json()
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list) or data.get("remark") or data.get("error"):
        raise ValueError("Overpass returned incomplete or invalid map data")

    with _CACHE_LOCK:
        _CACHE[key] = (time.monotonic(), data)
        _CACHE.move_to_end(key)
        while len(_CACHE) > CACHE_LIMIT:
            _CACHE.popitem(last=False)
    return data


class WalkingHandler(BaseHTTPRequestHandler):
    server_version = "WalkingMap/1.0"

    def end_headers(self):
        self.send_header("X-Walking-Map", "1")
        origin = self.headers.get("Origin", "")
        parsed = urlsplit(origin)
        if parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Expose-Headers", "X-Walking-Map")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.write_body(body)

    def write_body(self, body):
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # The browser may have cancelled this search.

    def do_OPTIONS(self):
        if urlsplit(self.path).path != "/api/overpass":
            self.send_json({"error": "Not found"}, 404)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/health":
            self.send_json({"service": "walking-map"})
            return
        if path in ("/", "/index.html", "/templates/index.html"):
            file = ROOT / ("templates/index.html" if path.startswith("/templates/") else "index.html")
        elif path.startswith("/static/"):
            from urllib.parse import unquote
            file = (ROOT / unquote(path.lstrip("/"))).resolve()
            if not file.is_relative_to(ROOT / "static"):
                self.send_json({"error": "Not found"}, 404)
                return
        else:
            self.send_json({"error": "Not found"}, 404)
            return
        if not file.is_file():
            self.send_json({"error": "Not found"}, 404)
            return
        body = file.read_bytes()
        content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if file.suffix == ".html":
            # Pages served here use this server even with a custom --port.
            body = body.replace(b"</head>", b'<meta name="walking-map-api" content="/api/overpass"></head>', 1)
        if content_type.startswith("text/") or file.suffix == ".js":
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.write_body(body)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/overpass":
            self.send_json({"error": "Not found"}, 404)
            return
        origin = urlsplit(self.headers.get("Origin", ""))
        if origin.scheme and (origin.scheme != "http" or origin.hostname not in ("localhost", "127.0.0.1", "::1")):
            self.send_json({"error": "Local browser origins only"}, 403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 262144:
                raise ValueError("Invalid body size")
            payload = json.loads(self.rfile.read(length))
            query = payload["query"]
            provider = payload.get("provider", 0)
            timeout_ms = payload.get("timeout_ms", 60000)
            if not isinstance(query, str) or not query.strip() or len(query) > 200000:
                raise ValueError("Invalid query")
            if type(provider) is not int or provider not in range(len(OVERPASS_ENDPOINTS)):
                raise ValueError("Invalid provider")
            if type(timeout_ms) is not int or not 500 <= timeout_ms <= 120000:
                raise ValueError("Invalid timeout")
        except (ValueError, TypeError, KeyError, UnicodeError):
            self.send_json({"error": "Invalid map request"}, 400)
            return
        try:
            self.send_json(map_data(query, provider, timeout_ms))
        except requests.Timeout:
            self.send_json({"error": "Map service timed out", "code": "MapTimeout"}, 504)
        except requests.HTTPError as error:
            response = error.response
            if response is not None and response.status_code in (400, 422):
                self.send_json({"error": "Invalid map query", "code": "MapQuery"}, 400)
                return
            busy = response is not None and (response.status_code in (429, 503)
                or (response.status_code == 502 and "capacity" in response.text[:1000].lower()))
            self.send_json({"error": "Map service is unavailable", "code": "MapBusy" if busy else "MapUnavailable"}, 503 if busy else 502)
        except (requests.RequestException, ValueError):
            self.send_json({"error": "Map service is unavailable", "code": "MapUnavailable"}, 502)

    def log_message(self, format, *args):
        # API queries can contain coordinates; log paths without their contents.
        if urlsplit(self.path).path.startswith("/api/"):
            return
        super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description="Run the walking map locally.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    try:
        server = WalkingServer(("127.0.0.1", args.port), WalkingHandler)
    except OSError as error:
        parser.exit(1, f"Could not start local server: {error}\n")
    print(f"Walking map: http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
