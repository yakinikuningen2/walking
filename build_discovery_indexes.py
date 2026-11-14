"""Build pinned, separately licensed destination indexes. Raw downloads stay outside Git."""
import argparse
import csv
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import re
import zipfile

DATE = "2026-11-13"
WD_HASHES = {
    "cafe-Q30022-direct.json": "6ff5d9ac329386fde7e809250311cd68a8f7de6a783e444c900feda22c819e5f",
    "culture-Q1007870.json": "1d2002a346ae58a180f55cbdc45f881a46053c9d49a8aebcb8f8c8aa8f1a9fc9",
    "culture-Q33506-direct.json": "8420ed730c5b1a6c1c6ea4a35bf964c7ffb4b45ddb386950c270d39639647eba",
    "mountain-Q207326.json": "7f87784d0149d04b48573a5d5abb6d2bec2589a3221ed8a746b59d453c6b31e9",
    "neighborhood-Q123705-direct.json": "1ae372e9cf9894088c4a02972b29c3bb7898c3a3d88479f78cf2dfa905af4f41",
    "park-Q167346.json": "111df37f9a8335c1a4f9431cf561e129dd723156263f9a03dd48e7cf83a12d6f",
    "park-Q22698-direct.json": "b0b756dc40e5b9e5da4d87836cc616bc8932dd56dd08ed85766793cda79dc2b5",
    "restaurant-Q11707-direct.json": "8e84962c5fe2e984ff1c32750c20afd330d023c82f68051c8112511fdacce4f4",
    "shopping-Q11315-direct.json": "ccc14c2204b8966313ebb5edf206ed8b5dc9af91dfedf6acd0b15a8bf6c0a16d",
    "shopping-Q180846-direct.json": "f1655e5a5aa9383c6d013293c5b7956432108d7c8183d5d35962984028a6f252",
    "sightseeing-Q1440300-direct.json": "c4d8da4743252fd7e479334cdf8b775d83dee74eceeb214195a299e247039625",
    "sightseeing-Q23413-direct.json": "43337f4dff1c901b70d7e99d1f9353aecfa1437dd26ce6b6efdcf134e8b1a0df",
}
GN_HASHES = {
    "geonames-JP-2026-11-13.zip": "c118e2390410bc3df4cc266627698881b737925fc3815dbdb7da52b096e6fe4d",
    "geonames-JP-alternates-2026-11-13.zip": "c118a84e68d4644fc8cc2886c18b49d4a112eb2d4aa1527e84904b936f49e562",
}
GN_CODES = {"MT": "mountain", "PK": "mountain", "PPL": "neighborhood", "PPLL": "neighborhood",
            "PPLX": "neighborhood", "PRK": "park", "MUS": "culture", "OBPT": "sightseeing",
            "CSTL": "sightseeing", "MNMT": "sightseeing", "REST": "restaurant", "MALL": "shopping", "TMPL": "shrine"}


def checked(path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError(f"Unverified source: {path.name}")
    return raw


def valid_point(lat, lng):
    return math.isfinite(lat) and math.isfinite(lng) and 20 <= lat <= 46 and 122 <= lng <= 154


def wikidata(folder):
    grouped, sources = {}, {}
    for filename, expected in WD_HASHES.items():
        data = json.loads(checked(folder / filename, expected))
        kind, root = data["kind"], data["root"]
        if f"wd:{root}" not in data["query"] or "wd:Q17" not in data["query"]:
            raise ValueError("Unexpected query")
        sources.setdefault(kind, []).append({"file": filename, "sha256": expected, "query": data["query"],
                                             "sourceRows": len(data["data"]["results"]["bindings"])})
        for row in data["data"]["results"]["bindings"]:
            if row["coord"]["type"] == "uri":
                continue
            coordinate = re.fullmatch(r"Point\(([-\d.eE+]+) ([-\d.eE+]+)\)", row["coord"]["value"])
            if not coordinate:
                raise ValueError("Malformed coordinate")
            lng, lat = map(float, coordinate.groups())
            item = row["item"]["value"].split("/")[-1]
            name = row["name"]["value"].strip()
            if not valid_point(lat, lng) or not name or len(name) > 120:
                continue
            if not re.fullmatch(r"Q[1-9]\d*", item):
                raise ValueError("Invalid Wikidata ID")
            value = [item, name, round(lat, 6), round(lng, 6), root, None]
            records = grouped.setdefault(kind, {})
            if item not in records or value[:5] < records[item][:5]:
                records[item] = value
    return grouped, sources


def geonames(folder):
    def rows(filename):
        with zipfile.ZipFile(io.BytesIO(checked(folder / filename, GN_HASHES[filename]))) as z:
            return csv.reader(io.StringIO(z.read("JP.txt").decode("utf-8")), delimiter="\t")
    names = {}
    for row in rows("geonames-JP-alternates-2026-11-13.zip"):
        if len(row) < 8 or row[2] != "ja" or row[7] == "1" or (len(row) > 9 and row[9]):
            continue
        name = row[3].strip()
        if not name or len(name) > 120 or not re.search(r"[\u3040-\u30ff\u3400-\u9fff]", name):
            continue
        priority = (row[4] != "1", not bool(re.search(r"[\u3400-\u9fff]", name)), row[5] == "1", name)
        if row[1] not in names or priority < names[row[1]][0]:
            names[row[1]] = (priority, name)
    grouped = {}
    for row in rows("geonames-JP-2026-11-13.zip"):
        if len(row) != 19:
            raise ValueError("Unexpected GeoNames schema")
        item, code = row[0], row[7]
        if row[8] != "JP" or code not in GN_CODES or item not in names:
            continue
        lat, lng = float(row[4]), float(row[5])
        if not valid_point(lat, lng):
            continue
        elevation = int(row[15]) if re.fullmatch(r"-?\d+", row[15]) else None
        if elevation is not None and not -12000 <= elevation <= 10000:
            elevation = None
        grouped.setdefault(GN_CODES[code], {})[item] = [item, names[item][1], round(lat, 6), round(lng, 6), code, elevation]
    return grouped


def write_json(path, data):
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    path.write_bytes(raw)
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    path.with_suffix(".json.gz").write_bytes(compressed)
    return {"bytes": len(raw), "gzipBytes": len(compressed), "sha256": hashlib.sha256(raw).hexdigest()}


def write_indexes(root, source, grouped, sources):
    folder = root / f"discovery-{source}-jp-{DATE}-v1"
    folder.mkdir(exist_ok=True, parents=True)
    metadata = {"version": 1, "snapshotDate": DATE, "source": source,
                "provider": "Wikidata contributors" if source == "wikidata" else "GeoNames",
                "license": "CC0 1.0" if source == "wikidata" else "CC BY 4.0",
                "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/" if source == "wikidata" else "https://creativecommons.org/licenses/by/4.0/",
                "sourceUrl": "https://query.wikidata.org/sparql" if source == "wikidata" else "https://download.geonames.org/export/dump/JP.zip",
                "modified": "Classified Japanese labels, IDs and rounded coordinates only; no articles, photos or DEM. Representative points are not verified public entrances. Not exhaustive; present opening/access conditions are unknown."}
    parts = []
    for kind, rows in sorted(grouped.items()):
        places = sorted(rows.values(), key=lambda row: row[0])
        info = {**metadata, "kind": kind, "sources": sources[kind] if source == "wikidata" else sources,
                "columns": ["id", "name", "lat", "lng", "sourceClass", "elevation"], "places": places}
        stats = write_json(folder / f"{kind}.json", info)
        parts.append({"kind": kind, "file": f"{kind}.json", "count": len(places), **stats})
    write_json(folder / "index.json", {**metadata, "parts": parts})
    return parts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_folder", type=Path, help="Folder containing the two pinned GeoNames ZIPs and discovery-sources-2026-11-13")
    args = parser.parse_args()
    root = Path(__file__).parent / "static"
    wd, sources = wikidata(args.source_folder / f"discovery-sources-{DATE}")
    gn = geonames(args.source_folder)
    result = {"wikidata": write_indexes(root, "wikidata", wd, sources),
              "geonames": write_indexes(root, "geonames", gn,
                                       [{"file": name, "sha256": sha} for name, sha in GN_HASHES.items()])}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
