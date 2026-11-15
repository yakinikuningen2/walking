// Fetch road distances only for visible cards. Never substitute crow-flight estimates.
((root) => {
  "use strict";
  function create({ route, timeout = 7000, ttl = 300000, limit = 100 }) {
    const cache = new Map(), jobs = new Map(), queue = [];
    let running = false;
    const abortError = () => new DOMException("Aborted", "AbortError");
    function key(start, end, speed) {
      return [start.lat, start.lng, end.lat, end.lng, speed].join(",");
    }
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (queue.length) {
          const job = queue.shift();
          if (!job.listeners.size) continue;
          let timer, onAbort;
          try {
            const cancelled = new Promise((_, reject) => {
              onAbort = () => reject(abortError());
              job.controller.signal.addEventListener("abort", onAbort, { once: true });
              timer = setTimeout(() => job.controller.abort(), timeout);
            });
            const result = await Promise.race([route(job.start, job.end, job.speed, job.controller.signal), cancelled]);
            if (job.controller.signal.aborted) throw abortError();
            if (!Number.isFinite(result?.distance) || result.distance < 0 || !Number.isFinite(result.duration) || result.duration < 0) throw Error("Invalid route metrics");
            const metrics = { distance: result.distance, duration: result.duration };
            cache.set(job.key, { result: metrics, at: Date.now() });
            while (cache.size > limit) cache.delete(cache.keys().next().value);
            for (const listener of job.listeners) listener.resolve(metrics);
          } catch (error) {
            for (const listener of job.listeners) listener.reject(error);
          } finally {
            clearTimeout(timer);
            job.controller.signal.removeEventListener("abort", onAbort);
            if (jobs.get(job.key) === job) jobs.delete(job.key);
            for (const listener of job.listeners) listener.cleanup();
          }
        }
      } finally { running = false; }
    }
    function get(start, end, speed, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      const id = key(start, end, speed), hit = cache.get(id);
      if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.result);
      cache.delete(id);
      let job = jobs.get(id);
      if (!job || job.controller.signal.aborted) {
        job = { key: id, start: { ...start }, end: { ...end }, speed, controller: new AbortController(), listeners: new Set() };
        jobs.set(id, job); queue.push(job);
      }
      const pending = new Promise((resolve, reject) => {
        const cancel = () => {
          job.listeners.delete(listener); listener.cleanup(); reject(abortError());
          if (!job.listeners.size) { job.controller.abort(); if (jobs.get(id) === job) jobs.delete(id); }
        };
        const listener = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel) };
        job.listeners.add(listener);
        signal?.addEventListener("abort", cancel, { once: true });
      });
      void drain();
      return pending;
    }
    return { get };
  }
  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WalkingDistances = api;
})(globalThis);

if (typeof document !== "undefined") (() => {
  const service = WalkingDistances.create({ route: async (start, end, speed, signal) => {
    // Explicit navigation has priority over background card measurements.
    const request = { controller: new AbortController() };
    const abort = () => request.controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const result = await calculateWalkingRoute(start, end, "standard", speed, request);
      if (result.steps.some(step => step.mode !== "walking")) throw Error("Not a walking route");
      const first = result.points[0], last = result.points.at(-1);
      if (map.distance(first, start) > 100 || map.distance(last, end) > 100) throw Error("Route endpoint not reached");
      if (!routeAttributionAdded) {
        map.attributionControl.addAttribution('ルート: <a href="https://valhalla.openstreetmap.de/">Valhalla / FOSSGIS</a>');
        routeAttributionAdded = true;
      }
      return result;
    } finally { signal.removeEventListener("abort", abort); request.controller.abort(); }
  } });
  const cards = new Map();
  function context() {
    const start = getStartPoint(), speed = currentWalkingSpeed().kmh;
    return { start, speed, key: start ? `${start.lat.toFixed(4)},${start.lng.toFixed(4)},${speed}` : "" };
  }
  function update(element, state) {
    const current = context();
    if (current.key !== state.context) {
      state.controller?.abort(); state.controller = null; state.context = current.key; state.done = false;
      element.textContent = current.start ? "距離を確認中…" : "出発地点未設定";
    }
    if (document.hidden || !state.visible || state.done || state.controller || !current.start || routeRequest || (typeof WalkingTour !== "undefined" && WalkingTour.isBusy())) return;
    const place = element.walkingPlace;
    if (["forest", "waterside", "coast"].includes(place.kindId) && !discoveryNaturalPlaceReady(place)) {
      element.textContent = "徒歩アクセス未確認・距離は未取得"; state.done = true; return;
    }
    const controller = new AbortController(); state.controller = controller;
    service.get(current.start, place, current.speed, controller.signal).then(result => {
      if (controller.signal.aborted || !element.isConnected || context().key !== current.key) return;
      element.textContent = `距離 ${routeDistance(result.distance)}・徒歩約${routeDuration(result.duration)}`;
      state.done = true;
    }, error => {
      if (controller.signal.aborted || !element.isConnected || context().key !== current.key) return;
      element.textContent = error.routeCode === "NoRoute" || [170, 171, 441, 442].includes(Number(error.routeCode))
        ? "徒歩ルートが見つかりませんでした" : "距離を取得できませんでした";
      state.done = true;
    }).finally(() => { if (state.controller === controller) state.controller = null; });
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = cards.get(entry.target); if (!state) continue;
      state.visible = entry.isIntersecting;
      if (!state.visible) { state.controller?.abort(); state.controller = null; }
      else update(entry.target, state);
    }
  });
  function scan() {
    for (const [element, state] of cards) if (!element.isConnected) {
      state.controller?.abort(); observer.unobserve(element); cards.delete(element);
    }
    for (const element of document.querySelectorAll(".candidate-road-metrics")) if (element.walkingPlace && !cards.has(element)) {
      cards.set(element, { visible: false, context: null, done: false, controller: null }); observer.observe(element);
    }
  }
  const mutations = new MutationObserver(scan);
  for (const id of ["discovery-content", "search-results"]) {
    mutations.observe(document.getElementById(id), { childList: true, subtree: true });
  }
  scan();
  setInterval(() => {
    for (const [element, state] of cards) {
      if (document.hidden || routeRequest || (typeof WalkingTour !== "undefined" && WalkingTour.isBusy())) { state.controller?.abort(); state.controller = null; }
      else if (state.visible) update(element, state);
    }
  }, 1000);
})();
