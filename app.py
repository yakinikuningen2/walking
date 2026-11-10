"""Web server and Overpass relay for the walking map.

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
from math import isfinite
import os
import socket
import time

import requests
from walking_routes import RouteError, walking_suggestions


ROOT = Path(__file__).resolve().parent
OVERPASS_ENDPOINTS = (
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
)
PARK_SEARCH_ENDPOINT = "https://photon.komoot.io/api/"
USER_AGENT = "WalkingMap/1.0 (https://github.com/yakinikuningen2/walking)"
CACHE_TTL = 600
CACHE_LIMIT = 32
_CACHE = OrderedDict()
_CACHE_LOCK = Lock()
_PARK_CACHE = OrderedDict()
_SESSIONS = local()


def allowed_origin(value):
    """Keep local previews working; allow only the explicitly configured public HTTPS origin."""
    try:
        origin = urlsplit(value)
        if origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment:
            return False
        if origin.scheme in ("http", "https") and origin.hostname in ("localhost", "127.0.0.1", "::1"):
            return True
        public = urlsplit(os.environ.get("WALKING_PUBLIC_ORIGIN", "").strip()
                          or os.environ.get("RENDER_EXTERNAL_URL", "").strip())
        return bool(public.hostname and public.scheme == "https" and origin.scheme == "https"
                    and origin.hostname == public.hostname and (origin.port or 443) == (public.port or 443))
    except ValueError:
        return False


class WalkingServer(ThreadingHTTPServer):
    # Windows otherwise permits two reused listeners on the same local port.
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def park_data(payload):
    """Relay only the approved rounded park search, never arbitrary URLs or categories."""
    if not isinstance(payload, dict) or set(payload) != {"bbox", "lat", "lon"}:
        raise RouteError("ParkQuery", "公園の検索範囲が正しくありません。", 400)
    bounds, lat, lon = payload["bbox"], payload["lat"], payload["lon"]
    def valid(value):
        return type(value) in (int, float) and isfinite(value)

    if not isinstance(bounds, list) or len(bounds) != 4 or not all(valid(v) for v in bounds) or not valid(lat) or not valid(lon):
        raise RouteError("ParkQuery", "公園の検索範囲が正しくありません。", 400)
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90
            and north - south <= 2 and east - west <= 8 and south <= lat <= north and west <= lon <= east):
        raise RouteError("ParkQuery", "公園の検索範囲が正しくありません。", 400)
    lat, lon = round(lat * 500) / 500, round(lon * 500) / 500
    key = (tuple(bounds), lat, lon)
    with _CACHE_LOCK:
        cached = _PARK_CACHE.get(key)
        if cached and time.monotonic() - cached[0] < CACHE_TTL:
            _PARK_CACHE.move_to_end(key)
            return cached[1]
    if not hasattr(_SESSIONS, "session"):
        _SESSIONS.session = requests.Session()
        _SESSIONS.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    params = {"include": "osm.leisure.park,osm.leisure.garden,osm.leisure.nature_reserve",
              "bbox": ",".join(f"{value:.6f}" for value in bounds),
              "lat": f"{lat:.3f}", "lon": f"{lon:.3f}", "limit": "50",
              "lang": "default", "location_bias_scale": "0"}
    try:
        with _SESSIONS.session.get(PARK_SEARCH_ENDPOINT, params=params, timeout=(3, 5), allow_redirects=False) as response:
            if response.status_code == 429:
                raise RouteError("ParkBusy", "公園の検索先が混み合っています。", 503)
            if response.status_code != 200:
                raise RouteError("ParkUnavailable", "公園の検索先に接続できませんでした。", 502)
            data = response.json()
        if not isinstance(data, dict) or not isinstance(data.get("features"), list) or len(data["features"]) > 100:
            raise ValueError("Invalid park data")
    except requests.Timeout:
        raise RouteError("ParkTimeout", "公園の検索先の応答に時間がかかっています。", 504) from None
    except (requests.RequestException, ValueError):
        raise RouteError("ParkUnavailable", "公園の情報を取得できませんでした。", 502) from None
    with _CACHE_LOCK:
        _PARK_CACHE[key] = (time.monotonic(), data)
        _PARK_CACHE.move_to_end(key)
        while len(_PARK_CACHE) > CACHE_LIMIT:
            _PARK_CACHE.popitem(last=False)
    return data


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
        if origin and allowed_origin(origin):
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
        if urlsplit(self.path).path not in ("/api/overpass", "/api/walking-routes", "/api/parks"):
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
        path = urlsplit(self.path).path
        if path not in ("/api/overpass", "/api/walking-routes", "/api/parks"):
            self.send_json({"error": "Not found"}, 404)
            return
        origin = self.headers.get("Origin", "")
        if origin and not allowed_origin(origin):
            self.send_json({"error": "Browser origin is not allowed"}, 403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > (8192 if path in ("/api/walking-routes", "/api/parks") else 262144):
                raise ValueError("Invalid body size")
            payload = json.loads(self.rfile.read(length))
            if path == "/api/parks":
                try:
                    self.send_json(park_data(payload))
                except RouteError as error:
                    self.send_json({"error": error.message, "code": error.code}, error.status)
                except Exception:
                    self.send_json({"error": "公園の情報を取得できませんでした。", "code": "ParkUnavailable"}, 502)
                return
            if path == "/api/walking-routes":
                try:
                    self.send_json(walking_suggestions(payload, map_data))
                except RouteError as error:
                    self.send_json({"error": error.message, "code": error.code}, error.status)
                except Exception:
                    # Neither exception details nor upstream responses may expose credentials.
                    self.send_json({"error": "ルートの情報を取得できませんでした。", "code": "ROUTE_INTERNAL_ERROR"}, 502)
                return
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


def is_render_environment():
    flag = os.environ.get("RENDER", "").strip().lower()
    return flag in ("true", "1", "yes", "on") or any(
        os.environ.get(name, "").strip()
        for name in ("RENDER_SERVICE_ID", "RENDER_EXTERNAL_URL", "RENDER_EXTERNAL_HOSTNAME")
    )


def server_options(argv=None):
    on_render = is_render_environment()
    environment_port = os.environ.get("PORT", "10000" if on_render else "8000")
    parser = argparse.ArgumentParser(description="Run the walking map locally or on Render.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=environment_port)
    args = parser.parse_args(argv)
    if on_render:
        # Render's public listener must not be changed back to localhost by CLI flags.
        args.host = "0.0.0.0"
        try:
            args.port = int(environment_port)
        except ValueError:
            parser.error("PORT must be an integer")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    if not args.host.strip():
        parser.error("--host must not be empty")
    return args


def main():
    args = server_options()
    try:
        server = WalkingServer((args.host, args.port), WalkingHandler)
    except OSError as error:
        raise SystemExit(f"Could not start server: {error}") from None
    print(f"Walking map: http://{args.host}:{server.server_port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
