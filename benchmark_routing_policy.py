"""Explicit fixed-place live smoke test. Never uses device location or prints keys."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

import requests
import valhalla_service as service
import walking_routes as ors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true")
    options = parser.parse_args()
    if not options.live:
        print("Network disabled. Use --live for three fixed Tokyo-place requests, one ORS probe and one public health request.")
        return
    points = [{"lat": 35.681236, "lon": 139.767125}, {"lat": 35.675, "lon": 139.76332}]
    route = {"locations": points, "costing": "pedestrian", "format": "osrm", "shape_format": "geojson",
             "directions_options": {"language": "ja-JP", "units": "kilometers"}, "exclude_polygons": [],
             "costing_options": {"pedestrian": {"walking_speed": 4, "use_hills": .5, "step_penalty": 30}}}
    results = {"clientId": service.CLIENT_ID, "valhalla": []}
    with patch.object(service, "_fetch", wraps=service._fetch) as upstream:
        for action, params in [("route", route), ("locate", {"locations": points[:1], "costing": "pedestrian", "verbose": True}),
                               ("height", {"shape": points, "range": False, "height_precision": 0})]:
            t = time.monotonic()
            try:
                data = service.valhalla_data({"action": action, "params": params, "timeout_ms": 30000})
                summary = {"action": action, "ok": True, "seconds": round(time.monotonic()-t, 3)}
                if action == "route":
                    summary["roadMeters"] = data["routes"][0]["distance"]
                    count = upstream.call_count
                    service.valhalla_data({"action": action, "params": params})
                    summary["repeatedRequestUsedCache"] = upstream.call_count == count
            except Exception as error:
                summary = {"action": action, "ok": False, "code": getattr(error, "code", type(error).__name__)}
            results["valhalla"].append(summary)
        results["valhallaUpstreamRequests"] = upstream.call_count
    key = os.environ.get("ORS_API_KEY", "").strip()
    if key:
        try:
            data = ors.walking_suggestions({"start": {"lat": points[0]["lat"], "lng": points[0]["lon"]},
                "destination": {"lat": points[1]["lat"], "lng": points[1]["lon"]}, "mode": "standard", "speed_kmh": 4}, None)
            results["ors"] = {"endpoint": ors.ORS_ENDPOINT, "authenticated": True, "ok": True,
                              "roadMeters": data["routes"][0]["route"]["distance"]}
        except Exception as error:
            results["ors"] = {"endpoint": ors.ORS_ENDPOINT, "authenticated": True, "ok": False, "code": getattr(error, "code", type(error).__name__)}
    else:
        try:
            response = requests.post(ors.ORS_ENDPOINT, json={"coordinates": [[p["lon"], p["lat"]] for p in points]},
                headers={"User-Agent": service.USER_AGENT}, timeout=(3, 10), allow_redirects=False)
            results["ors"] = {"endpoint": ors.ORS_ENDPOINT, "authenticated": False, "http": response.status_code}
        except requests.RequestException as error:
            results["ors"] = {"endpoint": ors.ORS_ENDPOINT, "authenticated": False, "error": type(error).__name__}
    try:
        response = requests.get("https://walking-ctsh.onrender.com/api/health", timeout=(3, 15), allow_redirects=False)
        results["publicHealth"] = {"url": "https://walking-ctsh.onrender.com/api/health", "http": response.status_code}
    except requests.RequestException as error:
        results["publicHealth"] = {"url": "https://walking-ctsh.onrender.com/api/health", "error": type(error).__name__}
    path = Path(tempfile.gettempdir()) / "walking-routing-policy-live.json"
    path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=True, indent=2))


if __name__ == "__main__": main()
