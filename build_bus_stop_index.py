"""Build prefecture-sized, reusable bus-stop files from the official P11-2022 GML archive."""

import argparse
import gzip
import hashlib
import io
import json
from math import isfinite
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

SOURCE = "https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11-v3_0.html"
ARCHIVE_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_GML.zip"
ARCHIVE_SHA256 = "e74da3736c56ddeb1f47c18d6e5f373f40fa7f3c7d695593029e8ac7a7f790d1"
NS = {"k": "http://nlftp.mlit.go.jp/ksj/schemas/ksj-app", "g": "http://schemas.opengis.net/gml/3.2.1"}
XLINK = "{http://www.w3.org/1999/xlink}href"
GML_ID = "{http://schemas.opengis.net/gml/3.2.1}id"


def write_data(path, data):
    body = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    path.write_bytes(body)
    compressed = gzip.compress(body, compresslevel=9, mtime=0)
    path.with_suffix(".json.gz").write_bytes(compressed)
    return len(body), len(compressed)


def rows_from_xml(body):
    root = ET.fromstring(body)
    points = {}
    for point in root.findall("g:Point", NS):
        lat, lng = map(float, point.findtext("g:pos", namespaces=NS).split())
        if not (isfinite(lat) and isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("Invalid bus stop coordinates")
        points[point.attrib[GML_ID]] = [round(lat, 6), round(lng, 6)]
    rows = []
    for stop in root.findall("k:BusStop", NS):
        name = stop.findtext("k:bsn", namespaces=NS)
        if not name or not name.strip():
            raise ValueError("Missing bus stop name")
        point = points[stop.find("k:loc", NS).attrib[XLINK].removeprefix("#")]
        operator = stop.findtext("k:boc", default="", namespaces=NS).strip()
        rows.append([name.strip(), *point, operator, stop.attrib[GML_ID]])
    if not rows:
        raise ValueError("Empty prefecture")
    return rows


def build(archive, output):
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError("Unexpected archive; verify its source and terms before updating the checksum")
    output.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "referenceYear": 2022, "source": SOURCE, "archiveUrl": ARCHIVE_URL,
                "archiveSha256": digest, "license": "CC BY 4.0",
                "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
                "termsUrl": "https://nlftp.mlit.go.jp/ksj/other/agreement.html",
                "licenseBasis": "PDL1.0（CC BY 4.0互換）に基づきCC BY 4.0で利用・再配布",
                "attribution": "国土数値情報（バス停留所データ・2022年度）（国土交通省）を加工して作成",
                "modified": "地点名・座標・事業者・地物IDを抽出。座標を小数6桁に丸め都道府県別に分割・圧縮。",
                "columns": ["name", "lat", "lng", "operator", "id"], "sourceFeatureCount": 0, "parts": []}
    with ZipFile(archive) as national:
        members = sorted(n for n in national.namelist() if re.fullmatch(r"P11-22_\d{2}_GML.zip", n))
        if len(members) != 47:
            raise ValueError("Expected 47 prefectures")
        for member in members:
            prefecture = member[7:9]
            with ZipFile(io.BytesIO(national.read(member))) as regional:
                names = [n for n in regional.namelist() if n.endswith(f"/P11-22_{prefecture}.xml")]
                if len(names) != 1:
                    raise ValueError("Missing prefecture GML")
                rows = rows_from_xml(regional.read(names[0]))
            data = {"version": 1, "referenceYear": 2022, "prefecture": prefecture, "stops": rows}
            size, zipped = write_data(output / f"{prefecture}.json", data)
            bounds = [min(r[1] for r in rows), min(r[2] for r in rows), max(r[1] for r in rows), max(r[2] for r in rows)]
            manifest["parts"].append({"file": f"{prefecture}.json", "count": len(rows), "bounds": bounds,
                                      "bytes": size, "gzipBytes": zipped})
            manifest["sourceFeatureCount"] += len(rows)
    if manifest["sourceFeatureCount"] != 278515:
        raise ValueError("Unexpected source feature count")
    write_data(output / "index.json", manifest)
    print(f"Built {manifest['sourceFeatureCount']} stops in {len(manifest['parts'])} prefectures; "
          f"JSON {sum(p['bytes'] for p in manifest['parts'])} bytes, gzip {sum(p['gzipBytes'] for p in manifest['parts'])} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "static/bus-stops-jp-2022-v1")
    args = parser.parse_args()
    build(args.archive, args.output)
