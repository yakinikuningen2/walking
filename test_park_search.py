import json
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
import unittest
from unittest.mock import MagicMock, patch

import requests

import app


PAYLOAD = {"bbox": [139.490919, 35.553385, 139.773081, 35.782615], "lat": 35.668, "lon": 139.752}
DATA = {"features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [139.75, 35.67]},
                      "properties": {"osm_type": "W", "osm_id": 1, "osm_key": "leisure", "osm_value": "park", "name": "公園"}}]}


class ParkSearchTest(unittest.TestCase):
    def setUp(self):
        app._PARK_CACHE.clear()

    def session(self, status=200, data=DATA):
        session = MagicMock()
        response = session.get.return_value.__enter__.return_value
        response.status_code = status
        response.json.return_value = data
        return session

    def test_fixed_public_endpoint_category_and_rounded_coordinates(self):
        session = self.session()
        with patch.object(app._SESSIONS, "session", session, create=True):
            result = app.park_data({**PAYLOAD, "lat": 35.668123, "lon": 139.752123})
        self.assertEqual(result, DATA)
        args, kwargs = session.get.call_args
        self.assertEqual(args[0], "https://photon.komoot.io/api/")
        self.assertEqual(kwargs["params"]["include"], "osm.leisure.park,osm.leisure.garden,osm.leisure.nature_reserve")
        self.assertEqual(kwargs["params"]["lat"], "35.668")
        self.assertEqual(kwargs["params"]["lon"], "139.752")
        self.assertEqual(kwargs["timeout"], (3, 5))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertNotIn("Authorization", kwargs)

    def test_cache_and_expiry(self):
        session = self.session()
        with patch.object(app._SESSIONS, "session", session, create=True), patch.object(app.time, "monotonic", return_value=100):
            app.park_data(PAYLOAD)
            app.park_data(PAYLOAD)
            self.assertEqual(session.get.call_count, 1)
        with patch.object(app._SESSIONS, "session", session, create=True), patch.object(app.time, "monotonic", return_value=701):
            app.park_data(PAYLOAD)
        self.assertEqual(session.get.call_count, 2)

    def test_invalid_input_and_arbitrary_destinations_rejected_before_network(self):
        cases = [None, [], {}, {**PAYLOAD, "url": "http://127.0.0.1/"},
                 {**PAYLOAD, "include": "other.category"}, {**PAYLOAD, "lat": True},
                 {**PAYLOAD, "lon": float("nan")}, {**PAYLOAD, "bbox": [0, 0, 100, 80]},
                 {**PAYLOAD, "bbox": "139,35,140,36"}, {**PAYLOAD, "lat": 50},
                 {**PAYLOAD, "bbox": [140, 35, 139, 36]}]
        session = self.session()
        with patch.object(app._SESSIONS, "session", session, create=True):
            for payload in cases:
                with self.subTest(payload=payload), self.assertRaises(app.RouteError) as error:
                    app.park_data(payload)
                self.assertEqual(error.exception.status, 400)
        session.get.assert_not_called()

    def test_upstream_errors_and_invalid_data_are_not_cached(self):
        for status, data, expected in [(429, {}, "ParkBusy"), (503, {}, "ParkUnavailable"),
                                        (302, {}, "ParkUnavailable"), (200, {}, "ParkUnavailable"),
                                        (200, {"features": "invalid"}, "ParkUnavailable")]:
            with self.subTest(status=status, data=data), patch.object(app._SESSIONS, "session", self.session(status, data), create=True), \
                 self.assertRaises(app.RouteError) as error:
                app.park_data(PAYLOAD)
            self.assertEqual(error.exception.code, expected)
            self.assertFalse(app._PARK_CACHE)
        session = self.session()
        session.get.side_effect = requests.Timeout("internal details")
        with patch.object(app._SESSIONS, "session", session, create=True), self.assertRaises(app.RouteError) as error:
            app.park_data(PAYLOAD)
        self.assertEqual(error.exception.code, "ParkTimeout")
        self.assertNotIn("internal details", error.exception.message)

    def test_http_api_and_origin_checks(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.WalkingHandler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(app._SESSIONS, "session", self.session(), create=True), \
                 patch.object(app, "park_data", return_value=DATA) as upstream:
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/api/parks", json.dumps(PAYLOAD),
                                   {"Content-Type": "application/json", "Origin": "http://localhost:5500"})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("X-Walking-Map"), "1")
                self.assertEqual(json.loads(response.read()), DATA)
                connection.close()
                upstream.assert_called_once_with(PAYLOAD)
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                # Origin rejection happens before reading the body. Do not send an unread body
                # that would reset the socket on Windows when this rejected connection closes.
                connection.request("POST", "/api/parks", headers={"Origin": "https://untrusted.example"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                connection.close()
                self.assertEqual(upstream.call_count, 1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
