"""Fixed-endpoint pedestrian relay. Coordinate-bearing results stay in RAM."""
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError as FutureTimeout
from hashlib import sha256
from math import isfinite
from threading import Lock, local
import json
import time

import requests
from api_limits import VALHALLA_GATE
from walking_routes import RouteError

VALHALLA_ORIGIN = "https://valhalla1.openstreetmap.de"
CLIENT_ID = "walking-ctsh.onrender.com"
USER_AGENT = "WalkingMap/1.0 (+https://walking-ctsh.onrender.com/; https://github.com/yakinikuningen2/walking)"
TTL, CACHE_BYTES, RESPONSE_BYTES = 300, 16 * 1024 * 1024, 12 * 1024 * 1024
_cache, _jobs, _lock, _local = OrderedDict(), {}, Lock(), local()
_cache_bytes = 0


def invalid():
    raise RouteError("ROUTING_INPUT", "徒歩検索の条件を確認してください。", 400)


def numeric(v, low, high):
    if type(v) not in (int, float) or not isfinite(v) or not low <= v <= high:
        invalid()
    return v


def coordinate(p, location=False):
    if not isinstance(p, dict) or set(p) - ({"lat", "lon", "type", "search_cutoff"} if location else {"lat", "lon"}):
        invalid()
    out = {"lat": round(numeric(p.get("lat"), -90, 90), 6), "lon": round(numeric(p.get("lon"), -180, 180), 6)}
    if "type" in p:
        if p["type"] not in ("break", "via"):
            invalid()
        out["type"] = p["type"]
    if "search_cutoff" in p:
        out["search_cutoff"] = numeric(p["search_cutoff"], 0, 1200)
    return out


def validated(payload):
    if not isinstance(payload, dict) or not {"action", "params"} <= set(payload) or set(payload) - {"action", "params", "timeout_ms"}:
        invalid()
    numeric(payload.get("timeout_ms", 18000), 500, 60000)
    action, p = payload["action"], payload["params"]
    if action not in ("route", "locate", "height") or not isinstance(p, dict):
        invalid()
    if action == "height":
        if set(p) - {"shape", "range", "height_precision"} or p.get("range", False) is not False:
            invalid()
        shape = p.get("shape")
        if not isinstance(shape, list) or not 1 <= len(shape) <= 24:
            invalid()
        return action, {"shape": [coordinate(v) for v in shape], "range": False, "height_precision": 0}
    allowed = {"locations", "costing", "costing_options", "verbose"} if action == "locate" else {
        "locations", "costing", "costing_options", "format", "shape_format", "directions_options", "exclude_polygons", "alternates"}
    if set(p) - allowed or p.get("costing") != "pedestrian":
        invalid()
    locations = p.get("locations")
    if not isinstance(locations, list) or not (1 if action == "locate" else 2) <= len(locations) <= (16 if action == "locate" else 50):
        invalid()
    out = {"locations": [coordinate(v, True) for v in locations], "costing": "pedestrian"}
    costing = p.get("costing_options", {})
    if not isinstance(costing, dict) or set(costing) - {"pedestrian"}:
        invalid()
    options = costing.get("pedestrian", {})
    rules = {"walking_speed": (2.5, 6.5), "use_hills": (0, 1), "step_penalty": (0, 600),
             "max_hiking_difficulty": (0, 0), "use_ferry": (0, 0), "private_access_penalty": (43200, 43200)}
    if not isinstance(options, dict) or set(options) - set(rules):
        invalid()
    out["costing_options"] = {"pedestrian": {k: numeric(v, *rules[k]) for k, v in options.items()}}
    out["costing_options"]["pedestrian"].update(max_hiking_difficulty=0, use_ferry=0, private_access_penalty=43200)
    if action == "locate":
        if type(p.get("verbose", True)) is not bool:
            invalid()
        out["verbose"] = True
    else:
        if p.get("format") != "osrm" or p.get("shape_format") != "geojson":
            invalid()
        if p.get("directions_options", {}) != {"language": "ja-JP", "units": "kilometers"}:
            invalid()
        out.update(format="osrm", shape_format="geojson", directions_options={"language": "ja-JP", "units": "kilometers"})
        polygons = p.get("exclude_polygons", [])
        if not isinstance(polygons, list) or len(polygons) > 50:
            invalid()
        for ring in polygons:
            if not isinstance(ring, list) or not 4 <= len(ring) <= 100 or ring[0] != ring[-1]:
                invalid()
            for pair in ring:
                if not isinstance(pair, list) or len(pair) != 2:
                    invalid()
                numeric(pair[0], -180, 180); numeric(pair[1], -90, 90)
        out["exclude_polygons"] = polygons
        if "alternates" in p:
            if type(p["alternates"]) is not int or not 0 <= p["alternates"] <= 2:
                invalid()
            if len(locations) != 2:
                invalid()
            out["alternates"] = p["alternates"]
    return action, out


def _fetch(action, params, timeout_ms=18000):
    if not hasattr(_local, "session"):
        _local.session = requests.Session()
    try:
        with _local.session.post(VALHALLA_ORIGIN + "/" + action, json=params,
                headers={"X-Client-Id": CLIENT_ID, "User-Agent": USER_AGENT, "Accept": "application/json"},
                timeout=(min(3, timeout_ms / 4000), max(.1, min(55, timeout_ms / 1000 - 4))), allow_redirects=False, stream=True) as response:
            if response.status_code == 429:
                wait = VALHALLA_GATE.cooldown(response.headers.get("Retry-After"))
                error = RouteError("ROUTING_RATE_LIMIT", "徒歩検索先の利用上限に達しました。時間を置いてお試しください。", 429)
                error.retry_after = wait
                raise error
            if response.status_code >= 500:
                VALHALLA_GATE.cooldown(default=15)
                raise RouteError("ROUTING_UNAVAILABLE", "徒歩検索サービスに接続できませんでした。時間を置いてお試しください。", 503)
            content = bytearray()
            for chunk in response.iter_content(65536):
                content.extend(chunk)
                if len(content) > RESPONSE_BYTES:
                    raise RouteError("ROUTING_RESPONSE", "ルートの情報量が表示上限を超えています。", 502)
            data = json.loads(content)
            if response.status_code != 200 or (isinstance(data, dict) and (data.get("error") or data.get("code", "Ok") != "Ok")):
                code = str(data.get("error_code", data.get("code", "NoRoute"))) if isinstance(data, dict) else "NoRoute"
                if code in ("154", "DistanceExceeded"):
                    raise RouteError("DistanceExceeded", "目的地が遠すぎるため、一括の徒歩検索では取得できませんでした。", 400)
                if code in ("170", "171", "172", "442", "NoRoute", "NoSegment"):
                    raise RouteError(code, "徒歩で移動可能な経路が見つかりませんでした。", 422)
                raise RouteError("ROUTING_RESPONSE", "徒歩ルートの情報を取得できませんでした。", 502)
            if not isinstance(data, list if action == "locate" else dict):
                raise ValueError()
            return data, len(content)
    except requests.Timeout:
        raise RouteError("ROUTING_TIMEOUT", "徒歩ルート検索がタイムアウトしました。", 504) from None
    except (requests.RequestException, ValueError):
        raise RouteError("ROUTING_UNAVAILABLE", "徒歩検索サービスとの通信に失敗しました。", 502) from None


def valhalla_data(payload):
    global _cache_bytes
    action, params = validated(payload)
    key = sha256(json.dumps([action, params], sort_keys=True, separators=(",", ":")).encode()).digest()
    with _lock:
        now = time.monotonic()
        for old in list(_cache):
            if now - _cache[old][0] >= TTL:
                _cache_bytes -= _cache.pop(old)[2]
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key][1]
        job = _jobs.get(key)
        owner = job is None
        if owner:
            job = _jobs[key] = Future()
    if not owner:
        try:
            return job.result(timeout=2)
        except FutureTimeout:
            raise RouteError("ROUTING_BUSY", "同じルートを検索中です。少し待ってから再度お試しください。", 429) from None
    try:
        with VALHALLA_GATE.slot():
            data, size = _fetch(action, params, payload.get("timeout_ms", 18000))
        with _lock:
            if size <= CACHE_BYTES:
                _cache[key] = (time.monotonic(), data, size); _cache_bytes += size
                while len(_cache) > 64 or _cache_bytes > CACHE_BYTES:
                    _cache_bytes -= _cache.popitem(last=False)[1][2]
        job.set_result(data)
        return data
    except BaseException as error:
        job.set_exception(error)
        raise
    finally:
        with _lock:
            _jobs.pop(key, None)
