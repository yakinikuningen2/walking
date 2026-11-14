"""Extract Tokyo facility toilets from the MLIT redistribution, without photos or railway facilities."""

import argparse
from collections import defaultdict
import csv
import gzip
import hashlib
import io
import json
from math import isfinite
from pathlib import Path
from zipfile import ZipFile

SOURCE = "https://ckan.hokonavi.go.jp/dataset/facility_tokyo_bf-toilet"
ARCHIVE_SHA256 = "65999b9535f87673a30f24a28b2f9eb54d1b215ae4cb4818d105dbca41189ec6"


def csv_rows(archive, name):
    body = archive.read(f"tokyo_barrier-free_toilet/{name}.csv")
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = body.decode("cp932")
    return list(csv.DictReader(io.StringIO(text)))


def build(archive_path, output):
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError("Unexpected source archive; verify terms and contents before updating")
    with ZipFile(archive_path) as archive:
        facilities = csv_rows(archive, "facility")
        equipment = csv_rows(archive, "bf_toilet")
        times = csv_rows(archive, "time")
    active = defaultdict(list)
    for row in equipment:
        if not row["deletedAt"].strip():
            active[row["facilId"]].append(row)
    hours = defaultdict(set)
    for row in times:
        if not row["deletedAt"].strip() and row["equipId"] in {item["equipId"] for item in active[row["facilId"]]}:
            value = " ".join(v.strip() for v in (row["from"], row["through"], row["hours"], row["note"]) if v.strip())
            if value:
                hours[row["facilId"]].add(value)
    places = []
    excluded = defaultdict(int)
    for row in facilities:
        if row["deletedAt"].strip() or not active[row["facilId"]] or row["t_toilet"] != "1":
            excluded["deletedOrNoToilet"] += 1
            continue
        if row["type"] == "9":
            excluded["transportFacility"] += 1
            continue
        try:
            lat, lng = float(row["latitude"]), float(row["longitude"])
            valid = isfinite(lat) and isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180
        except ValueError:
            valid = False
        if not valid:
            excluded["invalidCoordinates"] += 1
            continue
        notes = sorted({r["note"].strip() for r in active[row["facilId"]] if r["note"].strip()})
        places.append([row["facilId"], row["name"].strip(), round(lat, 6), round(lng, 6), row["address"].strip(),
                       "\n".join(sorted(hours[row["facilId"]])), "\n".join(notes)])
    data = {"version": 1, "referenceYear": 2024, "sourceUpdatedDate": "2026-03-19", "source": SOURCE,
            "additionalSource": "https://www.fukushi.metro.tokyo.lg.jp/kiban/machizukuri/bf_data",
            "archiveSha256": digest, "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "licenseBasis": "配布元のPDL1.0互換規定に基づきCC BY 4.0で利用・再配布",
            "attribution": "東京都福祉局の車椅子使用者対応トイレ情報（令和6年度更新版）を国土交通省が変換したデータを、本アプリでさらに加工",
            "modified": "施設単位に集約。名称・施設座標・住所・利用時間・備考を抽出。削除済み・座標不明・交通施設を除外。写真は同梱しない。",
            "sourceFacilityCount": len(facilities), "excluded": dict(excluded),
            "columns": ["id", "facilityName", "lat", "lng", "address", "hours", "note"], "places": places}
    body = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    output.write_bytes(body)
    compressed = gzip.compress(body, compresslevel=9, mtime=0)
    output.with_suffix(".json.gz").write_bytes(compressed)
    print(f"Built {len(places)} facility toilets: {len(body)} bytes, gzip {len(compressed)} bytes; exclusions {dict(excluded)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "static/toilets-tokyo-2024-v1.json")
    args = parser.parse_args()
    build(args.archive, args.output)
