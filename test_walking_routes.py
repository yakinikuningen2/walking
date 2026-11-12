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
    def test_paid_station_passage_is_retried_and_never_returned_if_provider_ignores_avoidance(self):
        start = {"lat": 35.77859, "lng": 139.496533}
        end = {"lat": 35.778435, "lng": 139.496471}
        blocked = ors_response([start, end])
        outside = ors_response([start, end])
        outside["features"][0]["geometry"]["coordinates"].insert(1, [139.4987, 35.7781])
        outside["features"][0]["properties"]["way_points"] = [0, 2]
        self.assertTrue(routes.crosses_paid_area(blocked["features"][0]["geometry"]["coordinates"]))
        self.assertFalse(routes.crosses_paid_area(outside["features"][0]["geometry"]["coordinates"]))
        with patch.object(routes, "_request_ors", side_effect=[blocked, outside]) as upstream:
            safe = routes._public_ors([start, end], KEY)
            self.assertEqual(upstream.call_count, 2)
            self.assertTrue(upstream.call_args.kwargs["avoid_paid"])
            routes.normalized_route(safe, [start, end], 4)
        with patch.object(routes, "_request_ors", return_value=blocked):
            with self.assertRaises(routes.RouteError) as error:
                routes.normalized_route(routes._public_ors([start, end], KEY), [start, end], 4)
            self.assertEqual(error.exception.code, "PAID_AREA_ROUTE")

    def test_paid_area_avoidance_preserves_green_options_and_keeps_credentials_out_of_body(self):
        session = MagicMock()
        response = session.post.return_value.__enter__.return_value
        response.status_code = 200
        response.json.return_value = ors_response([START, END])
        with patch.object(routes._LOCAL, "session", session, create=True):
            routes._request_ors([START, END], KEY, green=True, avoid_paid=True)
        body = session.post.call_args.kwargs["json"]
        self.assertEqual(body["options"]["avoid_polygons"]["coordinates"], [[ring] for ring in routes.paid_area_rings()])
        self.assertIn("profile_params", body["options"])
        self.assertNotIn(KEY, json.dumps(body))

    def test_local_binding_and_cli_override(self):
        with patch.dict(os.environ, {}, clear=True):
            options = app.server_options([])
            self.assertEqual((options.host, options.port), ("127.0.0.1", 8000))
            options = app.server_options(["--host", "0.0.0.0", "--port", "8123"])
            self.assertEqual((options.host, options.port), ("0.0.0.0", 8123))
        with patch.dict(os.environ, {"PORT": "10000"}, clear=True):
            options = app.server_options([])
            self.assertEqual((options.host, options.port), ("127.0.0.1", 10000))
            self.assertEqual(app.server_options(["--port", "8123"]).port, 8123)

    def test_render_forces_public_host_and_environment_port(self):
        markers = [{"RENDER": value} for value in ("true", "True", " TRUE ", "1")]
        markers += [{"RENDER_SERVICE_ID": "srv-test"},
                    {"RENDER_EXTERNAL_URL": "https://walking-test.onrender.com"},
                    {"RENDER_EXTERNAL_HOSTNAME": "walking-test.onrender.com"},
                    {"RENDER": "false", "RENDER_SERVICE_ID": "srv-test"}]
        for marker in markers:
            with self.subTest(marker=marker), patch.dict(os.environ, {**marker, "PORT": "10000"}, clear=True):
                for argv in ([], ["--host", "127.0.0.1", "--port", "8123"]):
                    options = app.server_options(argv)
                    self.assertEqual((options.host, options.port), ("0.0.0.0", 10000))
        with patch.dict(os.environ, {"RENDER": "true"}, clear=True):
            self.assertEqual(app.server_options([]).port, 10000)

    def test_invalid_render_port_fails_instead_of_using_cli_port(self):
        for port in ("not-a-port", "0", "65536"):
            with self.subTest(port=port), patch.dict(os.environ, {"RENDER": "true", "PORT": port}, clear=True), patch("sys.stderr"):
                with self.assertRaises(SystemExit) as error:
                    app.server_options(["--port", "8123"])
                self.assertEqual(error.exception.code, 2)

    def test_main_binds_to_selected_public_address(self):
        with patch.dict(os.environ, {"RENDER": "true", "PORT": "10000"}, clear=True):
            options = app.server_options(["--host", "127.0.0.1"])
        server = MagicMock()
        server.server_port = 10000
        server.serve_forever.side_effect = KeyboardInterrupt()
        with patch.object(app, "server_options", return_value=options), \
             patch.object(app, "WalkingServer", return_value=server) as factory, patch("builtins.print"):
            app.main()
        factory.assert_called_once_with(("0.0.0.0", 10000), app.WalkingHandler)
        server.server_close.assert_called_once()

    def test_server_bind_failure_reports_original_error(self):
        options = app.server_options(["--host", "127.0.0.1", "--port", "8123"])
        with patch.object(app, "server_options", return_value=options), \
             patch.object(app, "WalkingServer", side_effect=OSError("port already in use")):
            with self.assertRaises(SystemExit) as error:
                app.main()
        self.assertIn("port already in use", str(error.exception.code))

    def test_render_public_origin_and_custom_domain_override(self):
        with patch.dict(os.environ, {"WALKING_PUBLIC_ORIGIN": "", "RENDER_EXTERNAL_URL": "https://walking-test.onrender.com"}):
            self.assertTrue(app.allowed_origin("https://walking-test.onrender.com"))
            self.assertFalse(app.allowed_origin("https://another-app.onrender.com"))
            self.assertFalse(app.allowed_origin("http://walking-test.onrender.com"))
            with patch.dict(os.environ, {"WALKING_PUBLIC_ORIGIN": "https://walk.example"}):
                self.assertTrue(app.allowed_origin("https://walk.example"))
                self.assertFalse(app.allowed_origin("https://walking-test.onrender.com"))

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

    def test_long_route_requires_server_key_and_ignores_client_key(self):
        with patch.dict(os.environ, {"ORS_API_KEY": ""}), patch.object(routes, "_request_ors") as upstream:
            with self.assertRaises(routes.RouteError) as error:
                routes.walking_suggestions({**self.payload("standard"), "ORS_API_KEY": KEY}, map_response)
            self.assertEqual(error.exception.code, "ORS_NOT_CONFIGURED")
            self.assertIn("距離上限", error.exception.message)
            upstream.assert_not_called()

    def test_long_route_uses_one_foot_request_without_scenic_search(self):
        start = {"lat": 35.7787, "lng": 139.4966}
        end = {"lat": 34.3974, "lng": 132.4753}
        payload = {**self.payload("standard"), "start": start, "destination": end}
        data = ors_response([start, end])
        data["features"][0]["properties"]["summary"]["distance"] = 900000
        with patch.object(routes, "_request_ors", return_value=data) as upstream, \
             patch.object(routes, "scenic_point") as scenic:
            result = routes.walking_suggestions(payload, map_response)
            self.assertEqual(routes.walking_suggestions(payload, map_response), result)
            upstream.assert_called_once_with([start, end], KEY, long_route=True)
            scenic.assert_not_called()
        self.assertEqual([r["id"] for r in result["routes"]], ["ors_standard"])
        route = result["routes"][0]["route"]
        self.assertEqual(route["distance"], 900000)
        self.assertAlmostEqual(route["duration"], 900000 / (4 / 3.6))
        self.assertEqual(route["legs"][-1]["steps"][-1]["instruction"], "目的地に到着")
        self.assertEqual(result["warnings"], [])
        self.assertNotIn(KEY, json.dumps(result))

    def test_long_route_request_uses_recommended_profile_and_longer_timeout(self):
        session = MagicMock()
        response = session.post.return_value.__enter__.return_value
        response.status_code = 200
        response.json.return_value = ors_response([START, END])
        with patch.object(routes._LOCAL, "session", session, create=True):
            routes._request_ors([START, END], KEY, long_route=True)
        args, kwargs = session.post.call_args
        self.assertEqual(args[0], routes.ORS_ENDPOINT)
        self.assertEqual(kwargs["json"]["preference"], "recommended")
        self.assertNotIn("options", kwargs["json"])
        self.assertEqual(kwargs["timeout"], (5, 60))
        self.assertEqual(kwargs["headers"]["Authorization"], KEY)
        self.assertNotIn(KEY, json.dumps(kwargs["json"]))

    def test_ors_limits_have_safe_distinct_errors(self):
        for status, code, expected in [(400, 2004, "ORS_LIMIT_EXCEEDED"), (500, 2017, "ORS_COMPUTATION_LIMIT"),
                                       (404, 2009, "ORS_NO_ROUTE")]:
            session = MagicMock()
            response = session.post.return_value.__enter__.return_value
            response.status_code = status
            response.json.return_value = {"error": {"code": code, "message": KEY}}
            with self.subTest(code=code), patch.object(routes._LOCAL, "session", session, create=True), \
                 self.assertRaises(routes.RouteError) as error:
                routes._request_ors([START, END], KEY, long_route=True)
            self.assertEqual(error.exception.code, expected)
            self.assertNotIn(KEY, error.exception.message)

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
