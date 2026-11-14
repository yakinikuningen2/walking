"""Build the pinned CC0 Wikidata shrine snapshot; no live API is used by the app."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import re

SOURCE_SHA256 = "3adc7ba3bc0a19387fcb53bc4f09a6f09eb7f5a1f70c64b1cedcff34c1053567"
SNAPSHOT_DATE = "2026-11-13"


def build(source):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError("Unexpected snapshot: verify source, date and licensing before updating the pinned version")
    source_data = json.loads(raw)
    records = {}
    for row in source_data["data"]["results"]["bindings"]:
        if row["coord"]["type"] == "uri":
            continue  # Wikidata's "unknown value" is not a usable coordinate.
        item = row["item"]["value"].removeprefix("http://www.wikidata.org/entity/")
        name = row["name"]["value"].strip()
        coordinate = re.fullmatch(r"Point\(([-\d.eE+]+) ([-\d.eE+]+)\)", row["coord"]["value"])
        if not re.fullmatch(r"Q[1-9]\d*", item) or not name or len(name) > 120 or not coordinate:
            raise ValueError("Invalid source record")
        lng, lat = map(float, coordinate.groups())
        # Only present-day Japan; overseas/historical shrine sites are not destinations here.
        if not all(map(math.isfinite, (lat, lng))) or not (20 <= lat <= 46 and 122 <= lng <= 154):
            continue
        candidate = [item, name, round(lat, 6), round(lng, 6)]
        # Repeated subclass paths/coordinate statements must not duplicate a shrine.
        if item not in records or candidate < records[item]:
            records[item] = candidate
    return {"version": 1, "snapshotDate": SNAPSHOT_DATE,
            "provider": "Wikidata contributors", "license": "CC0 1.0",
            "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
            "sourceUrl": "https://query.wikidata.org/sparql", "sourceSha256": SOURCE_SHA256,
            "query": source_data["query"],
            "modified": "Japanese labels and coordinates of Japanese Shinto shrines (Q845945/subclasses); dissolved items excluded; unknown coordinates excluded; Japan bounds; one row per QID; coordinates rounded to six decimals. No articles or images.",
            "columns": ["wikidataId", "name", "lat", "lng"],
            "places": sorted(records.values(), key=lambda row: int(row[0][1:]))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    data = build(args.source)
    target = Path(__file__).parent / "static/shrines-jp-2026-11-13-v1.json"
    content = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    target.write_bytes(content)
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    target.with_suffix(".json.gz").write_bytes(compressed)
    print(json.dumps({"count": len(data["places"]), "bytes": len(content), "gzipBytes": len(compressed)}))
