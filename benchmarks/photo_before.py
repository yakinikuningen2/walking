"""Bounded Wikimedia photo lookup. No image binaries or arbitrary URL proxying.

Only Commons JPEG/PNG/WebP photos with supported, explicit reusable licenses
and attribution are returned. Coordinates belong to the destination, never GPS.
"""
from collections import OrderedDict
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
APIS = {"commons": "https://commons.wikimedia.org/w/api.php",
        "wikidata": "https://www.wikidata.org/w/api.php",
        "ja": "https://ja.wikipedia.org/w/api.php", "en": "https://en.wikipedia.org/w/api.php"}
MAX_CALLS, DEADLINE, CACHE_LIMIT = 8, 18, 512
_cache, _lock, _slots = OrderedDict(), Lock(), BoundedSemaphore(2)
_next_call = 0.0
_cooldown = 0.0


class PhotoError(Exception):
    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


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
    # Avoid substring matches such as 日比谷公園 vs 日比谷公園前駅.
    return len(normalized(name)) >= 3 and normalized(name) == normalized(re.sub(r"\s*[（(][^()（）]*[）)]\s*$", "", candidate))


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
    license_data = license_info(meta)
    author = plain(meta.get("Artist", {}).get("value", ""))
    # Do not omit long attribution statements or special restrictions.
    attribution = plain(meta.get("Attribution", {}).get("value", ""), 2000)
    credit = plain(meta.get("Credit", {}).get("value", ""), 2000)
    if (not license_data or not author or normalized(author) in ("unknown", "unknownauthor", "anonymous", "不明", "作者不明")
            or len(author) >= 800 or len(attribution) >= 2000 or len(credit) >= 2000):
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
    return {"thumbnail": urls[0], "largeThumbnail": large, "sourceUrl": urls[1], "title": plain(page.get("title", "").removeprefix("File:")),
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
    if not isinstance(hints, dict) or any(not isinstance(v, str) or len(v) > 1000 for v in hints.values()) or len(hints) > 8:
        raise PhotoError("PhotoInput", "写真の関連情報を確認してください。", 400)
    return {"name": name.strip(), "lat": round(payload["lat"], 5), "lng": round(payload["lng"], 5),
            "hints": {k: v for k, v in hints.items() if k in ("image", "wikimedia_commons", "wikidata", "wikipedia")}}


class Resolver:
    def __init__(self, place):
        self.place, self.point = place, (place["lat"], place["lng"])
        self.calls, self.end = 0, time.monotonic() + DEADLINE
        self.session = requests.Session()

    def api(self, site, **params):
        global _next_call, _cooldown
        if self.calls >= MAX_CALLS or time.monotonic() >= self.end:
            raise PhotoError("PhotoTimeout", "写真の確認が時間内に終わりませんでした。", 504)
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
                         coprimary="all", colimit="max", iiprop="url|mime|extmetadata", iiurlwidth=640,
                         iiextmetadatafilter="Artist|Credit|Attribution|LicenseUrl|Copyrighted|Restrictions").get("query", {}).get("pages", [])
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
        pages = self.api(site, action="query", prop="coordinates|pageimages", piprop="name|original", pilicense="free", **args).get("query", {}).get("pages", [])
        for page in pages:
            coord = next((coordinates(c) for c in page.get("coordinates", []) if coordinates(c)), None)
            if (not trusted and (not coord or distance(coord, self.point) > 1200 or not named_match(self.place["name"], page.get("title", "")))):
                continue
            original = urlsplit(page.get("original", {}).get("source", ""))
            if (page.get("pageimage") and original.scheme == "https"
                    and original.hostname in ("upload.wikimedia.org", "thumb.wikimedia.org") and original.path.startswith("/wikipedia/commons/")):
                result = self.image(page["pageimage"])
                if result:
                    return result
        return None

    def resolve(self):
        hints = self.place["hints"]
        # Existing facility photo references first, followed by explicit OSM relations.
        for key in ("image", "wikimedia_commons"):
            if file_title(hints.get(key)):
                result = self.image(hints[key])
                if result:
                    return result
        qid = hints.get("wikidata", "")
        if re.fullmatch(r"Q[1-9]\d{0,11}", qid):
            entity = self.api("wikidata", action="wbgetentities", ids=qid, props="claims|sitelinks").get("entities", {}).get(qid, {})
            claims = entity.get("claims", {})
            values = [c.get("mainsnak", {}).get("datavalue", {}).get("value", {})
                      for c in claims.get("P625", []) if c.get("rank") != "deprecated"]
            coords = [coordinates(v) for v in values if isinstance(v, dict) and v.get("globe", "http://www.wikidata.org/entity/Q2").endswith("/Q2")]
            if any(c and distance(c, self.point) <= 2000 for c in coords):
                for claim in claims.get("P18", [])[:2]:
                    if claim.get("rank") == "deprecated":
                        continue
                    result = self.image(claim.get("mainsnak", {}).get("datavalue", {}).get("value"))
                    if result:
                        return result
                title = entity.get("sitelinks", {}).get("jawiki", {}).get("title")
                if title:
                    result = self.wikipedia(title, trusted=True)
                    if result:
                        return result
        wiki = hints.get("wikipedia", "")
        site, _, title = wiki.partition(":")
        if site in ("ja", "en") and title:
            result = self.wikipedia(title, site)
            if result:
                return result
        elif len(normalized(self.place["name"])) >= 3 and self.calls <= MAX_CALLS-3:
            result = self.wikipedia()
            if result:
                return result
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
                         prop="coordinates|imageinfo", coprimary="all", colimit="max", iiprop="url|mime|extmetadata", iiurlwidth=640,
                         iiextmetadatafilter="Artist|Credit|Attribution|LicenseUrl|Copyrighted|Restrictions").get("query", {}).get("pages", [])
        for page in sorted(pages, key=lambda p: p.get("index", 999)):
            coord = next((coordinates(c) for c in page.get("coordinates", []) if coordinates(c)), None)
            if not coord or distance(coord, self.point) > 500:
                continue
            photo = photo_from_page(page, nearby=True)
            if photo:
                return photo
        return None


def place_photo(payload):
    place = validate_place(payload)
    key = json.dumps(place, sort_keys=True, ensure_ascii=False)
    with _lock:
        cached = _cache.get(key)
        if cached and cached[0] > time.monotonic():
            _cache.move_to_end(key)
            return cached[1]
    if not _slots.acquire(blocking=False):
        raise PhotoError("PhotoBusy", "写真の取得が混み合っています。", 503)
    resolver = Resolver(place)
    try:
        photo = resolver.resolve()
        result = {"status": "found" if photo else "none", "photo": photo}
        with _lock:
            _cache[key] = (time.monotonic() + (86400 if photo else 600), result)
            while len(_cache) > CACHE_LIMIT:
                _cache.popitem(last=False)
        return result
    finally:
        resolver.session.close()
        _slots.release()
