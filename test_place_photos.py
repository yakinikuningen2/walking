"""Photo identity, licensing, errors and API integration; no live requests."""
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
from threading import Event
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import json
import unittest
import requests
import time

import app
import place_photos as photos


def page(**changes):
    info = {"thumburl": "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Park.jpg/640px-Park.jpg",
            "descriptionurl": "https://commons.wikimedia.org/wiki/File:Park.jpg", "mime": "image/jpeg",
            "extmetadata": {"Artist": {"value": '<a href="https://example.org">Photographer</a>'},
                            "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"}}}
    info.update(changes)
    return {"title": "File:Park.jpg", "imageinfo": [info]}


PLACE = {"name": "日比谷公園", "lat": 35.674, "lng": 139.756, "hints": {}}


class PhotoTests(unittest.TestCase):
    def setUp(self):
        with photos._lock:
            photos._cache.clear()
            photos._cooldown = 0
            photos._next_call = 0
        with photos._api_lock:
            photos._api_cache.clear(); photos._api_bytes = 0

    def resolver(self, hints=None):
        return photos.Resolver({**PLACE, "hints": hints or {}})

    def test_attribution_is_plain_text_and_thumbnail_is_verified(self):
        p = photos.photo_from_page(page())
        self.assertEqual(p["author"], "Photographer")
        self.assertEqual(p["license"], "CC BY-SA 4.0")
        self.assertFalse(p["nearby"])
        self.assertIn("トリミング", p["displayNote"])
        self.assertEqual(photos.plain('<script>alert(1)</script><b>A &amp; B</b>'), 'A & B')

    def test_unknown_nc_or_missing_license_author_and_unsafe_urls_are_rejected(self):
        for changes in ({"extmetadata": {}}, {"thumburl": "https://evil.test/Park.jpg"},
                        {"mime": "image/svg+xml"}, {"descriptionurl": "javascript:alert(1)"},
                        {"extmetadata": {"Artist": {"value": "A"}, "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-nc/4.0/"}}}):
            self.assertIsNone(photos.photo_from_page(page(**changes)))
        p = page()
        p["imageinfo"][0]["extmetadata"]["Restrictions"] = {"value": "Special use restrictions"}
        self.assertIsNone(photos.photo_from_page(p))

    def test_old_cc_license_retains_the_supplied_work_title_without_html_or_silent_truncation(self):
        p = page()
        meta = p["imageinfo"][0]["extmetadata"]
        meta["LicenseUrl"] = {"value": "https://creativecommons.org/licenses/by-sa/2.0/"}
        meta["ObjectName"] = {"value": "<b>Morning &amp; Trees</b>"}
        photo = photos.photo_from_page(p)
        self.assertEqual(photo["title"], "Morning & Trees")
        self.assertEqual(photo["license"], "CC BY-SA 2.0")
        meta["ObjectName"] = {"value": "x" * 2001}
        self.assertIsNone(photos.photo_from_page(p))
        self.assertEqual(photos.photo_from_page(page())["title"], "Park.jpg")

    def test_licensed_maps_and_logos_are_not_counted_as_destination_photos(self):
        p = page(); p["title"] = "File:Japan Kyoto city urban topographic map.webp"
        self.assertIsNone(photos.photo_from_page(p))
        p = page(); p["imageinfo"][0]["extmetadata"]["Categories"] = {"value": "CC-BY-SA-4.0|Maps of Kyoto"}
        self.assertIsNone(photos.photo_from_page(p))
        p = page(); p["title"] = "File:Park - Mapillary (123456).jpg"
        self.assertIsNotNone(photos.photo_from_page(p))

    def test_file_reference_is_fixed_to_commons_and_cannot_be_an_arbitrary_proxy(self):
        self.assertEqual(photos.file_title("File:Park.jpg"), "File:Park.jpg")
        self.assertEqual(photos.file_title("https://upload.wikimedia.org/wikipedia/commons/a/ab/Park.jpg"), "File:Park.jpg")
        for value in ("https://127.0.0.1/private.jpg", "javascript:alert(1)", "Category:Park", "File:X.svg", "File:X.jpg|File:Y.jpg"):
            self.assertIsNone(photos.file_title(value))

    def test_direct_photo_has_priority_and_does_not_call_other_searches(self):
        resolver = self.resolver({"image": "File:Park.jpg", "wikidata": "Q123"})
        with patch.object(resolver, "api", return_value={"query": {"pages": [page()]}}) as api:
            result = resolver.resolve()
        self.assertEqual(result["author"], "Photographer")
        self.assertEqual(api.call_count, 1)
        self.assertEqual(api.call_args.args, ("commons",))

    def test_explicit_commons_photo_with_far_coordinates_is_rejected(self):
        p = page(); p["coordinates"] = [{"lat": 40, "lon": 140}]
        resolver = self.resolver()
        with patch.object(resolver, "api", return_value={"query": {"pages": [p]}}):
            self.assertIsNone(resolver.image("File:Park.jpg"))

    def test_wikidata_matches_coordinates_and_uses_p18_before_wikipedia(self):
        resolver = self.resolver({"wikidata": "Q123"})
        entity = {"entities": {"Q123": {"claims": {
            "P625": [{"mainsnak": {"datavalue": {"value": {"latitude": 35.674, "longitude": 139.756}}}}],
            "P18": [{"mainsnak": {"datavalue": {"value": "Park.jpg"}}}]}}}}
        with patch.object(resolver, "api", return_value=entity), patch.object(resolver, "image", return_value={"matched": True}) as image:
            result = resolver.resolve()
            self.assertTrue(result["matched"])
            self.assertEqual(result["match"]["level"], "high")
        image.assert_called_once_with("Park.jpg")

    def test_far_or_non_earth_wikidata_never_uses_its_facility_photo(self):
        for coord in ({"latitude": 40, "longitude": 140}, {"latitude": 35.674, "longitude": 139.756, "globe": "http://www.wikidata.org/entity/Q405"}):
            resolver = self.resolver({"wikidata": "Q123"})
            entity = {"entities": {"Q123": {"claims": {"P625": [{"mainsnak": {"datavalue": {"value": coord}}}],
                                                        "P18": [{"mainsnak": {"datavalue": {"value": "Wrong.jpg"}}}]}}}}
            with patch.object(resolver, "api", side_effect=lambda site, **kw: entity if kw.get("action") == "wbgetentities" else {"query": {"pages": []}}), patch.object(resolver, "wikipedia", return_value=None), patch.object(resolver, "image") as image:
                self.assertIsNone(resolver.resolve())
            image.assert_not_called()

    def test_wikipedia_same_name_elsewhere_or_nearby_different_place_is_rejected(self):
        for name, coord in ((PLACE["name"], {"lat": 40, "lon": 140}), ("日比谷公園前駅", {"lat": 35.674, "lon": 139.756})):
            p = {"title": name, "coordinates": [coord], "pageimage": "Park.jpg"}
            resolver = self.resolver()
            with patch.object(resolver, "api", return_value={"query": {"pages": [p]}}), patch.object(resolver, "image") as image:
                self.assertIsNone(resolver.wikipedia())
            image.assert_not_called()

    def test_wikipedia_image_is_still_checked_at_commons(self):
        resolver = self.resolver()
        p = {"title": PLACE["name"], "coordinates": [{"lat": 35.674, "lon": 139.756}], "pageimage": "Park.jpg",
             "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Park.jpg"}}
        with patch.object(resolver, "api", return_value={"query": {"pages": [p]}}), patch.object(resolver, "image", return_value=None) as image:
            self.assertIsNone(resolver.wikipedia())
        image.assert_called_once_with("Park.jpg")

    def test_commons_search_requires_near_coordinates_and_labels_surroundings(self):
        p = page(); p["coordinates"] = [{"lat": 35.6741, "lon": 139.756}]
        resolver = self.resolver()
        with patch.object(resolver, "wikipedia", return_value=None), patch.object(resolver, "api", return_value={"query": {"pages": [p]}}) as api:
            self.assertTrue(resolver.resolve()["nearby"])
            self.assertIn("nearcoord:500m", api.call_args.kwargs["gsrsearch"])
        for coords in ([], [{"lat": 40, "lon": 140}]):
            p["coordinates"] = coords
            with patch.object(resolver, "wikipedia", return_value=None), patch.object(resolver, "api", return_value={"query": {"pages": [p]}}):
                self.assertIsNone(resolver.resolve())

    def test_none_is_cached_but_api_errors_are_not_cached_as_no_photo(self):
        with patch.object(photos.Resolver, "resolve", return_value=None) as resolve:
            self.assertEqual(photos.place_photo(PLACE)["status"], "none")
            photos.place_photo(PLACE)
            self.assertEqual(resolve.call_count, 1)
        with photos._lock: photos._cache.clear()
        with patch.object(photos.Resolver, "resolve", side_effect=photos.PhotoError("PhotoTimeout", "timeout", 504)) as resolve:
            for _ in range(2):
                with self.assertRaises(photos.PhotoError): photos.place_photo(PLACE)
            self.assertEqual(resolve.call_count, 2)

    def test_manual_retry_bypasses_negative_cache_and_refresh_flag_is_not_identity(self):
        with patch.object(photos.Resolver, "resolve", return_value=None) as resolve:
            photos.place_photo(PLACE); photos.place_photo(PLACE)
            self.assertEqual(resolve.call_count, 1)
            photos.place_photo({**PLACE, "refresh": True})
            self.assertEqual(resolve.call_count, 2)
            photos.place_photo(PLACE)
            self.assertEqual(resolve.call_count, 2)
            self.assertEqual(len(photos._cache), 1)
            with self.assertRaises(photos.PhotoError): photos.place_photo({**PLACE, "refresh": "true"})

    def test_shared_metadata_coalesces_concurrent_requests_without_sharing_mutable_data(self):
        started, release = Event(), Event()
        calls = []
        def fetch():
            calls.append(1); started.set(); release.wait(timeout=2)
            return {"query": {"pages": [{"title": "same metadata"}]}}
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(photos.shared_response, "key", time.monotonic()+3, False, fetch)
            self.assertTrue(started.wait(timeout=1))
            second = pool.submit(photos.shared_response, "key", time.monotonic()+3, False, fetch)
            release.set(); a, b = first.result(), second.result()
        self.assertEqual(len(calls), 1)
        a["query"]["pages"][0]["title"] = "changed"
        self.assertEqual(b["query"]["pages"][0]["title"], "same metadata")

    def test_shared_metadata_refresh_expiry_bounds_and_errors(self):
        calls=[]
        def fetch(): calls.append(1); return {"value": len(calls)}
        deadline=lambda: time.monotonic()+3
        self.assertEqual(photos.shared_response("a", deadline(), False, fetch)["value"], 1)
        self.assertEqual(photos.shared_response("a", deadline(), False, fetch)["value"], 1)
        self.assertEqual(photos.shared_response("a", deadline(), True, fetch)["value"], 2)
        with patch.object(photos, "API_CACHE_LIMIT", 1):
            photos.shared_response("b", deadline(), False, fetch)
            self.assertEqual(list(photos._api_cache), ["b"])
        with photos._api_lock:
            _, body, at=photos._api_cache["b"]; photos._api_cache["b"]=(0,body,at)
        self.assertEqual(photos.shared_response("b", deadline(), False, fetch)["value"], 4)
        for _ in range(2):
            with self.assertRaises(photos.PhotoError):
                photos.shared_response("failure", deadline(), False, lambda: (_ for _ in ()).throw(photos.PhotoError("PhotoUnavailable", "failed")))
        self.assertNotIn("failure", photos._api_cache); self.assertFalse(photos._api_jobs)
        with patch.object(photos, "API_CACHE_BYTES", 1):
            photos.shared_response("c", deadline(), False, fetch)
            self.assertLessEqual(photos._api_bytes, 1)

    def test_cached_metadata_is_rechecked_for_each_destination(self):
        calls=[]
        p=page();p["coordinates"]=[{"lat":35.674,"lon":139.756}]
        def request(site,params): calls.append(1);return {"query":{"pages":[p]}}
        near=self.resolver();far=photos.Resolver({**PLACE,"lat":40,"lng":140})
        with patch.object(near,"api_request",side_effect=lambda *args:request(*args)), patch.object(far,"api_request",side_effect=lambda *args:request(*args)):
            self.assertIsNotNone(near.image("File:Park.jpg"))
            self.assertIsNone(far.image("File:Park.jpg"))
        self.assertEqual(len(calls),1)
        near.session.close();far.session.close()

    def test_successful_photo_requests_reuse_connections_and_manual_refresh_marks_resolver(self):
        sessions=[];refresh=[]
        def resolve(resolver): sessions.append(resolver.session);refresh.append(resolver.refresh);return None
        with patch.object(photos.Resolver,"resolve",resolve):
            photos.place_photo({**PLACE,"refresh":True})
            photos.place_photo({**PLACE,"refresh":True})
        self.assertIs(sessions[0],sessions[1]);self.assertEqual(refresh,[True,True])

    def test_work_is_bounded_and_rejects_invalid_requests(self):
        resolver = self.resolver(); resolver.calls = photos.MAX_CALLS
        with self.assertRaises(photos.PhotoError): resolver.api("commons", action="query")
        for payload in (None, {}, {**PLACE, "lat": True}, {**PLACE, "lng": float("inf")}, {**PLACE, "hints": {"image": {}}}):
            with self.assertRaises(photos.PhotoError): photos.place_photo(payload)

    def test_upstream_timeouts_and_backoff_keep_error_codes_and_never_retry(self):
        resolver = self.resolver()
        with patch.object(resolver.session, "get", side_effect=requests.Timeout) as get:
            with self.assertRaises(photos.PhotoError) as error: resolver.api("commons", action="query")
            self.assertEqual(error.exception.code, "PhotoTimeout")
            self.assertEqual(get.call_count, 1)
        from unittest.mock import MagicMock
        resolver = self.resolver()  # A separate lookup, not a repeated failed request.
        response = MagicMock(); response.__enter__.return_value = response; response.status_code = 429
        with patch.object(resolver.session, "get", return_value=response) as get:
            for _ in range(2):
                with self.assertRaises(photos.PhotoError) as error: resolver.api("commons", action="query")
                self.assertEqual(error.exception.code, "PhotoBusy")
            self.assertEqual(get.call_count, 1)

    def test_concurrency_limit_does_not_queue_unbounded_work(self):
        self.assertTrue(photos._slots.acquire(blocking=False)); self.assertTrue(photos._slots.acquire(blocking=False))
        try:
            with self.assertRaises(photos.PhotoError) as error: photos.place_photo(PLACE)
            self.assertEqual(error.exception.code, "PhotoBusy")
        finally:
            photos._slots.release(); photos._slots.release()

    def test_one_source_timeout_can_recover_with_a_verified_other_source(self):
        resolver = self.resolver()
        calls = []
        def request(site, params):
            calls.append((site, params.get("action")))
            resolver.calls += 1
            if site == "ja":
                raise photos.PhotoError("PhotoTimeout", "timeout", 504)
            if params.get("action") == "wbsearchentities":
                return {"search": [{"id": "Q123", "match": {"text": PLACE["name"]}}]}
            if params.get("action") == "wbgetentities":
                return {"entities": {"Q123": {"labels": {"ja": {"value": PLACE["name"]}}, "claims": {
                    "P625": [{"mainsnak": {"datavalue": {"value": {"latitude": PLACE["lat"], "longitude": PLACE["lng"]}}}}],
                    "P18": [{"mainsnak": {"datavalue": {"value": "Park.jpg"}}}]}}}}
            return {"query": {"pages": [page()]}}
        with patch.object(resolver, "api_request", side_effect=request):
            result = resolver.resolve()
        self.assertEqual(result["match"]["level"], "high")
        self.assertEqual(calls.count(("ja", "query")), 1)
        self.assertLessEqual(resolver.calls, photos.MAX_CALLS)

    def test_failed_file_request_is_not_repeated_and_linked_category_can_recover(self):
        resolver = self.resolver({"image": "File:Park.jpg", "wikimedia_commons": "Category:Specific park"})
        calls = []
        def request(site, params):
            calls.append(params)
            if params.get("titles"):
                raise photos.PhotoError("PhotoTimeout", "timeout", 504)
            return {"query": {"pages": [page()]}}
        with patch.object(resolver, "api_request", side_effect=request):
            result = resolver.resolve()
            self.assertIsNone(resolver.attempt(resolver.image, "File:Park.jpg"))
        self.assertEqual(result["match"]["level"], "high")
        self.assertEqual(len(calls), 2)

    def test_incomplete_fallbacks_remain_errors_and_are_not_cached_as_no_photo(self):
        with patch.object(photos.Resolver, "api_request", side_effect=photos.PhotoError("PhotoTimeout", "timeout", 504)) as request:
            for _ in range(2):
                with self.assertRaises(photos.PhotoError) as error:
                    photos.place_photo(PLACE)
                self.assertEqual(error.exception.code, "PhotoTimeout")
            self.assertGreater(request.call_count, 2)
        self.assertFalse(photos._cache)

    def test_busy_source_stops_fallbacks_and_keeps_the_provider_backoff(self):
        resolver = self.resolver()
        with patch.object(resolver, "api_request", side_effect=photos.PhotoError("PhotoBusy", "busy", 503)) as request:
            with self.assertRaises(photos.PhotoError) as error:
                resolver.resolve()
        self.assertEqual(error.exception.code, "PhotoBusy")
        self.assertEqual(request.call_count, 1)

    def test_call_limit_is_not_a_timeout_and_retry_reuses_successful_identity_metadata(self):
        resolver = self.resolver(); resolver.calls = photos.MAX_CALLS
        with self.assertRaises(photos.PhotoError) as error:
            resolver.api("commons", action="query", titles="File:Budget.jpg")
        self.assertEqual(error.exception.code, "PhotoLimit")
        calls = []
        def request(url, **kwargs):
            params = kwargs["params"]; calls.append(params)
            if url == photos.APIS["commons"] and len(calls) == 2:
                raise requests.Timeout()
            data = {"query": {"pages": [page()]}} if url == photos.APIS["commons"] else {"query": {"pages": [{
                "title": PLACE["name"], "ns": 0, "coordinates": [{"lat": PLACE["lat"], "lon": PLACE["lng"]}],
                "pageimage": "Park.jpg", "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Park.jpg"}}]}}
            response = requests.Response(); response.status_code = 200
            response._content = json.dumps(data).encode(); response._content_consumed = True
            return response
        with patch.object(requests.Session, "get", side_effect=request), patch.object(photos.Resolver, "search_entities", return_value=None), \
                patch.object(photos.Resolver, "wikipedia", return_value=None), patch.object(photos.Resolver, "nearby_photo", return_value=None):
            with self.assertRaises(photos.PhotoError) as error:
                photos.place_photo(PLACE)
            self.assertEqual(error.exception.code, "PhotoTimeout")
            result = photos.place_photo({**PLACE, "refresh": True, "reuseMetadata": True})
        self.assertEqual(result["status"], "found")
        self.assertEqual(len(calls), 3)

    def test_metadata_reuse_flag_is_validated_and_does_not_change_place_identity(self):
        with self.assertRaises(photos.PhotoError):
            photos.place_photo({**PLACE, "reuseMetadata": "true"})
        refresh = []
        def resolve(resolver): refresh.append(resolver.refresh); return None
        with patch.object(photos.Resolver, "resolve", resolve):
            photos.place_photo({**PLACE, "refresh": True, "reuseMetadata": True})
            photos.place_photo(PLACE)
        self.assertEqual(refresh, [False])

    def test_bus_stop_named_after_a_station_does_not_adopt_the_station_article_photo(self):
        resolver = photos.Resolver({**PLACE, "name": "Example駅", "kindId": "bus_stop"})
        article = {"title": "Example駅", "coordinates": [{"lat": PLACE["lat"], "lon": PLACE["lng"]}], "pageimage": "Park.jpg",
                   "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Park.jpg"}}
        with patch.object(resolver, "image") as image:
            self.assertIsNone(resolver.wiki_pages({"query": {"pages": [article]}}))
        image.assert_not_called()
        self.assertTrue(photos.transport_kind_conflict("bus_stop", "日本の鉄道駅"))
        self.assertFalse(photos.transport_kind_conflict("bus_stop", "Example駅のバス乗り場"))

    def test_wikipedia_local_image_is_not_mistaken_for_same_named_commons_file(self):
        resolver = self.resolver()
        p = {"title": PLACE["name"], "coordinates": [{"lat": 35.674, "lon": 139.756}], "pageimage": "Park.jpg",
             "original": {"source": "https://upload.wikimedia.org/wikipedia/ja/a/ab/Park.jpg"}}
        with patch.object(resolver, "api", return_value={"query": {"pages": [p]}}), patch.object(resolver, "image") as image:
            self.assertIsNone(resolver.wikipedia())
        image.assert_not_called()

    def test_name_normalization_keeps_faculty_and_station_identity(self):
        self.assertTrue(photos.named_match("日本大学（文理学部）", "日本大学 文理学部"))
        self.assertTrue(photos.named_match("Ｃａｆｅ　ＡＢＣ", "Cafe ABC"))
        self.assertFalse(photos.named_match("日本大学", "日本大学（文理学部）"))
        self.assertFalse(photos.named_match("日比谷公園", "日比谷公園前駅"))

    def test_short_mlit_station_name_gets_station_alias_only_for_stations(self):
        resolver = photos.Resolver({**PLACE, "name": "秋津", "kindId": "station"})
        self.assertEqual(resolver.names[0], "秋津駅")
        resolver.session.close()
        resolver = photos.Resolver({**PLACE, "name": "秋津駅", "kindId": "station"})
        self.assertNotIn("秋津駅駅", resolver.names)
        resolver.session.close()
        resolver = photos.Resolver({**PLACE, "name": "秋津", "kindId": "park"})
        self.assertNotIn("秋津駅", resolver.names)
        resolver.session.close()

    def test_location_requires_specific_parts_and_ignores_historical_prose(self):
        expected = "東京都、世田谷区、桜上水三丁目"
        text = "昔は大阪府に所在。\n== 沿革 ==\n東京都世田谷区桜上水に移転\n== 所在地 ==\n住所：[[東京都]][[世田谷区]][[桜上水]]3丁目25番40号\n== 歴史 ==\n大阪府大阪市"
        addresses = photos.article_addresses(text)
        self.assertEqual(len(addresses), 1)
        self.assertEqual(photos.location_evidence(expected, addresses), (True, False))
        self.assertEqual(photos.location_evidence(expected, ["東京都世田谷区の別の町"]), (False, False))
        self.assertEqual(photos.location_evidence(expected, ["大阪府大阪市中央区"]), (False, True))
        self.assertEqual(photos.location_evidence(expected, ["東京都杉並区下高井戸"]), (False, True))

    def test_confidence_never_promotes_name_or_kind_alone_and_conflict_is_veto(self):
        self.assertEqual(photos.confidence(name=True, kind=True)["level"], "medium")
        self.assertEqual(photos.confidence(name=True, address=True)["level"], "high")
        self.assertEqual(photos.confidence(linked=True)["level"], "high")
        self.assertEqual(photos.confidence(linked=True, name=True, near=True, conflict=True)["level"], "low")

    def test_redirect_plus_specific_address_accepts_photo_without_coordinates(self):
        resolver = self.resolver()
        resolver.place["address"] = "東京都、千代田区、日比谷公園"
        p = {"pageid": 3, "title": "日比谷公園と庭園", "pageimage": "Park.jpg",
             "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Park.jpg"}}
        data = {"query": {"redirects": [{"from": "日比谷公園", "to": p["title"]}], "pages": [p]}}
        revisions = {"query": {"pages": [{"revisions": [{"slots": {"main": {"content": "== 所在地 ==\n住所：東京都千代田区日比谷公園1番\n== 交通 =="}}}]}]}}
        with patch.object(resolver, "api", return_value=revisions), patch.object(resolver, "image", return_value={"valid": True}):
            result = resolver.wiki_pages(data)
        self.assertTrue(result["valid"])
        self.assertEqual(result["match"]["level"], "high")
        self.assertIn("address", result["match"]["evidence"])

    def test_redirect_name_alone_is_insufficient_and_wrong_address_is_rejected(self):
        p = {"title": "正式な施設名", "pageimage": "Park.jpg", "pageid": 3,
             "original": {"source": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Park.jpg"}}
        data = {"query": {"redirects": [{"from": "日比谷公園", "to": p["title"]}], "pages": [p]}}
        for address, text in (("", ""), ("東京都、世田谷区、桜上水", "| 所在地 = 大阪府大阪市中央区")):
            resolver = self.resolver(); resolver.place["address"] = address
            response = {"query": {"pages": [{"revisions": [{"slots": {"main": {"content": text}}}]}]}}
            with patch.object(resolver, "api", return_value=response), patch.object(resolver, "image") as image:
                self.assertIsNone(resolver.wiki_pages(data))
            image.assert_not_called()

    def test_explicit_facility_category_works_without_photo_coordinates(self):
        resolver = self.resolver({"wikimedia_commons": "Category:Specific park"})
        with patch.object(resolver, "api", return_value={"query": {"pages": [page()]}}) as api:
            result = resolver.resolve()
        self.assertFalse(result["nearby"])
        self.assertEqual(result["match"]["level"], "high")
        self.assertEqual(api.call_args.kwargs["generator"], "categorymembers")
        self.assertEqual(api.call_args.kwargs["gcmlimit"], 5)

    def test_category_is_never_traversed_for_unconfirmed_name_match_or_far_photo(self):
        resolver = self.resolver()
        with patch.object(resolver, "api") as api:
            self.assertIsNone(resolver.category("Category:Park", photos.confidence(name=True)))
        api.assert_not_called()
        p = page(); p["coordinates"] = [{"lat": 1, "lon": 1}]
        with patch.object(resolver, "api", return_value={"query": {"pages": [p]}}):
            self.assertIsNone(resolver.category("Category:Specific park", photos.confidence(linked=True)))

    def test_wikidata_alias_and_nearby_coordinates_promote_discovered_entity(self):
        resolver = self.resolver()
        entity = {"entities": {"Q123": {"labels": {"en": {"value": "Hibiya Park"}}, "aliases": {"ja": [{"value": "日比谷公園"}]}, "claims": {
            "P625": [{"mainsnak": {"datavalue": {"value": {"latitude": 35.674, "longitude": 139.756}}}}],
            "P18": [{"mainsnak": {"datavalue": {"value": "Park.jpg"}}}]}}}}
        with patch.object(resolver, "api", return_value=entity), patch.object(resolver, "image", return_value={"valid": True}):
            self.assertEqual(resolver.entities(["Q123"])["match"]["level"], "high")
        self.assertIn("Hibiya Park", resolver.names)

    def test_same_name_discovered_entity_without_location_is_not_adopted(self):
        resolver = self.resolver()
        entity = {"entities": {"Q123": {"labels": {"ja": {"value": "日比谷公園"}}, "claims": {
            "P18": [{"mainsnak": {"datavalue": {"value": "Park.jpg"}}}]}}}}
        with patch.object(resolver, "api", return_value=entity), patch.object(resolver, "image") as image:
            self.assertIsNone(resolver.entities(["Q123"]))
        image.assert_not_called()

    def test_destination_context_is_optional_and_bounded_for_old_records(self):
        self.assertEqual(photos.validate_place(PLACE)["address"], "")
        self.assertEqual(photos.validate_place({**PLACE, "address": "東京都、世田谷区", "kindId": "park", "hints": {"name:en": "Park"}})["hints"], {"name:en": "Park"})
        with self.assertRaises(photos.PhotoError): photos.validate_place({**PLACE, "address": "x"*501})


class PhotoEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.WalkingHandler)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=2)

    def post(self, payload, origin="http://localhost:5500"):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request("POST", "/api/place-photo", json.dumps(payload) if payload is not None else b"", {"Content-Type": "application/json", "Origin": origin})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally: conn.close()

    def test_endpoint_success_cors_and_failure_remain_separate_from_search(self):
        with patch("app.place_photo", return_value={"status": "none", "photo": None}):
            status, headers, result = self.post(PLACE)
            self.assertEqual(status, 200); self.assertEqual(result["status"], "none")
            self.assertEqual(headers["X-Walking-Map"], "1")
            self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5500")
        with patch("app.place_photo", side_effect=photos.PhotoError("PhotoTimeout", "timeout", 504)):
            self.assertEqual(self.post(PLACE)[0], 504)
        self.assertEqual(self.post(None, "https://unknown.example")[0], 403)
        self.assertEqual(self.post({})[0], 400)


if __name__ == "__main__":
    unittest.main()
