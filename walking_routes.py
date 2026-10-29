"""Server-side walking suggestions. ORS credentials never leave Python."""

from collections import OrderedDict
from math import asin, cos, isfinite, radians, sin, sqrt
from threading import Lock, local
import os
import time

import requests

ORS_ENDPOINT = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
_CACHE = OrderedDict()
_LOCK = Lock()
_LOCAL = local()


class RouteError(Exception):
    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def number(value):
    return type(value) in (int, float) and isfinite(value)


def point(value):
    if not isinstance(value, dict) or not number(value.get("lat")) or not number(value.get("lng")):
        raise RouteError("INVALID_REQUEST", "出発地点と目的地を指定してください。", 400)
    if not -90 <= value["lat"] <= 90 or not -180 <= value["lng"] <= 180:
        raise RouteError("INVALID_REQUEST", "地点の座標が正しくありません。", 400)
    return {"lat": float(value["lat"]), "lng": float(value["lng"])}


def distance(a, b):
    lat1, lat2 = radians(a["lat"]), radians(b["lat"])
    term = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin(radians(b["lng"] - a["lng"]) / 2) ** 2
    return 6371000 * 2 * asin(sqrt(min(1, max(0, term))))


def scenic_point(start, end, map_fetch):
    """Use a public viewpoint or an actual path node in a park, not an area centroid."""
    direct = distance(start, end)
    lat = (start["lat"] + end["lat"]) / 2
    lng = (start["lng"] + ((end["lng"] - start["lng"] + 540) % 360 - 180) / 2 + 540) % 360 - 180
    radius = round(min(3500, max(500, direct * 0.6 + 300)))
    around = f"(around:{radius},{lat:.6f},{lng:.6f})"
    access = '[access!~"^(private|no|customers|permit|military)$"][fee!="yes"]'
    query = ('[out:json][timeout:10];node' + around + '[tourism="viewpoint"]' + access + '->.views;'
             '(way' + around + '[leisure~"^(park|garden|nature_reserve)$"]' + access + ';'
             'relation' + around + '[leisure~"^(park|garden|nature_reserve)$"]' + access + ';)->.parks;'
             '.parks map_to_area->.areas;way(area.areas)' + around
             + '[highway~"^(footway|path|pedestrian)$"][foot!~"^(private|no)$"]' + access + '->.paths;'
             '(node(w.paths)(area.areas)' + around + access + ';.views;);out body 150;')
    data = map_fetch(query, 0, 15000)
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        raise ValueError("Invalid scenic map data")
    ranked = []
    for item in data["elements"]:
        if not isinstance(item, dict) or item.get("type") != "node":
            continue
        try:
            candidate = point({"lat": item.get("lat"), "lng": item.get("lon")})
        except RouteError:
            continue
        tags = item.get("tags", {})
        if not isinstance(tags, dict) or tags.get("access") in ("private", "no", "customers", "permit", "military") or tags.get("foot") in ("private", "no"):
            continue
        first, second = distance(start, candidate), distance(candidate, end)
        if min(first, second) < 80 or first + second > min(direct * 2 + 500, direct + 4000):
            continue
        x = radians(((end["lng"] - start["lng"] + 540) % 360) - 180) * cos(radians(lat))
        y = radians(end["lat"] - start["lat"])
        px = radians(((candidate["lng"] - start["lng"] + 540) % 360) - 180) * cos(radians(lat))
        py = radians(candidate["lat"] - start["lat"])
        separation = abs(x * py - y * px) / max(1e-12, sqrt(x * x + y * y)) * 6371000
        name = str(tags.get("name:ja") or tags.get("name") or ("展望地点" if tags.get("tourism") == "viewpoint" else "公園内の歩道"))[:120]
        ranked.append((first + second - min(separation, 500) * 0.8, {**candidate, "name": name}))
    return min(ranked, key=lambda entry: entry[0])[1] if ranked else None


def _request_ors(coordinates, key, green=False):
    if not hasattr(_LOCAL, "session"):
        _LOCAL.session = requests.Session()
    body = {"coordinates": [[p["lng"], p["lat"]] for p in coordinates],
            "preference": "recommended" if green else "shortest", "instructions": True,
            "language": "en", "units": "m", "radiuses": [50] * len(coordinates)}
    if green:
        body["options"] = {"avoid_features": ["ferries", "fords"], "profile_params": {
            "weightings": {"green": {"factor": 0.9}, "quiet": {"factor": 0.7}}}}
    try:
        with _LOCAL.session.post(ORS_ENDPOINT, json=body,
                                 headers={"Authorization": key, "Accept": "application/geo+json",
                                          "User-Agent": "WalkingMap/1.0"},
                                 timeout=(5, 25), allow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise RouteError("ORS_AUTH_FAILED", "ORSのAPIキーを確認してください。", 503)
            if response.status_code == 429:
                raise RouteError("ORS_RATE_LIMIT", "ORSの利用上限に達しました。時間を置いてお試しください。", 429)
            if response.status_code in (400, 404, 422):
                raise RouteError("ORS_NO_ROUTE", "この条件で歩けるルートを取得できませんでした。", 422)
            if response.status_code != 200:
                raise RouteError("ORS_UNAVAILABLE", "ORSに接続できませんでした。時間を置いてお試しください。")
            return response.json()
    except requests.Timeout:
        raise RouteError("ORS_TIMEOUT", "ルートの取得がタイムアウトしました。もう一度お試しください。", 504) from None
    except (requests.RequestException, ValueError):
        raise RouteError("ORS_UNAVAILABLE", "ルートの情報を取得できませんでした。") from None


def normalized_route(data, coordinates, speed, roundtrip=False):
    try:
        feature = data["features"][0]
        geometry, props = feature["geometry"], feature["properties"]
        shape, segments = geometry["coordinates"], props["segments"]
        meters = props["summary"]["distance"]
        if geometry["type"] != "LineString" or not isinstance(shape, list) or len(shape) < 2:
            raise ValueError()
        if not number(meters) or meters <= 0 or len(segments) != len(coordinates) - 1:
            raise ValueError()
        for coord in shape:
            if not isinstance(coord, list) or len(coord) < 2:
                raise ValueError()
            point({"lat": coord[1], "lng": coord[0]})
        way_points = props["way_points"]
        if len(way_points) != len(coordinates):
            raise ValueError()
        for requested, index in zip(coordinates, way_points):
            if type(index) is not int or not 0 <= index < len(shape):
                raise ValueError()
            if distance(requested, {"lat": shape[index][1], "lng": shape[index][0]}) > 65:
                raise ValueError()
        labels = {0: "左折", 1: "右折", 2: "鋭く左折", 3: "鋭く右折", 4: "左斜めに進む", 5: "右斜めに進む",
                  6: "直進", 7: "環状交差点に入る", 8: "環状交差点を出る", 9: "折り返す", 12: "左側へ進む", 13: "右側へ進む"}
        legs = []
        for i, segment in enumerate(segments):
            steps = []
            for entry in segment["steps"]:
                kind, length = entry["type"], entry["distance"]
                if type(kind) is not int or not number(length) or length < 0:
                    raise ValueError()
                instruction = labels.get(kind, "道なりに進む")
                if kind == 10:
                    instruction = "出発地点に戻る" if roundtrip and i == len(segments) - 1 else "目的地に到着" if (roundtrip and i == 0) or i == len(segments) - 1 else "経由地点に到着"
                elif kind == 11:
                    instruction = "出発地点から歩き始める" if i == 0 else "目的地から歩き始める" if roundtrip and i == 1 else "経由地点から歩き始める"
                name = str(entry.get("name") or "").strip()[:200]
                if name and kind not in (10, 11):
                    instruction += f"（{name}）"
                steps.append({"mode": "walking", "distance": length, "instruction": instruction,
                              "maneuver": {"type": "arrive" if kind == 10 else "depart" if kind == 11 else "turn"}})
            if not steps:
                raise ValueError()
            legs.append({"steps": steps})
        return {"distance": meters, "duration": meters / (speed / 3.6),
                "geometry": {"type": "LineString", "coordinates": [c[:2] for c in shape]}, "legs": legs}
    except (KeyError, IndexError, TypeError, ValueError, RouteError):
        raise RouteError("ORS_INVALID_RESPONSE", "歩行可能なルートの形状を確認できませんでした。") from None


def walking_suggestions(payload, map_fetch):
    if not isinstance(payload, dict):
        raise RouteError("INVALID_REQUEST", "検索条件が正しくありません。", 400)
    start, end = point(payload.get("start")), point(payload.get("destination"))
    mode, speed = payload.get("mode"), payload.get("speed_kmh")
    if mode not in ("scenic", "roundtrip") or not number(speed) or not 2.5 <= speed <= 6.5:
        raise RouteError("INVALID_REQUEST", "ルートの種類と歩く速さを確認してください。", 400)
    if distance(start, end) < 30:
        raise RouteError("POINTS_TOO_CLOSE", "出発地点から30m以上離れた目的地を指定してください。", 400)
    key = os.environ.get("ORS_API_KEY", "").strip()
    if not key:
        raise RouteError("ORS_NOT_CONFIGURED", "Python側にORS_API_KEYを設定して再起動してください。", 503)
    cache_key = (hash(key), tuple(start.values()), tuple(end.values()), mode, speed)
    with _LOCK:
        cached = _CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < 300:
            return cached[1]
    loop = mode == "roundtrip"
    coordinates = [start, end, start] if loop else [start, end]
    base = normalized_route(_request_ors(coordinates, key), coordinates, speed, loop)
    result = {"routes": [{"id": "roundtrip" if loop else "ors_standard", "route": base,
                          "detail": "目的地を経由して出発地点へ戻る往復ルート" if loop else "距離を優先した徒歩ルート"}], "warnings": []}
    landmark = None
    try:
        landmark = scenic_point(start, end, map_fetch)
    except (requests.RequestException, ValueError, TypeError, KeyError):
        result["warnings"].append("周辺の見どころ情報を取得できませんでした。")
    scenic_coordinates = ([start, end, landmark, start] if loop else [start, landmark, end]) if landmark else coordinates
    try:
        route = normalized_route(_request_ors(scenic_coordinates, key, green=True), scenic_coordinates, speed, loop)
        result["routes"].append({"id": "roundtrip_scenic" if loop else "scenic", "route": route,
                                 "detail": f'{landmark["name"]}を経由' if landmark else "緑や静かな道を優先"})
    except RouteError as error:
        result["warnings"].append(error.message)
    with _LOCK:
        if not result["warnings"]:
            if len(_CACHE) >= 32:
                _CACHE.popitem(last=False)
            _CACHE[cache_key] = (time.monotonic(), result)
    return result
