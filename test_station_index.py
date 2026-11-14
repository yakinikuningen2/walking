import gzip
import hashlib
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest

import app


class StationIndexTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.WalkingHandler)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def get(self, path, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_shrine_snapshot_has_unique_japanese_records_and_gzip_delivery(self):
        path = Path(app.ROOT) / "static/shrines-jp-2026-11-13-v1.json"
        content = path.read_bytes()
        data = json.loads(content)
        self.assertEqual(data["license"], "CC0 1.0")
        self.assertEqual(data["snapshotDate"], "2026-11-13")
        self.assertEqual(len(data["places"]), 16983)
        self.assertEqual(len({r[0] for r in data["places"]}), 16983)
        self.assertTrue(all(len(r) == 4 and r[1] and 20 <= r[2] <= 46 and 122 <= r[3] <= 154 for r in data["places"]))
        self.assertIn("Q845945", data["query"])
        self.assertIn("P576", data["query"])
        for accept in ("gzip", "gzip;q=0"):
            status, headers, body = self.get("/static/" + path.name, {"Accept-Encoding": accept})
            self.assertEqual(status, 200)
            self.assertIn("immutable", headers["Cache-Control"])
            self.assertEqual(gzip.decompress(body) if accept == "gzip" else body, content)
            self.assertEqual(headers.get("Content-Encoding"), "gzip" if accept == "gzip" else None)

    def test_discovery_parts_keep_provenance_unique_records_and_compression(self):
        for source, expected, license_name in (("wikidata", 5132, "CC0 1.0"), ("geonames", 50764, "CC BY 4.0")):
            root = Path(app.ROOT) / f"static/discovery-{source}-jp-2026-11-13-v1"
            manifest = json.loads((root / "index.json").read_bytes())
            self.assertEqual(sum(p["count"] for p in manifest["parts"]), expected)
            self.assertEqual(manifest["license"], license_name)
            for part in manifest["parts"]:
                raw = (root / part["file"]).read_bytes()
                compressed = (root / (part["file"] + ".gz")).read_bytes()
                data = json.loads(raw)
                self.assertEqual(hashlib.sha256(raw).hexdigest(), part["sha256"])
                self.assertEqual(gzip.decompress(compressed), raw)
                self.assertEqual(len(raw), part["bytes"])
                self.assertEqual(len(compressed), part["gzipBytes"])
                self.assertEqual(data["kind"], part["kind"])
                self.assertEqual(data["license"], license_name)
                self.assertTrue(data["sources"])
                self.assertEqual(len(data["places"]), part["count"])
                self.assertEqual(len({r[0] for r in data["places"]}), part["count"])
                self.assertTrue(all(len(r) == 6 and r[1] and 20 <= r[2] <= 46 and 122 <= r[3] <= 154
                                    and (r[5] is None or -12000 <= r[5] <= 10000) for r in data["places"]))
            for filename in ("index.json", "park.json"):
                status, headers, body = self.get(f"/static/{root.name}/{filename}", {"Accept-Encoding": "gzip"})
                self.assertEqual(status, 200)
                self.assertEqual(headers["Content-Encoding"], "gzip")
                self.assertIn("immutable", headers["Cache-Control"])
                self.assertEqual(gzip.decompress(body), (root / filename).read_bytes())
            status, headers, raw = self.get(f"/static/{root.name}/park.json", {"Accept-Encoding": "gzip;q=0"})
            self.assertEqual(status, 200)
            self.assertNotIn("Content-Encoding", headers)
            self.assertEqual(raw, (root / "park.json").read_bytes())

    def test_compressed_public_index_has_same_contents_and_cacheable_versioned_url(self):
        status, headers, body = self.get("/static/stations-jp-2025-v1.json", {"Accept-Encoding": "gzip, deflate"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Encoding"], "gzip")
        self.assertIn("immutable", headers["Cache-Control"])
        self.assertIn("Accept-Encoding", headers["Vary"])
        raw = (Path(app.ROOT) / "static" / "stations-jp-2025-v1.json").read_bytes()
        self.assertEqual(json.loads(gzip.decompress(body)), json.loads(raw))
        self.assertLess(len(body), len(raw) / 3)
        data = json.loads(raw)
        self.assertEqual(data["referenceDate"], "2025-12-31")
        self.assertEqual(data["license"], "CC BY 4.0")
        self.assertGreater(len(data["stations"]), 9000)

    def test_identity_clients_and_gzip_opt_out_remain_supported(self):
        for encoding in ("identity", "gzip;q=0", "gzip;q=0.000"):
            with self.subTest(encoding=encoding):
                status, headers, body = self.get("/static/stations-jp-2025-v1.json", {"Accept-Encoding": encoding})
                self.assertEqual(status, 200)
                self.assertNotIn("Content-Encoding", headers)
                self.assertEqual(json.loads(body)["version"], 1)

    def test_bus_index_and_prefecture_files_are_compressed_and_keep_source_metadata(self):
        for name in ("index", "11", "13"):
            path = f"/static/bus-stops-jp-2022-v1/{name}.json"
            status, headers, body = self.get(path, {"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertIn("immutable", headers["Cache-Control"])
            self.assertIn("Accept-Encoding", headers["Vary"])
            original = (Path(app.ROOT) / path.lstrip("/")).read_bytes()
            self.assertEqual(gzip.decompress(body), original)
            data = json.loads(original)
            self.assertEqual(data["referenceYear"], 2022)
            if name == "index":
                self.assertEqual(len(data["parts"]), 47)
                self.assertEqual(data["sourceFeatureCount"], 278515)
                self.assertEqual(data["license"], "CC BY 4.0")
                self.assertTrue(data["modified"])
            else:
                self.assertEqual(data["prefecture"], name)
                self.assertGreater(len(data["stops"]), 9000)

    def test_bus_files_support_identity(self):
        status, headers, body = self.get("/static/bus-stops-jp-2022-v1/index.json", {"Accept-Encoding": "gzip;q=0"})
        self.assertEqual(status, 200)
        self.assertNotIn("Content-Encoding", headers)
        self.assertEqual(json.loads(body)["referenceYear"], 2022)

    def test_all_bus_prefectures_match_manifest_and_compressed_copies(self):
        root = Path(app.ROOT) / "static/bus-stops-jp-2022-v1"
        manifest = json.loads((root / "index.json").read_bytes())
        total = 0
        for part in manifest["parts"]:
            raw = (root / part["file"]).read_bytes()
            self.assertEqual(gzip.decompress((root / (part["file"] + ".gz")).read_bytes()), raw)
            data = json.loads(raw)
            self.assertEqual(data["prefecture"] + ".json", part["file"])
            self.assertEqual(len(data["stops"]), part["count"])
            self.assertEqual(len(raw), part["bytes"])
            self.assertTrue(all(len(r) == 5 and r[0] and -90 <= r[1] <= 90 and -180 <= r[2] <= 180 for r in data["stops"]))
            total += len(data["stops"])
        self.assertEqual(total, 278515)

    def test_facility_toilets_are_compressed_with_hours_and_transport_exclusions(self):
        status, headers, body = self.get("/static/toilets-tokyo-2024-v1.json", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Encoding"], "gzip")
        self.assertIn("immutable", headers["Cache-Control"])
        raw = (Path(app.ROOT) / "static/toilets-tokyo-2024-v1.json").read_bytes()
        self.assertEqual(gzip.decompress(body), raw)
        data = json.loads(raw)
        self.assertEqual(data["sourceFacilityCount"], 5692)
        self.assertEqual(data["excluded"]["transportFacility"], 698)
        self.assertEqual(data["excluded"]["invalidCoordinates"], 137)
        self.assertEqual(len(data["places"]), 4857)
        self.assertEqual(data["license"], "CC BY 4.0")
        self.assertTrue(all(len(r) == 7 and -90 <= r[2] <= 90 and -180 <= r[3] <= 180 for r in data["places"]))


    def test_unversioned_assets_keep_revalidation(self):
        status, headers, body = self.get("/static/route-access.json", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertNotIn("Content-Encoding", headers)
        self.assertEqual(json.loads(body)["version"], 1)


if __name__ == "__main__":
    unittest.main()
