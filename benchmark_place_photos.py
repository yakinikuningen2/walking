"""Live before/after photo audit. Run explicitly; never run in unit tests.

Stores raw API replies outside the repository, and exports aggregate evidence.
No image binaries, article text or API keys enter the published report.
"""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import time

import place_photos as after


def select_rows(rows, count=14):
    # Spatial strata first, then deterministic hashes. No photo-existence selection.
    cells = defaultdict(list)
    for row in rows:
        cells[(int(row[2] // 2), int(row[3] // 2))].append(row)
    for items in cells.values():
        items.sort(key=lambda r: hashlib.sha256(str(r[0]).encode()).hexdigest())
    selected = []
    ordered = sorted(cells, key=lambda c: hashlib.sha256(str(c).encode()).hexdigest())
    while len(selected) < count and any(cells.values()):
        for cell in ordered:
            if cells[cell]: selected.append(cells[cell].pop())
            if len(selected) == count: break
    return selected


def inputs(root):
    cases = []
    for kind, label in (("park", "park"), ("culture", "museum"), ("restaurant", "restaurant"), ("cafe", "cafe"), ("sightseeing", "sightseeing")):
        data = json.loads((root / f"static/discovery-wikidata-jp-2026-11-13-v1/{kind}.json").read_text(encoding="utf-8"))
        for i, row in enumerate(select_rows(data["places"])):
            cases.append({"id": f"{label}/{row[0]}", "category": label, "provider": "Wikidata CC0", "qid": row[0],
                "place": {"name": row[1], "lat": row[2], "lng": row[3], "kindId": kind,
                          "hints": {"wikidata": row[0]} if i % 2 == 0 else {}}})
    for row in select_rows(json.loads((root / "static/shrines-jp-2026-11-13-v1.json").read_text(encoding="utf-8"))["places"]):
        cases.append({"id": "shrine/" + row[0], "category": "shrine", "provider": "Wikidata CC0", "qid": row[0],
                      "place": {"name": row[1], "lat": row[2], "lng": row[3], "kindId": "shrine", "hints": {"wikidata": row[0]}}})
    data = json.loads((root / "static/discovery-geonames-jp-2026-11-13-v1/park.json").read_text(encoding="utf-8"))
    for row in select_rows(data["places"]):
        cases.append({"id": "local-park/" + row[0], "category": "local-park", "provider": "GeoNames CC BY 4.0", "qid": None,
                      "place": {"name": row[1], "lat": row[2], "lng": row[3], "kindId": "park", "hints": {}}})
    data = json.loads((root / "static/stations-jp-2025-v1.json").read_text(encoding="utf-8"))
    rows = [[r[5], r[0], r[1], r[2]] for r in data["stations"]]
    for row in select_rows(rows):
        cases.append({"id": "station/" + row[0], "category": "station", "provider": "MLIT CC BY 4.0", "qid": None,
                      "place": {"name": row[1] + "駅", "lat": row[2], "lng": row[3], "kindId": "station", "hints": {}}})
    cases.append({"id": "reported/nihon-chs", "category": "university", "provider": "OSM via Photon ODbL", "qid": "Q11507848",
        "place": {"name": "日本大学文理学部", "lat": 35.6641211, "lng": 139.6342003,
                  "address": "日本、東京都、世田谷区、桜上水三丁目、日大通り", "hints": {}}})
    return cases


def load_baseline(file):
    spec = importlib.util.spec_from_file_location("photo_before", file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def run_one(module, case, folder, stage):
    place = module.validate_place(case["place"])
    resolver = module.Resolver(place)
    original = resolver.api
    trace = []
    def recorded(site, **params):
        start = time.monotonic()
        try:
            data = original(site, **params)
            trace.append({"site": site, "params": params, "seconds": time.monotonic()-start, "data": data})
            return data
        except module.PhotoError as error:
            trace.append({"site": site, "params": params, "seconds": time.monotonic()-start, "error": error.code})
            raise
    resolver.api = recorded
    start = time.monotonic()
    try:
        photo = resolver.resolve()
        result = {"status": "found" if photo else "none", "photo": photo}
    except module.PhotoError as error:
        result = {"status": "error", "code": error.code, "photo": None}
    finally:
        resolver.session.close()
    result.update({"id": case["id"], "name": case["place"]["name"], "category": case["category"],
                   "seconds": round(time.monotonic()-start, 4), "calls": resolver.calls})
    name = hashlib.sha256(case["id"].encode()).hexdigest()[:16]
    (folder / f"{stage}-{name}.json").write_text(json.dumps({"case": case, "result": result, "trace": trace}, ensure_ascii=False), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True, help="Temporary raw-response directory outside the repo")
    parser.add_argument("--stage", choices=("before", "after", "after-final"), required=True)
    args = parser.parse_args()
    root = Path(__file__).parent
    args.work.mkdir(parents=True, exist_ok=True)
    if args.work.resolve().is_relative_to(root.resolve()): raise SystemExit("Raw replies must stay outside the repository")
    cases = inputs(root)
    module = load_baseline(args.baseline) if args.stage == "before" else after
    results = []
    def work(case):
        name = hashlib.sha256(case["id"].encode()).hexdigest()[:16]
        cached = args.work / f"{args.stage}-{name}.json"
        if cached.exists(): return json.loads(cached.read_text(encoding="utf-8"))["result"]
        return run_one(module, case, args.work, args.stage)
    with ThreadPoolExecutor(max_workers=2) as executor:
        for result in executor.map(work, cases):
            results.append(result)
            print(json.dumps({"stage": args.stage, "done": len(results), "total": len(cases), "id": result["id"], "status": result["status"], "seconds": result["seconds"]}), flush=True)
    summary = {"stage": args.stage, "count": len(results), "found": sum(r["status"] == "found" for r in results),
               "errors": sum(r["status"] == "error" for r in results), "averageSeconds": statistics.mean(r["seconds"] for r in results),
               "categories": {category: {"count": len(items), "found": sum(r["status"] == "found" for r in items), "averageSeconds": statistics.mean(r["seconds"] for r in items)}
                              for category, items in ((category, [r for r in results if r["category"] == category]) for category in sorted({r["category"] for r in results}))}}
    (args.work / f"{args.stage}-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__": main()
