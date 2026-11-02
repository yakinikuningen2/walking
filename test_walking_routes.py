import json
import os
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
import unittest
from unittest.mock import MagicMock, patch

import requests
import app
import walking_routes as routes

START = {"lat": 35.68, "lng": 139.76}
END = {"lat": 35.69, "lng": 139.77}
KEY = "test-only-secret-never-returned"


def ors_response(points, *_args, **_kwargs):
    return {"features": [{"geometry": {"type": "LineString", "coordinates": [[p["lng"], p["lat"]] for p in points]},
                          "properties": {"summary": {"distance": 1000 * (len(points) - 1)},
                                         "way_points": list(range(len(points))),
                                         "segments": [{"steps": [{"type": 11, "distance": 1000}, {"type": 10, "distance": 0}]}
                                                      for _ in points[1:]]}}], "metadata": {"api_key": KEY}}


def map_response(*_args):
    return {"elements": [{"type": "node", "lat": 35.684, "lon": 139.769,
                          "tags": {"tourism": "viewpoint", "name:ja": "丘の展望地点"}}]}


class WalkingRoutesTest(unittest.TestCase):
    def test_public_origin_is_explicit_https_only(self):
        with patch.dict(os.environ, {"WALKING_PUBLIC_ORIGIN": "https://walking.example"}):
            self.assertTrue(app.allowed_origin("https://walking.example"))
            self.assertTrue(app.allowed_origin("https://walking.example:443"))
            self.assertTrue(app.allowed_origin("http://localhost:5500"))
            for origin in ["https://untrusted.example", "http://walking.example", "https://walking.example.evil.test",
                           "https://walking.example:444", "https://user@walking.example", "null"]:
                self.assertFalse(app.allowed_origin(origin))
        with patch.dict(os.environ, {"WALKING_PUBLIC_ORIGIN": ""}):
            self.assertFalse(app.allowed_origin("https://walking.example"))

    def setUp(self):
        routes._CACHE.clear()
        self.environment = patch.dict(os.environ, {"ORS_API_KEY": KEY})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()

    def payload(self, mode="scenic", speed=4):
        return {"start": START, "destination": END, "mode": mode, "speed_kmh": speed}

    def test_missing_key_and_client_supplied_key(self):
        with patch.dict(os.environ, {"ORS_API_KEY": ""}), patch.object(routes, "_request_ors") as upstream:
            with self.assertRaises(routes.RouteError) as error:
                routes.walking_suggestions({**self.payload(), "ORS_API_KEY": "client-key"}, map_response)
            self.assertEqual(error.exception.code, "ORS_NOT_CONFIGURED")
            upstream.assert_not_called()

    def test_invalid_input_before_network(self):
        cases = [None, [], {}, {**self.payload(), "start": {"lat": True, "lng": 139}},
                 {**self.payload(), "destination": {"lat": float("nan"), "lng": 139}},
                 {**self.payload(), "mode": "driving-car"}, self.payload(speed=7), {**self.payload(), "destination": START}]
        with patch.object(routes, "_request_ors") as upstream:
            for payload in cases:
                with self.subTest(payload=payload), self.assertRaises(routes.RouteError):
                    routes.walking_suggestions(payload, map_response)
            upstream.assert_not_called()

    @patch.object(routes, "_request_ors", side_effect=ors_response)
    def test_scenic_waypoint_and_no_secret_metadata(self, upstream):
        result = routes.walking_suggestions(self.payload(), map_response)
        self.assertEqual([r["id"] for r in result["routes"]], ["ors_standard", "scenic"])
        self.assertEqual(len(upstream.call_args_list[1].args[0]), 3)
        self.assertIn("丘の展望地点", result["routes"][1]["detail"])
        self.assertNotIn(KEY, json.dumps(result))
        self.assertEqual(result["routes"][1]["route"]["legs"][-1]["steps"][-1]["instruction"], "目的地に到着")

    @patch.object(routes, "_request_ors", side_effect=ors_response)
    def test_roundtrip_includes_destination_and_original_start(self, upstream):
        result = routes.walking_suggestions(self.payload("roundtrip"), map_response)
        for call in upstream.call_args_list:
            points = call.args[0]
            self.assertEqual(points[0], START)
            self.assertEqual(points[1], END)
            self.assertEqual(points[-1], START)
        for choice in result["routes"]:
            route = choice["route"]
            self.assertEqual(route["geometry"]["coordinates"][0], route["geometry"]["coordinates"][-1])
            self.assertEqual(route["legs"][0]["steps"][-1]["instruction"], "目的地に到着")
            self.assertEqual(route["legs"][-1]["steps"][-1]["instruction"], "出発地点に戻る")

    @patch.object(routes, "_request_ors", side_effect=ors_response)
    def test_roundtrip_reroutes_from_current_position_to_original_start(self, upstream):
        current = {"lat": 35.684, "lng": 139.765}
        payload = {**self.payload("roundtrip"), "start": current, "return_to": START}
        routes.walking_suggestions(payload, map_response)
        for call in upstream.call_args_list:
            self.assertEqual(call.args[0][0], current)
            self.assertEqual(call.args[0][1], END)
            self.assertEqual(call.args[0][-1], START)
        upstream.reset_mock()
        result = routes.walking_suggestions({**payload, "destination_reached": True}, map_response)
        self.assertEqual(result["return_to"], START)
        self.assertTrue(result["destination_reached"])
        for call in upstream.call_args_list:
            self.assertEqual(call.args[0][0], current)
            self.assertEqual(call.args[0][-1], START)
            self.assertNotIn(END, call.args[0])
        self.assertEqual(result["routes"][0]["route"]["legs"][-1]["steps"][-1]["instruction"], "出発地点に戻る")
        self.assertEqual(result["routes"][1]["route"]["legs"][0]["steps"][-1]["instruction"], "経由地点に到着")

    @patch.object(routes, "_request_ors", side_effect=ors_response)
    def test_roundtrip_cache_separates_return_points_and_validates_state(self, upstream):
        current = {"lat": 35.684, "lng": 139.765}
        payload = {**self.payload("roundtrip"), "start": current, "return_to": START}
        routes.walking_suggestions(payload, map_response)
        routes.walking_suggestions({**payload, "return_to": {"lat": 35.67, "lng": 139.75}}, map_response)
        self.assertEqual(upstream.call_count, 4)
        upstream.reset_mock()
        for change in [{"return_to": None}, {"destination_reached": "true"}]:
            with self.assertRaises(routes.RouteError):
                routes.walking_suggestions({**payload, **change}, map_response)
        upstream.assert_not_called()

    @patch.object(routes, "_request_ors", side_effect=ors_response)
    def test_speed_and_cache(self, upstream):
        slow = routes.walking_suggestions(self.payload(speed=3), map_response)
        routes.walking_suggestions(self.payload(speed=3), map_response)
        self.assertEqual(upstream.call_count, 2)
        fast = routes.walking_suggestions(self.payload(speed=6), map_response)
        self.assertEqual(slow["routes"][0]["route"]["duration"], fast["routes"][0]["route"]["duration"] * 2)

    def test_optional_failure_preserves_base_and_is_not_cached(self):
        with patch.object(routes, "_request_ors", side_effect=[ors_response([START, END]), routes.RouteError("ORS_TIMEOUT", "timeout", 504)]):
            result = routes.walking_suggestions(self.payload(), map_response)
        self.assertEqual(len(result["routes"]), 1)
        self.assertEqual(result["warnings"], ["timeout"])
        self.assertFalse(routes._CACHE)

    @patch.object(routes, "_request_ors", side_effect=ors_response)
    def test_map_failure_still_returns_weighted_route(self, upstream):
        def failed_map(*args):
            raise requests.Timeout()
        result = routes.walking_suggestions(self.payload(), failed_map)
        self.assertEqual(len(result["routes"]), 2)
        self.assertTrue(result["warnings"])
        self.assertTrue(upstream.call_args.kwargs["green"])

    def test_invalid_geometry_and_unsnapped_waypoint(self):
        for bad in [{}, {"features": []}, ors_response([START, {"lat": 40, "lng": 130}])]:
            with self.subTest(bad=bad), self.assertRaises(routes.RouteError):
                routes.normalized_route(bad, [START, END], 4)

    def test_fixed_endpoint_and_authorization_header_only(self):
        session = MagicMock()
        response = session.post.return_value.__enter__.return_value
        response.status_code = 200
        response.json.return_value = ors_response([START, END])
        with patch.object(routes._LOCAL, "session", session, create=True):
            routes._request_ors([START, END], KEY, green=True)
        args, kwargs = session.post.call_args
        self.assertEqual(args[0], routes.ORS_ENDPOINT)
        self.assertEqual(kwargs["headers"]["Authorization"], KEY)
        self.assertNotIn(KEY, json.dumps(kwargs["json"]))
        self.assertEqual(kwargs["json"]["coordinates"], [[139.76, 35.68], [139.77, 35.69]])
        self.assertFalse(kwargs["allow_redirects"])

    def test_upstream_errors_do_not_disclose_key(self):
        for status, code in [(401, "ORS_AUTH_FAILED"), (403, "ORS_AUTH_FAILED"), (429, "ORS_RATE_LIMIT"), (422, "ORS_NO_ROUTE"), (503, "ORS_UNAVAILABLE")]:
            session = MagicMock()
            session.post.return_value.__enter__.return_value.status_code = status
            with self.subTest(status=status), patch.object(routes._LOCAL, "session", session, create=True), self.assertRaises(routes.RouteError) as error:
                routes._request_ors([START, END], KEY)
            self.assertEqual(error.exception.code, code)
            self.assertNotIn(KEY, error.exception.message)
        session = MagicMock()
        session.post.side_effect = requests.Timeout(KEY)
        with patch.object(routes._LOCAL, "session", session, create=True), self.assertRaises(routes.RouteError) as error:
            routes._request_ors([START, END], KEY)
        self.assertEqual(error.exception.code, "ORS_TIMEOUT")

    def test_http_endpoint_and_existing_health(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.WalkingHandler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(routes, "_request_ors", side_effect=ors_response), patch.object(app, "map_data", side_effect=map_response):
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/api/walking-routes", json.dumps(self.payload("roundtrip")), {"Content-Type": "application/json", "Origin": "http://localhost:5500"})
                response = connection.getresponse()
                body = response.read().decode()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "http://localhost:5500")
                self.assertNotIn(KEY, body)
                connection.close()
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("GET", "/api/health")
                response = connection.getresponse()
                self.assertEqual(json.loads(response.read())["service"], "walking-map")
                connection.close()
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("POST", "/api/walking-routes", headers={"Origin": "https://untrusted.example"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
