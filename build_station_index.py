"""Build the local station index from MLIT's CC BY 4.0 N02-25 ZIP.

Usage: python build_station_index.py path/to/N02-25_GML.zip
The source is downloaded separately; this script never sends location data.
"""

import argparse
import gzip
import hashlib
import json
from math import cos, hypot, radians
from pathlib import Path
import zipfile

SOURCE = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html"
ARCHIVE_SHA256 = "aaf76af133b2e771e538fabc4646d2e443dc1d5a67b221382a28d744e706cc9f"


def midpoint(coordinates):
    lengths = [hypot((b[0] - a[0]) * cos(radians((a[1] + b[1]) / 2)), b[1] - a[1])
               for a, b in zip(coordinates, coordinates[1:])]
    remaining = sum(lengths) / 2
    for a, b, length in zip(coordinates, coordinates[1:], lengths):
        if length and remaining <= length:
            ratio = remaining / length
            return [a[i] + (b[i] - a[i]) * ratio for i in (0, 1)]
        remaining -= length
    return coordinates[0][:2]


def build(archive_path, output):
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError("Source ZIP changed. Review the official release and update its checksum before rebuilding.")
    with zipfile.ZipFile(archive_path) as archive:
        features = json.loads(archive.read("N02-25_GML/UTF-8/N02-25_Station.geojson"))["features"]
    groups = {}
    for feature in features:
        properties, geometry = feature["properties"], feature["geometry"]
        if geometry["type"] != "LineString" or not geometry["coordinates"]:
            raise ValueError("Unexpected station geometry")
        code = properties["N02_005c"]
        group = properties["N02_005g"] or code
        point = midpoint(geometry["coordinates"])
        entry = groups.setdefault(group, {"name": properties["N02_005"], "points": [], "lines": set(), "operators": set()})
        if entry["name"] != properties["N02_005"]:
            raise ValueError("Different station names share a group code")
        entry["points"].append((code, point))
        entry["lines"].add(properties["N02_003"])
        entry["operators"].add(properties["N02_004"])
    stations = []
    for group, entry in sorted(groups.items()):
        # Retain the official representative station, rather than inventing a
        # destination between different operators' platforms.
        point = next((point for code, point in entry["points"] if code == group), entry["points"][0][1])
        stations.append([entry["name"], round(point[1], 6), round(point[0], 6),
                         "／".join(sorted(entry["lines"])), "／".join(sorted(entry["operators"])), group])
    data = {"version": 1, "referenceDate": "2025-12-31", "source": SOURCE,
            "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "attribution": "国土数値情報（鉄道データ・2025年度）（国土交通省）を加工して作成",
            "archiveSha256": digest, "sourceFeatureCount": len(features),
            "columns": ["name", "lat", "lng", "lines", "operators", "group"], "stations": stations}
    body = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    output.write_bytes(body)
    compressed = gzip.compress(body, compresslevel=9, mtime=0)
    output.with_suffix(output.suffix + ".gz").write_bytes(compressed)
    print(f"Built {len(stations)} station groups from {len(features)} features: {len(body)} bytes, gzip {len(compressed)} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "static" / "stations-jp-2025-v1.json")
    args = parser.parse_args()
    build(args.archive, args.output)
