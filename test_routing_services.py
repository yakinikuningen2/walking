"""Shared routing limits, privacy-safe relay and HTTP delivery; no live API calls."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Event, Thread
from unittest.mock import MagicMock, patch
import copy
import json
import time
import unittest

import requests
import app
import valhalla_service as service
from api_limits import ApiLimitError, RequestGate
from walking_routes import RouteError

PARAMS = {"locations": [{"lat": 35.681236123, "lon": 139.767125456}, {"lat": 35.675, "lon": 139.76332}],
          "costing": "pedestrian", "format": "osrm", "shape_format": "geojson", "exclude_polygons": [],
          "directions_options": {"language": "ja-JP", "units": "kilometers"},
          "costing_options": {"pedestrian": {"walking_speed": 4, "use_hills": .5, "step_penalty": 30}}}


def payload():
    return {"action": "route", "params": copy.deepcopy(PARAMS), "timeout_ms": 18000}


class LimitTest(unittest.TestCase):
    def test_concurrent_users_share_one_slot_and_minimum_interval(self):
        gate = RequestGate(interval=.02, minute=100, daily=100, wait=1)
        starts, active, highest = [], 0, 0
        def call():
            nonlocal active, highest
            with gate.slot():
                starts.append(time.monotonic()); active += 1; highest = max(highest, active)
                time.sleep(.03); active -= 1
        with ThreadPoolExecutor(3) as pool:
            list(pool.map(lambda _: call(), range(3)))
        self.assertEqual(highest, 1)
        self.assertTrue(all(b-a >= .019 for a, b in zip(starts, starts[1:])))

    def test_minute_and_rolling_day_budgets_include_all_callers_and_expire(self):
        now = [100000.0]
        gate = RequestGate(interval=0, minute=2, daily=3, clock=lambda: now[0])
        for _ in range(2):
            with gate.slot(): pass
        with self.assertRaises(ApiLimitError) as limited:
            with gate.slot(): self.fail("must not call")
        self.assertEqual(limited.exception.retry_after, 60)
        now[0] += 61
        with gate.slot(): pass
        with self.assertRaises(ApiLimitError):
            with gate.slot(): self.fail("daily budget")
        now[0] += 86401
        with gate.slot(): pass

    def test_cooldown_blocks_requests_without_waiting_or_retries(self):
        now = [100.0]; gate = RequestGate(clock=lambda: now[0])
        gate.cooldown("120")
        with self.assertRaises(ApiLimitError) as limited:
            with gate.slot(): self.fail("cooldown")
        self.assertEqual(limited.exception.retry_after, 120)
        gate.cooldown("7200")
        with self.assertRaises(ApiLimitError) as limited:
            with gate.slot(): self.fail("long Retry-After must be honored")
        self.assertEqual(limited.exception.retry_after, 7200)
        now[0] += 7201
        with gate.slot(): pass

    def test_busy_request_has_bounded_wait_and_does_not_count_as_provider_call(self):
        gate = RequestGate(interval=0, wait=.02)
        with gate.slot():
            started = time.monotonic()
            with self.assertRaises(ApiLimitError):
                with gate.slot(): self.fail("busy")
            self.assertLess(time.monotonic()-started, .5)
        self.assertEqual(len(gate.events), 1)


class RelayTest(unittest.TestCase):
    def setUp(self):
        with service._lock:
            service._cache.clear(); service._jobs.clear(); service._cache_bytes = 0
        self.gate = MagicMock()
        self.gate.slot.side_effect = lambda: nullcontext()
        p = patch.object(service, "VALHALLA_GATE", self.gate); p.start(); self.addCleanup(p.stop)

    def test_validation_rejects_other_services_names_modes_and_unbounded_inputs(self):
        cases = [dict(payload(), action="matrix"), dict(payload(), url="https://evil.test"),
                 dict(payload(), timeout_ms=60001)]
        for mutate in (lambda p: p.update(costing="auto"), lambda p: p["locations"][0].update(name="Private Name"),
                       lambda p: p.update(locations=p["locations"]*26), lambda p: p["locations"][0].update(lat=float("nan")),
                       lambda p: p["costing_options"]["pedestrian"].update(walking_speed=50)):
            p = payload(); mutate(p["params"]); cases.append(p)
        with patch.object(service, "_fetch") as upstream:
            for p in cases:
                with self.subTest(p=p), self.assertRaises(RouteError): service.valhalla_data(p)
            upstream.assert_not_called()

    def test_exact_endpoint_identifier_post_body_and_no_forwarded_browser_identity(self):
        session = MagicMock(); response = session.post.return_value.__enter__.return_value
        response.status_code = 200
        response.iter_content.return_value = [b'{"code":"Ok","routes":[]}']
        with patch.object(service._local, "session", session, create=True):
            service.valhalla_data(payload())
        args, options = session.post.call_args
        self.assertEqual(args[0], "https://valhalla1.openstreetmap.de/route")
        self.assertEqual(options["headers"]["X-Client-Id"], "walking-ctsh.onrender.com")
        self.assertIn("https://walking-ctsh.onrender.com/", options["headers"]["User-Agent"])
        self.assertNotIn("X-Forwarded-For", options["headers"])
        self.assertNotIn("Authorization", options["headers"])
        self.assertNotIn("params", options)
        self.assertEqual(options["json"]["locations"][0]["lat"], 35.681236)
        self.assertFalse(options["allow_redirects"])

    def test_cache_and_duplicate_requests_do_not_consume_additional_slots(self):
        entered, release = Event(), Event()
        def fetch(*_args):
            entered.set(); release.wait(1); return {"code": "Ok"}, 100
        with patch.object(service, "_fetch", side_effect=fetch) as upstream, ThreadPoolExecutor(2) as pool:
            a = pool.submit(service.valhalla_data, payload()); self.assertTrue(entered.wait(1))
            b = pool.submit(service.valhalla_data, payload()); time.sleep(.02); release.set()
            self.assertEqual(a.result(), b.result()); self.assertEqual(service.valhalla_data(payload()), a.result())
            self.assertEqual(upstream.call_count, 1); self.assertEqual(self.gate.slot.call_count, 1)

    def test_cache_expires_and_is_bounded_by_bytes(self):
        with patch.object(service, "_fetch", return_value=({"code": "Ok"}, 100)) as upstream:
            service.valhalla_data(payload())
            with patch.object(service, "TTL", -1): service.valhalla_data(payload())
            self.assertEqual(upstream.call_count, 2)
        with patch.object(service, "CACHE_BYTES", 150), patch.object(service, "_fetch", return_value=({"code": "Ok"}, 100)):
            p = payload(); p["params"]["locations"][0]["lat"] = 36; service.valhalla_data(p)
            self.assertLessEqual(service._cache_bytes, 150)

    def test_errors_keep_machine_codes_but_never_echo_upstream_payload(self):
        session = MagicMock(); response = session.post.return_value.__enter__.return_value
        response.status_code = 400
        response.iter_content.return_value = [b'{"code":"DistanceExceeded","error":"private coordinates or credentials"}']
        with patch.object(service._local, "session", session, create=True), self.assertRaises(RouteError) as error:
            service.valhalla_data(payload())
        self.assertEqual(error.exception.code, "DistanceExceeded")
        self.assertNotIn("private", error.exception.message); self.assertFalse(service._cache)

    def test_upstream_429_enters_cooldown_without_retry(self):
        session = MagicMock(); response = session.post.return_value.__enter__.return_value
        response.status_code = 429; response.headers = {"Retry-After": "120"}
        with patch.object(service._local, "session", session, create=True), self.assertRaises(RouteError) as error:
            service.valhalla_data(payload())
        self.assertEqual(error.exception.status, 429); self.gate.cooldown.assert_called_once_with("120")
        self.assertEqual(session.post.call_count, 1)

    def test_timeout_and_oversized_responses_are_sanitized(self):
        session = MagicMock(); session.post.side_effect = requests.Timeout("hidden")
        with patch.object(service._local, "session", session, create=True), self.assertRaises(RouteError) as error:
            service.valhalla_data(payload())
        self.assertEqual(error.exception.code, "ROUTING_TIMEOUT"); self.assertNotIn("hidden", error.exception.message)
        session = MagicMock(); response = session.post.return_value.__enter__.return_value
        response.status_code = 200; response.iter_content.return_value = [b'x'*50]
        with patch.object(service._local, "session", session, create=True), patch.object(service, "RESPONSE_BYTES", 10), self.assertRaises(RouteError):
            service.valhalla_data(payload())
        self.assertFalse(service._cache)

    def test_locate_and_elevation_are_small_fixed_actions(self):
        for action, params in [("locate", {"locations": PARAMS["locations"], "costing": "pedestrian", "verbose": True}),
                               ("height", {"shape": PARAMS["locations"], "range": False, "height_precision": 0})]:
            with patch.object(service, "_fetch", return_value=([] if action == "locate" else {"height": [1, 2]}, 100)) as upstream:
                service.valhalla_data({"action": action, "params": params})
                self.assertEqual(upstream.call_args.args[0], action)
        with self.assertRaises(RouteError): service.validated({"action": "height", "params": {"shape": PARAMS["locations"]*13}})


class RelayHTTPTest(unittest.TestCase):
    def test_relay_origin_error_retry_after_and_no_private_file_exposure(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.WalkingHandler)
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        def post(origin):
            conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            conn.request("POST", "/api/valhalla", json.dumps(payload()), {"Content-Type": "application/json", "Origin": origin})
            res = conn.getresponse(); result = res.status, res.getheader("Retry-After"), json.loads(res.read()); conn.close(); return result
        try:
            with patch.object(app, "valhalla_data", side_effect=ApiLimitError(retry_after=35)) as upstream:
                code, retry, data = post("http://localhost:5500")
                self.assertEqual((code, retry), (429, "35")); self.assertEqual(data["code"], "ROUTING_RATE_LIMIT")
                self.assertEqual(post("https://evil.example")[0], 403); self.assertEqual(upstream.call_count, 1)
            conn = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            conn.request("GET", "/static/privacy.html"); res = conn.getresponse()
            self.assertEqual(res.status, 200); self.assertIn(b'yakinikuningen', res.read()); conn.close()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == "__main__": unittest.main()
