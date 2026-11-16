"""Bounded Wikimedia photo lookup. No image binaries or arbitrary URL proxying.

Only Commons JPEG/PNG/WebP photos with supported, explicit reusable licenses
and attribution are returned. Coordinates belong to the destination, never GPS.
"""
from collections import OrderedDict
from concurrent.futures import Future
from html import unescape
from html.parser import HTMLParser
from math import asin, cos, radians, sin, sqrt, isfinite
from threading import BoundedSemaphore, Lock
from urllib.parse import unquote, urlsplit
import json
import re
import time
import unicodedata

import requests

AGENT = "WalkingMapPhotos/1.0 (https://github.com/yakinikuningen2/walking)"
META_FIELDS = "Artist|Credit|Attribution|LicenseUrl|Copyrighted|Restrictions|Categories|ObjectName"
APIS = {"commons": "https://commons.wikimedia.org/w/api.php",
        "wikidata": "https://www.wikidata.org/w/api.php",
        "ja": "https://ja.wikipedia.org/w/api.php", "en": "https://en.wikipedia.org/w/api.php"}
MAX_CALLS, DEADLINE, CACHE_LIMIT = 8, 18, 512
THUMB_WIDTH = 320
API_CACHE_TTL, API_CACHE_LIMIT, API_CACHE_BYTES = 600, 96, 6 * 1024 * 1024
_cache, _lock, _slots = OrderedDict(), Lock(), BoundedSemaphore(2)
_api_cache, _api_jobs, _api_lock = OrderedDict(), {}, Lock()
_api_bytes = 0
_session_pool, _session_lock = [], Lock()
_next_call = 0.0
_cooldown = 0.0


class PhotoError(Exception):
    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def shared_response(key, deadline, refresh, fetch):
    """Share API metadata only. Every destination still runs identity/license checks."""
    global _api_bytes
    now = time.monotonic()
    if now >= deadline:
        raise PhotoError("PhotoTimeout", "写真の確認が時間内に終わりませんでした。", 504)
    job_key = (key, refresh)
    with _api_lock:
        cached = _api_cache.get(key)
        if not refresh and cached and cached[0] > now:
            _api_cache.move_to_end(key)
            return json.loads(cached[1])
        job = _api_jobs.get(job_key)
        owner = job is None
        if owner:
            job = Future(); _api_jobs[job_key] = job
    if not owner:
        try:
            return json.loads(job.result(timeout=max(.01, deadline-time.monotonic())))
        except TimeoutError as error:
            raise PhotoError("PhotoTimeout", "写真の確認が時間内に終わりませんでした。", 504) from error
    try:
        data = fetch()
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with _api_lock:
            current = _api_cache.get(key)
            if len(body) <= 1000000 and (not current or current[2] <= now):
                if current: _api_bytes -= len(current[1])
                _api_cache[key] = (time.monotonic()+API_CACHE_TTL, body, now)
                _api_cache.move_to_end(key); _api_bytes += len(body)
                while len(_api_cache) > API_CACHE_LIMIT or _api_bytes > API_CACHE_BYTES:
                    _, removed = _api_cache.popitem(last=False); _api_bytes -= len(removed[1])
        job.set_result(body)
        return data
    except BaseException as error:
        job.set_exception(error)
        raise
    finally:
        with _api_lock: _api_jobs.pop(job_key, None)


def take_session():
    with _session_lock:
        if _session_pool: return _session_pool.pop()
    return requests.Session()


def return_session(session):
    with _session_lock:
        if len(_session_pool) < 2:
            _session_pool.append(session); return
    session.close()


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.blocked = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.blocked += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.blocked = max(0, self.blocked - 1)

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(data)


def plain(value, limit=800):
    parser = _Text()
    parser.feed(str(value)[:10000])
    return " ".join(unescape(" ".join(parser.parts)).split())[:limit]


def normalized(value):
    return re.sub(r"[\W_]", "", unicodedata.normalize("NFKC", str(value)).casefold())


def named_match(name, candidate):
    # Keep meaningful parenthesized parts: 大学（文理学部） != 大学.
    def forms(value):
        value = unicodedata.normalize("NFKC", str(value))
        base = re.sub(r"\(([^)]*[都道府県市区町村][^)]*)\)$", "", value)
        return {normalized(value), normalized(base)}
    return len(normalized(name)) >= 3 and bool(forms(name) & forms(candidate))


def kind_matches(kind, text):
    words = {"park": ("公園", "park"), "shrine": ("神社", "寺院", "shrine", "temple"),
             "culture": ("博物館", "美術館", "museum", "gallery"), "station": ("駅", "station"),
             "cafe": ("喫茶", "cafe", "café"), "restaurant": ("飲食店", "料理店", "restaurant")}
    return any(word in text.casefold() for word in words.get(kind, ()))


def transport_kind_conflict(kind, text):
    """A bus stop named after a railway station is not the station itself."""
    return kind == "bus_stop" and bool(re.search(r"駅|\b(?:railway|train|subway) station\b", text, re.I)) \
        and not re.search(r"バス|\bbus\b", text, re.I)


def wiki_text(value):
    value = re.sub(r"<ref\b[^>]*>.*?</ref>|<ref\b[^>]*/>", "", str(value), flags=re.S | re.I)
    value = re.sub(r"\[\[(?:[^]|]*\|)?([^]]+)\]\]", r"\1", value)
    return plain(value.replace("'''", "").replace("''", ""), 12000)


def address_text(value):
    value = unicodedata.normalize("NFKC", wiki_text(value))
    digits = str.maketrans("〇一二三四五六七八九", "0123456789")
    value = re.sub(r"[〇一二三四五六七八九](?=丁目|番|号)", lambda m: m[0].translate(digits), value)
    return normalized(value)


def location_evidence(expected, candidates):
    """Only explicit address fields/sections, never historical mentions in prose.

    Require a matching municipality and a specific neighbourhood/street, or two
    explicit administrative levels. Known conflicting prefectures are a veto.
    """
    if not expected or not candidates:
        return False, False
    parts = [address_text(p) for p in re.split(r"[、,\s]+", expected) if len(address_text(p)) >= 2]
    prefix = re.compile(r"^(?:日本)?(東京都|北海道|京都府|大阪府|.{2,3}県)")
    prefectures = re.findall(r"東京都|北海道|京都府|大阪府|[^\W\d_]{2,3}県", expected)
    specific = []
    for part in parts:
        tail = prefix.sub("", part)
        specific.extend(re.findall(r"[^\d]{2,12}?[市区町村]", tail))
        town = re.sub(r"^.*?[市区町村]", "", tail)
        town = re.sub(r"(?:\d|丁目|番号|番地).*$", "", town)
        if len(town) >= 3:
            specific.append(town)
        if len(tail) >= 3 and not re.search(r"[都道府県市区町村]", tail):
            specific.append(re.sub(r"\d.*$", "", tail))
    specific = list(dict.fromkeys(p for p in specific if len(p) >= 2))
    for candidate in candidates:
        text = address_text(candidate)
        found_prefs = re.findall(r"東京都|北海道|京都府|大阪府|[^\W\d_]{2,3}県", wiki_text(candidate))
        if prefectures and found_prefs and not set(prefectures) & set(found_prefs):
            return False, True
        candidate_tail = re.sub(r"^(?:住所|所在地|本社所在地)", "", text)
        candidate_tail = prefix.sub("", candidate_tail)
        candidate_admin = re.findall(r"[^\d]{2,12}?[市区町村]", candidate_tail)
        for ending in ("市", "区", "町", "村"):
            expected_admin = {p for p in specific if p.endswith(ending)}
            actual_admin = {p for p in candidate_admin if p.endswith(ending)}
            if expected_admin and actual_admin and not expected_admin & actual_admin:
                return False, True
        matches = sum(token in text for token in specific)
        if matches >= 2:
            return True, False
    return False, False


def article_addresses(text):
    addresses = []
    section = False
    for line in str(text).splitlines():
        heading = re.match(r"^==+\s*(.*?)\s*==+", line)
        if heading:
            section = normalized(heading[1]) in ("所在地", "住所", "所在地アクセス", "交通アクセス", "location")
            continue
        field = re.match(r"^\s*\|\s*(?:所在地|住所|本社所在地|location|address)\s*=\s*(.+)", line, re.I)
        if field:
            addresses.append(wiki_text(field[1]))
        elif section and (re.match(r"^[*\s]*(?:住所|所在地)\s*[:：]", line) or ("[[" in line and re.search(r"[都道府県].*[市区町村]", line))):
            addresses.append(wiki_text(line))
    return addresses[:8]


def confidence(*, linked=False, name=False, near=False, address=False, conflict=False, kind=False):
    if conflict:
        return {"level": "low", "score": 0, "evidence": ["location-conflict"]}
    evidence = [key for key, value in (("linked-id", linked), ("exact-name-or-alias", name),
                ("coordinates", near), ("address", address), ("category-kind", kind)) if value]
    score = 90 if linked else (60 if name else 0)
    score += 30 if near else 0
    score += 30 if address else 0
    score += 5 if kind else 0
    return {"level": "high" if score >= 90 else "medium" if score >= 60 else "low", "score": min(score, 100), "evidence": evidence}


def distance(a, b):
    lat, lng, other_lat, other_lng = map(radians, (*a, *b))
    h = sin((other_lat-lat)/2)**2 + cos(lat)*cos(other_lat)*sin((other_lng-lng)/2)**2
    return 12742000 * asin(sqrt(min(1, h)))


def coordinates(value):
    if not isinstance(value, dict):
        return None
    lat, lng = value.get("lat", value.get("latitude")), value.get("lon", value.get("longitude"))
    if all(type(v) in (int, float) and isfinite(v) for v in (lat, lng)) and abs(lat) <= 90 and abs(lng) <= 180:
        return lat, lng
    return None


def file_title(value):
    if not isinstance(value, str) or len(value) > 1000:
        return None
    if value.startswith("https://"):
        url = urlsplit(value)
        if url.hostname == "commons.wikimedia.org" and url.path.startswith("/wiki/File:"):
            value = unquote(url.path[6:])
        elif url.hostname in ("upload.wikimedia.org", "thumb.wikimedia.org") and url.path.startswith("/wikipedia/commons/"):
            parts = unquote(url.path).split("/")
            value = "File:" + (parts[-2] if "/thumb/" in url.path else parts[-1])
        else:
            return None
    value = value.removeprefix("File:").strip().replace("_", " ")
    if re.search(r"[\x00-\x1f|#<>]", value) or not re.search(r"\.(jpg|jpeg|png|webp)$", value, re.I):
        return None
    return "File:" + value


def license_info(meta):
    url = str(meta.get("LicenseUrl", {}).get("value", "")).replace("http://", "https://")
    parsed = urlsplit(url)
    path = parsed.path.rstrip("/") + "/"
    if parsed.hostname not in ("creativecommons.org", "www.creativecommons.org") or parsed.username or parsed.password:
        return None
    match = re.fullmatch(r"/licenses/(by|by-sa)/(1\.0|2\.0|2\.5|3\.0|4\.0)/", path)
    if match:
        name = f"CC {match[1].upper()} {match[2]}"
    elif path == "/publicdomain/zero/1.0/":
        name = "CC0 1.0"
    elif path == "/publicdomain/mark/1.0/":
        name = "Public domain"
    else:
        return None
    return name, "https://creativecommons.org" + path


def photo_from_page(page, nearby=False):
    info = next(iter(page.get("imageinfo", [])), {})
    meta = info.get("extmetadata", {})
    # PageImages can select a map rather than a photograph (even as JPEG/WebP).
    names = " ".join((str(page.get("title", "")), plain(meta.get("ObjectName", {}).get("value", ""))))
    categories = plain(meta.get("Categories", {}).get("value", ""), 10000)
    if (re.search(r"\b(?:map|maps|logo|diagram|coat.of.arms|floor.plan|painting|drawing)\b|地形図|位置図|案内図|配置図|ロゴ", names, re.I)
            or re.search(r"(?:^|\|)(?:Maps of |Locator maps|Coats of arms|Logos of |Diagrams|Floor plans|Paintings|Drawings)", categories, re.I)):
        return None
    license_data = license_info(meta)
    author = plain(meta.get("Artist", {}).get("value", ""))
    # Do not omit long attribution statements or special restrictions.
    attribution = plain(meta.get("Attribution", {}).get("value", ""), 2000)
    credit = plain(meta.get("Credit", {}).get("value", ""), 2000)
    title = plain(meta.get("ObjectName", {}).get("value", ""), 2000) or plain(page.get("title", "").removeprefix("File:"))
    if (not license_data or not author or normalized(author) in ("unknown", "unknownauthor", "anonymous", "不明", "作者不明")
            or len(author) >= 800 or len(attribution) >= 2000 or len(credit) >= 2000 or len(title) >= 2000):
        return None
    if any(plain(meta.get(key, {}).get("value", "")) for key in ("Restrictions",)):
        return None
    if str(meta.get("Copyrighted", {}).get("value", "")).lower() == "true" and license_data[0] == "Public domain":
        return None
    urls = [info.get("thumburl", ""), info.get("descriptionurl", "")]
    thumb, source = map(urlsplit, urls)
    if (thumb.scheme != "https" or thumb.hostname not in ("upload.wikimedia.org", "thumb.wikimedia.org") or thumb.username or thumb.password
            or not thumb.path.startswith("/wikipedia/commons/") or not re.search(r"\.(jpg|jpeg|png|webp)$", thumb.path, re.I)
            or source.scheme != "https" or source.hostname != "commons.wikimedia.org" or source.username or source.password or not source.path.startswith("/wiki/File:")):
        return None
    if info.get("mime") not in ("image/jpeg", "image/png", "image/webp"):
        return None
    large = info.get("responsiveUrls", {}).get("2", "")
    large_url = urlsplit(large)
    if not (large_url.scheme == "https" and large_url.hostname in ("upload.wikimedia.org", "thumb.wikimedia.org")
            and not large_url.username and not large_url.password and large_url.path.startswith("/wikipedia/commons/")
            and re.search(r"\.(jpg|jpeg|png|webp)$", large_url.path, re.I)):
        large = urls[0]
    return {"thumbnail": urls[0], "largeThumbnail": large, "sourceUrl": urls[1], "title": title,
            "author": author, "credit": credit, "attribution": attribution,
            "license": license_data[0], "licenseUrl": license_data[1], "nearby": bool(nearby),
            "displayNote": "表示枠に合わせてトリミング", "provider": "Wikimedia Commons"}


def validate_place(payload):
    if not isinstance(payload, dict) or not coordinates({"lat": payload.get("lat"), "lon": payload.get("lng")}):
        raise PhotoError("PhotoInput", "地点の情報を確認してください。", 400)
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise PhotoError("PhotoInput", "地点の名前を確認してください。", 400)
    hints = payload.get("hints", {})
    if not isinstance(hints, dict) or any(not isinstance(v, str) or len(v) > 1000 for v in hints.values()) or len(hints) > 20:
        raise PhotoError("PhotoInput", "写真の関連情報を確認してください。", 400)
    address, kind = payload.get("address", ""), payload.get("kindId", "")
    if not isinstance(address, str) or len(address) > 500 or not isinstance(kind, str) or len(kind) > 40:
        raise PhotoError("PhotoInput", "地点の所在地を確認してください。", 400)
    return {"name": name.strip(), "lat": round(payload["lat"], 5), "lng": round(payload["lng"], 5),
            "address": address, "kindId": kind,
            "hints": {k: v for k, v in hints.items() if k in ("image", "wikimedia_commons", "wikidata", "wikipedia",
                       "official_name", "alt_name", "short_name", "name:en", "name:ja", "old_name", "wikipedia:ja")}}


class Resolver:
    def __init__(self, place, session=None):
        self.place, self.point = place, (place["lat"], place["lng"])
        self.calls, self.end = 0, time.monotonic() + DEADLINE
        self.session = session if session is not None else requests.Session()
        self.refresh = False
        self.memo, self.checked_entities = {}, set()
        self.failed, self.failures = {}, []
        self.names = list(dict.fromkeys([place["name"], *[v.strip() for k, value in place["hints"].items()
                     if k in ("official_name", "alt_name", "short_name", "name:en", "name:ja")
                     for v in value.split(";") if 3 <= len(v.strip()) <= 120]]))[:8]
        # MLIT station names omit 駅; match the article's full name without
        # changing the visible station name or the saved place coordinates.
        if place.get("kindId") == "station" and re.search(r"[一-龯ぁ-んァ-ヶ]", place["name"]) and not place["name"].endswith("駅"):
            self.names = [place["name"] + "駅", *self.names][:8]

    def api(self, site, **params):
        memo_key = json.dumps([site, params], sort_keys=True)
        if memo_key in self.memo:
            return self.memo[memo_key]
        if memo_key in self.failed:
            raise self.failed[memo_key]
        try:
            data = shared_response(memo_key, self.end, self.refresh, lambda: self.api_request(site, params))
        except PhotoError as error:
            self.failed[memo_key] = error
            raise
        self.memo[memo_key] = data
        return data

    def attempt(self, work, *args, **kwargs):
        """A failed optional source must not discard another verifiable photo.

        Do not retry the same failed request or ignore an upstream cooldown.
        The existing total deadline and actual-call budget still apply.
        """
        try:
            return work(*args, **kwargs)
        except PhotoError as error:
            if error.code not in ("PhotoTimeout", "PhotoUnavailable", "PhotoLimit"):
                raise
            if error not in self.failures:
                self.failures.append(error)
            return None

    def api_request(self, site, params):
        global _next_call, _cooldown
        if time.monotonic() >= self.end:
            raise PhotoError("PhotoTimeout", "写真の確認が時間内に終わりませんでした。", 504)
        if self.calls >= MAX_CALLS:
            raise PhotoError("PhotoLimit", "今回の写真確認を完了できませんでした。再取得で続きを確認できます。", 503)
        with _lock:
            now = time.monotonic()
            if now < _cooldown:
                raise PhotoError("PhotoBusy", "写真の取得先が混み合っています。", 503)
            wait = max(0, _next_call-now)
            _next_call = max(now, _next_call) + .25
        if wait:
            time.sleep(min(wait, 1))
        remaining = self.end-time.monotonic()
        if remaining <= .2:
            raise PhotoError("PhotoTimeout", "写真の確認が時間内に終わりませんでした。", 504)
        self.calls += 1
        try:
            with self.session.get(APIS[site], params={"format": "json", "formatversion": 2, "maxlag": 5, **params},
                                  headers={"User-Agent": AGENT}, timeout=(min(2, remaining/2), min(4, remaining/2)),
                                  allow_redirects=False, stream=True) as response:
                if response.status_code in (429, 503):
                    with _lock:
                        _cooldown = time.monotonic()+60
                    raise PhotoError("PhotoBusy", "写真の取得先が混み合っています。", 503)
                response.raise_for_status()
                if response.status_code != 200:
                    raise ValueError("Unexpected response")
                body = bytearray()
                for chunk in response.iter_content(16384):
                    body.extend(chunk)
                    if len(body) > 1000000 or time.monotonic() > self.end:
                        raise PhotoError("PhotoTimeout", "写真の情報を取得できませんでした。", 504)
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError("Invalid response")
                if data.get("error"):
                    raise PhotoError("PhotoUnavailable", "写真の情報を取得できませんでした。")
                return data
        except requests.Timeout as error:
            raise PhotoError("PhotoTimeout", "写真の取得がタイムアウトしました。", 504) from error
        except (requests.RequestException, ValueError) as error:
            raise PhotoError("PhotoUnavailable", "写真の情報を取得できませんでした。") from error

    def image(self, title, nearby=False):
        title = file_title(title)
        if not title:
            return None
        pages = self.api("commons", action="query", titles=title, redirects=1, prop="imageinfo|coordinates",
                         coprimary="all", colimit="max", iiprop="url|mime|extmetadata", iiurlwidth=THUMB_WIDTH,
                         iiextmetadatafilter=META_FIELDS).get("query", {}).get("pages", [])
        for page in pages:
            coords = [coordinates(c) for c in page.get("coordinates", [])]
            if any(c and distance(self.point, c) > 2000 for c in coords):
                continue
            result = photo_from_page(page, nearby)
            if result:
                return result
        return None

    def wikipedia(self, title=None, site="ja", trusted=False):
        args = {"titles": title, "redirects": 1} if title else {
            "generator": "geosearch", "ggscoord": f"{self.point[0]}|{self.point[1]}", "ggsradius": 700, "ggslimit": 5}
        data = self.api(site, action="query", prop="coordinates|pageimages|pageprops", piprop="name|original", pilicense="free", **args)
        return self.wiki_pages(data, site, trusted)

    def adopt(self, photo, match):
        if photo:
            photo["match"] = match
        return photo

    def wiki_pages(self, data, site="ja", trusted=False):
        query = data.get("query", {})
        pages = query.get("pages", [])
        equivalences = query.get("redirects", []) + query.get("normalized", [])
        for page in pages:
            if page.get("missing") or "disambiguation" in page.get("pageprops", {}) or page.get("ns", 0) != 0:
                continue
            if not trusted and transport_kind_conflict(self.place.get("kindId", ""), page.get("title", "")):
                continue
            aliases = {page.get("title", "")}
            for _ in range(4):
                aliases.update(p.get("from", "") for p in equivalences if p.get("to") in aliases)
            name_match = any(named_match(name, alias) for name in self.names for alias in aliases)
            coord = next((coordinates(c) for c in page.get("coordinates", []) if coordinates(c)), None)
            conflict = bool(coord and distance(coord, self.point) > 2000)
            matched = confidence(linked=trusted, name=name_match, near=bool(coord and distance(coord, self.point) <= 1200), conflict=conflict,
                                 kind=kind_matches(self.place.get("kindId", ""), page.get("title", "")))
            if matched["level"] == "medium" and self.calls < MAX_CALLS-1:
                details = self.api(site, action="query", pageids=page.get("pageid"), titles=None if page.get("pageid") else page.get("title"),
                                   prop="revisions", rvprop="content", rvslots="main").get("query", {}).get("pages", [])
                content = next((p.get("revisions", [{}])[0].get("slots", {}).get("main", {}).get("content", "") for p in details), "")
                address, bad_address = location_evidence(self.place.get("address", ""), article_addresses(content))
                matched = confidence(name=name_match, address=address, conflict=conflict or bad_address,
                                     kind=kind_matches(self.place.get("kindId", ""), page.get("title", "")))
            if matched["level"] != "high":
                continue
            original = urlsplit(page.get("original", {}).get("source", ""))
            if (page.get("pageimage") and original.scheme == "https"
                    and original.hostname in ("upload.wikimedia.org", "thumb.wikimedia.org") and original.path.startswith("/wikipedia/commons/")):
                result = self.attempt(self.image, page["pageimage"])
                if result:
                    return self.adopt(result, matched)
            # Article-linked category is an identity reference, not a name search.
            qid = page.get("pageprops", {}).get("wikibase_item")
            if isinstance(qid, str) and qid not in self.checked_entities and self.calls < MAX_CALLS-2:
                result = self.attempt(self.entities, [qid], linked=True)
                if result:
                    return result
        return None

    def category(self, title, match):
        if not isinstance(title, str) or not title.startswith("Category:") or len(title) > 250 or match["level"] != "high":
            return None
        # Do not traverse subcategories: that can widen one facility into a city.
        if re.search(r"^(?:Category:)?(?:Japan|Parks|Museums|Railway stations|Restaurants|Buildings|Nature)$", title, re.I):
            return None
        pages = self.api("commons", action="query", generator="categorymembers", gcmtitle=title, gcmtype="file", gcmnamespace=6,
                         gcmlimit=5, prop="imageinfo|coordinates", coprimary="all", colimit="max", iiprop="url|mime|extmetadata",
                         iiurlwidth=THUMB_WIDTH, iiextmetadatafilter=META_FIELDS).get("query", {}).get("pages", [])
        for page in pages:
            if any(c and distance(c, self.point) > 2000 for c in map(coordinates, page.get("coordinates", []))):
                continue
            photo = photo_from_page(page)
            if photo:
                photo["categoryUrl"] = "https://commons.wikimedia.org/wiki/" + requests.utils.quote(title.replace(" ", "_"), safe=":,_")
                return self.adopt(photo, match)
        return None

    def entities(self, ids, linked=False):
        ids = [qid for qid in ids[:3] if isinstance(qid, str) and re.fullmatch(r"Q[1-9]\d{0,11}", qid) and qid not in self.checked_entities]
        if not ids:
            return None
        self.checked_entities.update(ids)
        data = self.api("wikidata", action="wbgetentities", ids="|".join(ids), props="claims|sitelinks|labels|aliases|descriptions", languages="ja|en")
        for qid in ids:
            entity = data.get("entities", {}).get(qid, {})
            claims = entity.get("claims", {})
            def values(key):
                return [c.get("mainsnak", {}).get("datavalue", {}).get("value") for c in claims.get(key, []) if c.get("rank") != "deprecated"]
            raw_coords = values("P625")
            earth = [coordinates(v) for v in raw_coords if isinstance(v, dict) and str(v.get("globe", "http://www.wikidata.org/entity/Q2")).endswith("/Q2")]
            valid = [c for c in earth if c]
            conflict = bool((raw_coords and not valid) or (valid and min(distance(c, self.point) for c in valid) > 2000))
            labels = [v.get("value", "") for v in entity.get("labels", {}).values()]
            labels += [v.get("value", "") for aliases in entity.get("aliases", {}).values() for v in aliases]
            labels += [v.get("title", "") for k, v in entity.get("sitelinks", {}).items() if k in ("jawiki", "enwiki")]
            name_match = any(named_match(a, b) for a in self.names for b in labels)
            address, bad_address = location_evidence(self.place.get("address", ""), [v.get("text", "") for v in values("P6375") if isinstance(v, dict)])
            description = " ".join(v.get("value", "") for v in entity.get("descriptions", {}).values())
            if not linked and transport_kind_conflict(self.place.get("kindId", ""), description):
                continue
            matched = confidence(linked=linked, name=name_match, near=bool(valid and min(distance(c, self.point) for c in valid) <= 1200), address=address, conflict=conflict or bad_address,
                                 kind=kind_matches(self.place.get("kindId", ""), description))
            if matched["level"] == "low":
                continue
            if matched["level"] == "high":
                self.names = list(dict.fromkeys([*self.names, *[s for s in labels if 3 <= len(s) <= 120]]))[:12]
                for image in values("P18")[:2]:
                    result = self.attempt(self.image, image)
                    if result:
                        return self.adopt(result, matched)
                categories = [entity.get("sitelinks", {}).get("commonswiki", {}).get("title", "")]
                categories += ["Category:" + v for v in values("P373") if isinstance(v, str)]
                for category in dict.fromkeys(categories):
                    if category and self.calls < MAX_CALLS:
                        result = self.attempt(self.category, category, matched)
                        if result:
                            return result
            for site, key in (("ja", "jawiki"), ("en", "enwiki")):
                title = entity.get("sitelinks", {}).get(key, {}).get("title")
                if title and self.calls < MAX_CALLS-1:
                    result = self.attempt(self.wikipedia, title, site, trusted=matched["level"] == "high")
                    if result:
                        return result
        return None

    def resolve(self):
        hints = self.place["hints"]
        # Existing facility photo references first, followed by explicit OSM relations.
        for key in ("image", "wikimedia_commons"):
            if file_title(hints.get(key)):
                result = self.attempt(self.image, hints[key])
                if result:
                    return self.adopt(result, confidence(linked=True))
        qid = hints.get("wikidata", "")
        if re.fullmatch(r"Q[1-9]\d{0,11}", qid):
            result = self.attempt(self.entities, [qid], linked=True)
            if result:
                return result
        explicit_category = hints.get("wikimedia_commons", "")
        if explicit_category.startswith("Category:"):
            result = self.attempt(self.category, explicit_category, confidence(linked=True))
            if result:
                return result
        wiki = hints.get("wikipedia", "") or ("ja:" + hints["wikipedia:ja"] if hints.get("wikipedia:ja") else "")
        site, _, title = wiki.partition(":")
        if site in ("ja", "en") and title:
            result = self.attempt(self.wikipedia, title, site, trusted=True)
            if result:
                return result
        if any(len(normalized(name)) >= 3 for name in self.names) and self.calls <= MAX_CALLS-2:
            result = self.attempt(self.wikipedia_names)
            if result:
                return result
        if self.calls <= MAX_CALLS-3:
            result = self.attempt(self.search_entities)
            if result:
                return result
        if self.calls <= MAX_CALLS-2:
            result = self.attempt(self.wikipedia)
            if result:
                return result
        result = self.attempt(self.nearby_photo)
        if result:
            return result
        if self.failures:
            raise self.failures[0]
        return None

    def wikipedia_names(self):
        data = self.api("ja", action="query", titles="|".join(self.names[:4]), redirects=1, prop="coordinates|pageimages|pageprops",
                        piprop="name|original", pilicense="free")
        return self.wiki_pages(data)

    def search_entities(self):
        ids = []
        for name in self.names[:3]:
            if self.calls > MAX_CALLS-3 or ids:
                break
            language = "en" if re.fullmatch(r"[\x20-\x7e]+", name) else "ja"
            search = self.api("wikidata", action="wbsearchentities", search=name, language=language, limit=3).get("search", [])
            ids.extend(p.get("id") for p in search if any(named_match(n, p.get("match", {}).get("text", "")) for n in self.names))
        return self.entities(ids)

    def nearby_photo(self):
        hints = self.place["hints"]
        # A photo near the destination is explicitly labelled as surrounding scenery.
        # Category hints narrow the search but never establish an exact photo match.
        name = self.place["name"]
        if len(normalized(name)) < 3 or name in ("名前のない場所", "地図で指定した地点", "森・林", "川辺・湖畔", "海辺・浜辺・港"):
            return None
        term = re.sub(r'["\\|~{}\[\]:]', " ", name)
        category = hints.get("wikimedia_commons", "")
        category = re.sub(r'["\\|~{}\[\]:]', " ", category[9:]) if category.startswith("Category:") else ""
        category_query = f' incategory:"{category}"' if category else ""
        pages = self.api("commons", action="query", generator="search", gsrnamespace=6, gsrlimit=5,
                         gsrsearch=f'nearcoord:500m,{self.point[0]},{self.point[1]} "{term}"{category_query}',
                         prop="coordinates|imageinfo", coprimary="all", colimit="max", iiprop="url|mime|extmetadata", iiurlwidth=THUMB_WIDTH,
                         iiextmetadatafilter=META_FIELDS).get("query", {}).get("pages", [])
        for page in sorted(pages, key=lambda p: p.get("index", 999)):
            coord = next((coordinates(c) for c in page.get("coordinates", []) if coordinates(c)), None)
            if not coord or distance(coord, self.point) > 500:
                continue
            photo = photo_from_page(page, nearby=True)
            if photo:
                return self.adopt(photo, {"level": "high", "score": 90, "scope": "surroundings", "evidence": ["nearby-coordinate-search", "name-query"]})
        return None


def place_photo(payload):
    place = validate_place(payload)
    refresh = payload.get("refresh", False)
    reuse_metadata = payload.get("reuseMetadata", False)
    if type(refresh) is not bool or type(reuse_metadata) is not bool:
        raise PhotoError("PhotoInput", "再取得の指定を確認してください。", 400)
    key = json.dumps(place, sort_keys=True, ensure_ascii=False)
    with _lock:
        cached = _cache.get(key)
        if not refresh and cached and cached[0] > time.monotonic():
            _cache.move_to_end(key)
            return cached[1]
    if not _slots.acquire(blocking=False):
        raise PhotoError("PhotoBusy", "写真の取得が混み合っています。", 503)
    session = None
    try:
        session = take_session()
        resolver = Resolver(place, session=session)
        resolver.refresh = refresh and not reuse_metadata
        photo = resolver.resolve()
        result = {"status": "found" if photo else "none", "photo": photo}
        with _lock:
            _cache[key] = (time.monotonic() + (86400 if photo else 600), result)
            while len(_cache) > CACHE_LIMIT:
                _cache.popitem(last=False)
        return result
    finally:
        if session is not None: return_session(session)
        _slots.release()
