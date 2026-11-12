import gzip
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

    def test_unversioned_assets_keep_revalidation(self):
        status, headers, body = self.get("/static/route-access.json", {"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertNotIn("Content-Encoding", headers)
        self.assertEqual(json.loads(body)["version"], 1)


if __name__ == "__main__":
    unittest.main()
