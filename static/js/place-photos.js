// Optional destination photos. Isolated from place search, route and record data.
((root) => {
  "use strict";
  function hints(place) {
    const result = {}, sources = [place?.photoHints, place?.hints, place?.tags, place];
    for (const key of ["image", "wikimedia_commons", "wikidata", "wikipedia", "official_name", "alt_name", "short_name", "name:en", "name:ja", "wikipedia:ja"]) {
      const value = sources.map(p => p?.[key]).find(v => typeof v === "string" && v.trim() && v.length <= 1000);
      if (value) result[key] = value.trim();
    }
    if (!result.wikidata && ["wikidata", "bundled:wikidata"].includes(place?.osmType || place?.type || place?.source)
        && /^Q[1-9]\d*$/.test(place.osmId || place.id)) result.wikidata = String(place.osmId || place.id);
    if (!result.image && typeof place?.imageUrl === "string") result.image = place.imageUrl.slice(0, 1000);
    return result;
  }
  function payload(place) {
    return { name: String(place.name || "").slice(0, 120), lat: place.lat, lng: place.lng, hints: hints(place),
      ...(typeof place.address === "string" && place.address ? { address: place.address.slice(0, 500) } : {}),
      ...(typeof place.kindId === "string" && place.kindId ? { kindId: place.kindId.slice(0, 40) } : {}) };
  }
  function createService({ request, limit = 200, timeout = 22000, concurrency = 2, now = Date.now, storage = null, persistLimit = 50 }) {
    const cache = new Map(), jobs = new Map(), queue = [];
    const storageKey = "walking.photo-metadata.v3";
    try {
      const raw = storage?.getItem(storageKey);
      const saved = raw && raw.length <= 262144 ? JSON.parse(raw) : null;
      if (saved?.version === 3 && Array.isArray(saved.entries) && saved.entries.length <= 50) {
        for (const item of saved.entries) {
          if (typeof item?.key !== "string" || item.key.length > 16384 || !Number.isFinite(item.until)
              || item.until <= now() || item.until > now()+86400000 || item.result?.status !== "found"
              || !validPhoto(item.result.photo) || JSON.stringify(item.result).length > 16000) continue;
          const data = JSON.parse(item.key);
          if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng) || Math.abs(data.lat) > 90 || Math.abs(data.lng) > 180
              || JSON.stringify(payload(data)) !== item.key) continue;
          cache.set(item.key, { until: item.until, result: item.result });
        }
        while (cache.size > limit) cache.delete(cache.keys().next().value);
      }
    } catch { /* Disabled, full or old storage never interrupts the map. */ }
    function persist() {
      if (!storage) return;
      const entries = [...cache].filter(([, hit]) => hit.until > now() && hit.result.status === "found")
        .map(([key, hit]) => ({ key, ...hit })).slice(-Math.min(limit, persistLimit, 50));
      try {
        let raw = JSON.stringify({ version: 3, entries });
        while (raw.length > 262144 && entries.length) { entries.shift(); raw = JSON.stringify({ version: 3, entries }); }
        storage.setItem(storageKey, raw);
      } catch { /* Keep the in-memory cache when storage cannot be written. */ }
    }
    let running = 0;
    function drain() {
      while (running < concurrency && queue.length) {
        const job = queue.shift();
        if (job.controller.signal.aborted || !job.listeners.size) continue;
        running++;
        const timer = setTimeout(() => job.controller.abort(), timeout);
        const abort = new Promise((_, reject) => job.controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
        Promise.race([Promise.resolve().then(() => request(job.data, job.controller.signal)), abort]).then(result => {
          if (!result || !["found", "none"].includes(result.status) || (result.status === "found" && !validPhoto(result.photo))) throw Error("Invalid photo response");
          if (!job.controller.signal.aborted) {
            cache.set(job.key, { until: now() + (result.photo ? 86400000 : 600000), result });
            while (cache.size > limit) cache.delete(cache.keys().next().value);
            persist();
            if (jobs.get(job.key) === job) jobs.delete(job.key);
            for (const listener of job.listeners) listener.resolve(result);
          }
        }).catch(error => {
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          for (const listener of job.listeners) listener.reject(error);
        }).finally(() => {
          clearTimeout(timer); for (const listener of job.listeners) listener.cleanup();
          if (jobs.get(job.key) === job) jobs.delete(job.key); running--; drain();
        });
      }
    }
    function get(place, signal, { refresh = false, reuseMetadata = false } = {}) {
      if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      const data = payload(place), key = JSON.stringify(data), hit = cache.get(key);
      if (!refresh && hit && hit.until > now()) {
        cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.result);
      }
      cache.delete(key);
      if (refresh) persist();
      let job = jobs.get(key);
      if (!job || job.controller.signal.aborted) {
        job = { data: refresh ? { ...data, refresh: true, ...(reuseMetadata ? { reuseMetadata: true } : {}) } : data, key, controller: new AbortController(), listeners: new Set() }; jobs.set(key, job); queue.push(job);
      }
      const promise = new Promise((resolve, reject) => {
        const cancel = () => {
          job.listeners.delete(listener); listener.cleanup(); reject(new DOMException("Aborted", "AbortError"));
          if (!job.listeners.size) { job.controller.abort(); if (jobs.get(key) === job) jobs.delete(key); }
        };
        const listener = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel) };
        job.listeners.add(listener); signal?.addEventListener("abort", cancel, { once: true });
      });
      drain(); return promise;
    }
    return { get };
  }
  function allowedUrl(value, host, prefix) {
    try { const u = new URL(value); return u.protocol === "https:" && u.hostname === host && !u.username && !u.password && u.pathname.startsWith(prefix); } catch { return false; }
  }
  function validPhoto(p) {
    const thumbnail = value => ["upload.wikimedia.org", "thumb.wikimedia.org"].some(host => allowedUrl(value, host, "/wikipedia/commons/"));
    return !!p && thumbnail(p.thumbnail) && (!p.largeThumbnail || thumbnail(p.largeThumbnail))
      && allowedUrl(p.sourceUrl, "commons.wikimedia.org", "/wiki/File:")
      && allowedUrl(p.licenseUrl, "creativecommons.org", "/")
      && ["author", "license", "title", "displayNote"].every(k => typeof p[k] === "string" && p[k].length > 0)
      && typeof p.nearby === "boolean";
  }
  const api = { hints, payload, createService, validPhoto };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PlacePhotos = api;
  if (typeof document === "undefined") return;

  const element = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
  const link = (url, text) => { const a = element("a", text); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };
  function credit(photo) {
    const caption = element("figcaption", "", "place-photo-credit");
    caption.append(element("span", `${photo.nearby ? "周辺の写真 · " : ""}${photo.author}`), document.createTextNode(" · "),
      link(photo.licenseUrl, photo.license), document.createTextNode(" · "), link(photo.sourceUrl, "出典"));
    if (photo.attribution) caption.append(element("span", photo.attribution, "place-photo-attribution"));
    if (photo.credit) caption.append(element("span", photo.credit, "place-photo-attribution"));
    caption.append(element("span", photo.displayNote, "place-photo-attribution"));
    if (allowedUrl(photo.categoryUrl, "commons.wikimedia.org", "/wiki/Category:")) caption.append(link(photo.categoryUrl, "施設の写真一覧"));
    return caption;
  }
  let dialog, returnFocus;
  function enlarge(photo, place) {
    if (!dialog) {
      dialog = element("dialog", "", "photo-dialog"); dialog.setAttribute("aria-labelledby", "photo-dialog-title"); document.body.append(dialog);
      dialog.addEventListener("close", () => { dialog.replaceChildren(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      dialog.addEventListener("keydown", event => event.stopPropagation());
    }
    returnFocus = document.activeElement;
    const header = element("div", "", "photo-dialog-header"), title = element("h2", place.name); title.id = "photo-dialog-title";
    const close = element("button", "閉じる"); close.type = "button"; close.onclick = () => dialog.close(); header.append(title, close);
    const figure = element("figure"), img = element("img"); img.referrerPolicy = "no-referrer"; img.src = photo.largeThumbnail || photo.thumbnail; img.alt = `${photo.nearby ? "周辺の写真：" : ""}${place.name}`;
    img.addEventListener("error", () => img.replaceWith(element("p", "写真を読み込めませんでした。")), { once: true });
    figure.append(img, credit(photo)); dialog.replaceChildren(header, figure); dialog.showModal();
  }
  let offlineUntil = 0;
  function photoError(code) { return Object.assign(new Error(code), { photoCode: code }); }
  const sessionCache = (() => { try { return sessionStorage; } catch { return null; } })();
  const service = createService({ storage: sessionCache, request: async (data, signal) => {
    if (Date.now() < offlineUntil) throw photoError("PhotoServiceMissing");
    const configured = document.querySelector('meta[name="walking-map-api"]')?.content;
    const base = configured ? new URL(configured, location.href) : ["localhost", "127.0.0.1"].includes(location.hostname) && location.protocol === "http:"
      ? new URL("http://127.0.0.1:8000/api/overpass") : new URL("/api/overpass", location.href);
    const url = new URL("place-photo", base);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal });
      if (response.status === 404 || response.headers.get("X-Walking-Map") !== "1") throw photoError("PhotoServiceMissing");
      const result = await response.json();
      if (!response.ok) throw photoError(["PhotoBusy", "PhotoTimeout", "PhotoLimit", "PhotoInput"].includes(result.code) ? result.code : "PhotoUnavailable");
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      // An upstream failure for one destination must not suppress other cards.
      if (error instanceof TypeError || error.photoCode === "PhotoServiceMissing") {
        offlineUntil = Date.now() + 15000;
        throw photoError("PhotoServiceMissing");
      }
      throw error;
    }
  } });
  const cards = new Map();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = cards.get(entry.target); if (!state) continue;
      state.visible = entry.isIntersecting;
      if (state.visible) load(entry.target, state);
      else { state.controller?.abort(); state.controller = null; }
    }
  });
  function placeholder(figure, place, text, error = false) {
    const fallback = element("div", "", "place-photo-placeholder");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), use = document.createElementNS(svg.namespaceURI, "use");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "icon"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.5"); svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", `#i-${({park:"tree", forest:"tree", mountain:"mountain", cherry_blossom:"leaf", autumn_leaves:"leaf", culture:"bookmark"})[place.kindId] || "pin"}`); svg.append(use);
    fallback.append(svg, element("span", text)); figure.replaceChildren(fallback);
    if (error) {
      const retry = element("button", "写真を再取得", "photo-retry"); retry.type = "button";
      retry.onclick = () => { const state = cards.get(figure); if (!state) return; offlineUntil = 0; state.done = false; state.refresh = true; state.reuseMetadata = !!state.retryReuseMetadata; load(figure, state); };
      figure.append(retry);
    }
  }
  function load(figure, state) {
    if (!state.visible || state.done || state.controller || document.hidden || !figure.isConnected) return;
    const controller = new AbortController(); state.controller = controller;
    placeholder(figure, state.place, "写真を確認中…"); figure.setAttribute("aria-busy", "true");
    const pending = service.get(state.place, controller.signal, { refresh: !!state.refresh, reuseMetadata: !!state.reuseMetadata }); state.refresh = false; state.reuseMetadata = false;
    pending.then(result => {
      if (controller.signal.aborted || !figure.isConnected) return;
      state.done = true;
      state.retryReuseMetadata = false;
      if (!result.photo) { placeholder(figure, state.place, "写真なし", true); return; }
      const photo = result.photo, button = element("button", "", "place-photo-open"), img = element("img");
      button.type = "button"; button.setAttribute("aria-label", `${state.place.name}${photo.nearby ? "周辺" : ""}の写真を拡大`);
      // IntersectionObserver already gates visible cards: a second lazy gate
      // can postpone the actual download after the metadata has arrived.
      img.loading = "eager"; img.decoding = "async"; img.width = 320; img.height = 180; img.alt = `${photo.nearby ? "周辺の写真：" : ""}${state.place.name}`; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => { if (figure.isConnected) placeholder(figure, state.place, "写真なし（読み込み失敗）", true); }, { once: true });
      img.src = photo.thumbnail; button.append(img); button.onclick = () => enlarge(photo, state.place);
      figure.replaceChildren(button, credit(photo));
    }).catch(error => {
      if (!controller.signal.aborted && figure.isConnected) {
        state.done = true;
        state.retryReuseMetadata = ["PhotoTimeout","PhotoLimit","PhotoUnavailable"].includes(error.photoCode) || error.name === "AbortError";
        const label = error.photoCode === "PhotoServiceMissing" ? "写真用サーバーに接続できません"
          : error.photoCode === "PhotoBusy" ? "写真の取得先が混み合っています"
            : error.photoCode === "PhotoLimit" ? "写真の確認を完了できませんでした"
            : error.photoCode === "PhotoTimeout" || error.name === "AbortError" ? "写真の取得がタイムアウトしました"
              : "写真を取得できませんでした";
        placeholder(figure, state.place, label, true);
      }
    }).finally(() => { if (state.controller === controller) { state.controller = null; figure.removeAttribute("aria-busy"); } });
  }
  api.mount = (container, place) => {
    const data = payload(place), key = JSON.stringify(data);
    let figure = [...container.children].find(e => e.classList.contains("place-photo"));
    if (figure && cards.get(figure)?.key === key) return figure;
    if (figure) { cards.get(figure)?.controller?.abort(); observer.unobserve(figure); cards.delete(figure); figure.remove(); }
    figure = element("figure", "", "place-photo"); placeholder(figure, place, "写真なし");
    cards.set(figure, { place: { ...data, kindId: place.kindId }, key, visible: false, done: false, controller: null });
    if (container.tagName === "DETAILS") container.append(figure); else container.prepend(figure);
    observer.observe(figure); return figure;
  };
  new MutationObserver(() => {
    for (const [figure, state] of cards) if (!figure.isConnected) { state.controller?.abort(); observer.unobserve(figure); cards.delete(figure); }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => {
    for (const [figure, state] of cards) {
      if (document.hidden) { state.controller?.abort(); state.controller = null; }
      else load(figure, state);
    }
  });
})(globalThis);
