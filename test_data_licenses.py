"""Bundled-data provenance and public notice delivery, without external APIs."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
import unittest
from urllib.parse import urlsplit

import app


class DataLicensesTest(unittest.TestCase):
    def test_all_bundled_geodata_has_reusable_source_and_license(self):
        root = Path(app.ROOT) / "static"
        registry = json.loads((root / "data-licenses.json").read_text(encoding="utf-8"))
        files = {file for item in registry["datasets"] for file in item["files"]}
        actual = {p.name for p in root.glob("*.json")} - {"data-licenses.json"}
        self.assertEqual(actual, files - {"stations-jp-2025-v1.json.gz"})
        for item in registry["datasets"]:
            with self.subTest(dataset=item["id"]):
                for key in ("provider", "sourceUrl", "license", "licenseUrl", "modified", "attribution"):
                    self.assertTrue(item[key])
                self.assertEqual(urlsplit(item["sourceUrl"]).scheme, "https")
                self.assertEqual(urlsplit(item["licenseUrl"]).scheme, "https")
                for file in item["files"]:
                    self.assertTrue((root / file).is_file())

    def test_seasonal_rows_retain_verifiable_classification_and_coordinates(self):
        data = json.loads((Path(app.ROOT) / "static/seasonal-places.json").read_text(encoding="utf-8"))
        self.assertIn("CC BY-SA 4.0", data["license"])
        self.assertIn("contributors", data["authors"])
        self.assertIn("編集", data["modified"])
        self.assertNotIn("tokyo_autumn", data["sources"])
        self.assertEqual(len(data["places"]), 131)
        for row in data["places"]:
            self.assertTrue(row["sources"])
            self.assertTrue(set(row["sources"]) <= {"cherry_list", "autumn_list"})
            self.assertTrue(set(row["seasons"]) <= {"cherry_blossom", "autumn_leaves"})
            self.assertIn(urlsplit(row["coordinateSource"]).hostname, {"ja.wikipedia.org", "www.wikidata.org"})
            self.assertTrue(-90 <= row["lat"] <= 90 and -180 <= row["lng"] <= 180)

    def test_osm_derivative_is_offered_with_its_own_license(self):
        data = json.loads((Path(app.ROOT) / "static/route-access.json").read_text(encoding="utf-8"))
        self.assertIn("ODbL", data["license"])
        self.assertIn("OpenStreetMap contributors", data["attribution"])
        self.assertTrue(data["modified"])

    def test_original_material_files_are_not_required_by_public_app(self):
        root = Path(app.ROOT)
        public = "\n".join((root / file).read_text(encoding="utf-8") for file in (
            "index.html", "templates/index.html", "static/css/style.css", "static/js/app.js"))
        self.assertNotIn("search_simple.png", public)
        self.assertNotIn("地図マーカーのアイコン素材4.png", public)


class NoticeDeliveryTest(unittest.TestCase):
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

    def get(self, path):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_notice_links_and_machine_readable_derivative_are_public(self):
        for path in ("/README.md", "/THIRD_PARTY_NOTICES.md", "/DATA_RESEARCH.md",
                     "/static/data-sources.html", "/static/data-licenses.json", "/static/route-access.json"):
            with self.subTest(path=path):
                status, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertTrue(body)
                body.decode("utf-8")
        self.assertNotIn(b'walking-map-api', self.get("/static/data-sources.html")[1])
        self.assertIn(b'walking-map-api', self.get("/")[1])

    def test_notice_allowlist_does_not_expose_source_or_private_files(self):
        for path in ("/.env", "/.git/config", "/app.py", "/static/%2e%2e/app.py", "/static/../.env"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)


if __name__ == "__main__":
    unittest.main()
