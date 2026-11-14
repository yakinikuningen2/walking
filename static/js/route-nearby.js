// Route corridor search. The destination and route are changed only by their existing controls.
const ROUTE_NEARBY_RADIUS = 300;
const routeNearbyCache = new Map();
const routeNearbyState = { route: null, last: null, intended: false, refresh: null, visible: 8, expanded: true, places: [] };

function routeNearbyWrap(lng) { return ((lng + 180) % 360 + 360) % 360 - 180; }
function routeNearbyCell(lat, lng) { return `${lat},${((lng + 3600) % 7200 + 7200) % 7200 - 3600}`; }

function routeNearbyPlan(points, radius = ROUTE_NEARBY_RADIUS) {
  if (!Array.isArray(points) || points.length < 2 || !points.every(p => Array.isArray(p) && validCoordinates(p[0], p[1]))) {
    throw new Error("Invalid walking route geometry");
  }
  const plan = { points: points.map(p => [p[0], routeNearbyWrap(p[1])]), cells: new Map(), segments: [], radius };
  let total = 0;
  for (let i = 1; i < plan.points.length; i++) {
    const a = plan.points[i - 1], b = plan.points[i], delta = routeNearbyWrap(b[1] - a[1]);
    const length = map.distance(a, b);
    if (!length) continue;
    const count = Math.max(1, Math.ceil(length / 1000), Math.ceil(Math.abs(delta) / .02), Math.ceil(Math.abs(b[0] - a[0]) / .01));
    for (let j = 0; j < count; j++) {
      const start = [a[0] + (b[0] - a[0]) * j / count, a[1] + delta * j / count];
      const end = [a[0] + (b[0] - a[0]) * (j + 1) / count, a[1] + delta * (j + 1) / count];
      const segment = { a: start, b: end, along: total + length * j / count, length: length / count };
      plan.segments.push(segment);
      // Extra coverage also makes small GPS-driven route changes reusable.
      const dy = (radius + 60) / 110000;
      const dx = dy / Math.max(.02, Math.cos(Math.max(Math.abs(start[0]), Math.abs(end[0])) * Math.PI / 180));
      for (let lat = Math.floor(Math.max(-90, Math.min(start[0], end[0]) - dy) * 20);
        lat <= Math.floor(Math.min(90, Math.max(start[0], end[0]) + dy) * 20); lat++) {
        for (let lng = Math.floor((Math.min(start[1], end[1]) - dx) * 20);
          lng <= Math.floor((Math.max(start[1], end[1]) + dx) * 20); lng++) {
          const key = routeNearbyCell(lat, lng);
          if (!plan.cells.has(key)) {
            const normalizedLng = Number(key.split(",")[1]);
            plan.cells.set(key, { bounds: [Math.max(-90, lat / 20), normalizedLng / 20, Math.min(90, (lat + 1) / 20), (normalizedLng + 1) / 20], segments: [] });
          }
          plan.cells.get(key).segments.push(segment);
        }
      }
    }
    total += length;
  }
  if (!plan.segments.length) throw new Error("Empty walking route");
  return plan;
}

function routeNearbyPosition(place, plan) {
  const cell = plan.cells.get(routeNearbyCell(Math.floor(place.lat * 20), Math.floor(routeNearbyWrap(place.lng) * 20)));
  let distance = Infinity, along = Infinity;
  const scale = Math.max(.0001, Math.cos(place.lat * Math.PI / 180));
  for (const segment of cell?.segments || []) {
    const ax = routeNearbyWrap(segment.a[1] - place.lng) * scale, ay = segment.a[0] - place.lat;
    const dx = (segment.b[1] - segment.a[1]) * scale, dy = segment.b[0] - segment.a[0];
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const nearest = [segment.a[0] + (segment.b[0] - segment.a[0]) * t, routeNearbyWrap(segment.a[1] + (segment.b[1] - segment.a[1]) * t)];
    const offset = map.distance([place.lat, place.lng], nearest);
    if (offset < distance - .001 || (Math.abs(offset - distance) <= .001 && segment.along + t * segment.length < along)) {
      distance = offset; along = segment.along + t * segment.length;
    }
  }
  return { distance, along };
}

function routeNearbyCovered(next, previous) {
  return next.segments.every(segment => {
    // With 20m spacing, the unsampled portion adds at most 10m to the
    // accepted 15m offset, staying inside the query's 60m safety margin.
    const count = Math.max(1, Math.ceil(segment.length / 20));
    for (let i = 0; i <= count; i++) {
      const place = { lat: segment.a[0] + (segment.b[0] - segment.a[0]) * i / count,
        lng: routeNearbyWrap(segment.a[1] + (segment.b[1] - segment.a[1]) * i / count) };
      if (routeNearbyPosition(place, previous).distance > 15) return false;
    }
    return true;
  });
}

function routeNearbySimplify(points) {
  // Iterative Douglas–Peucker in Mercator metres; retain full geometry for filtering.
  let previousLng;
  const projected = points.map(([lat, lng]) => {
    if (previousLng !== undefined) lng = previousLng + routeNearbyWrap(lng - previousLng);
    previousLng = lng;
    const angle = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return { x: lng * Math.PI / 180 * 6378137, y: Math.log(Math.tan(Math.PI / 4 + angle / 2)) * 6378137 };
  });
  const keep = new Uint8Array(points.length), stack = [[0, points.length - 1]];
  keep[0] = keep[points.length - 1] = 1;
  while (stack.length) {
    const [first, last] = stack.pop(), a = projected[first], b = projected[last];
    const dx = b.x - a.x, dy = b.y - a.y;
    let largest = 20 ** 2, selected = -1;
    for (let i = first + 1; i < last; i++) {
      const p = projected[i], t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const squared = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
      if (squared > largest) { largest = squared; selected = i; }
    }
    if (selected !== -1) { keep[selected] = 1; stack.push([first, selected], [selected, last]); }
  }
  return points.filter((_, index) => keep[index]);
}

function routeNearbyQueries(plan, kind) {
  const selectors = nearbyCategorySelectors(kind);
  if (!selectors.length) throw new Error("Invalid nearby category");
  const points = routeNearbySimplify(plan.points), queries = [];
  const restricted = ["toilet", "bus_stop"].includes(kind) ? "private|no|customers|permit|members|military" : "private|no|permit|members|military";
  const filters = `[access!~"^(${restricted})$"][opening_hours!="closed"][disused!="yes"][abandoned!="yes"]`;
  for (let first = 0; first < points.length - 1; first += 399) {
    const coordinates = points.slice(first, first + 400).flatMap(p => p.map(n => n.toFixed(6))).join(",");
    queries.push('[out:json][timeout:5][maxsize:16777216];('
      + selectors.map(selector => `${selector}${filters}(around:${plan.radius + 60},${coordinates});`).join("")
      + ');out body center qt 500;');
  }
  return queries;
}

function cancelRouteNearby(preserve = false) {
  clearTimeout(routeNearbyState.refresh);
  routeNearbyState.refresh = null;
  routeNearbyState.places = [];
  if (nearbyConvenienceRequest?.scope === "route") clearTimeout(nearbyConvenienceRequest.timeout);
  if (!preserve) { routeNearbyState.last = null; routeNearbyState.intended = false; routeNearbyState.visible = 8; }
}

function routeNearbyCurrent(request) {
  return nearbyConvenienceRequest === request && !request.controller.signal.aborted
    && routeChoices.get(activeRouteKind)?.route === request.route && ui["nearby-scope"].value === "route";
}

function routeNearbyPublish(request, elements = []) {
  if (!routeNearbyCurrent(request)) return;
  for (const element of elements) {
    const key = `${element.source || "osm"}/${element.type}/${element.id ?? `${element.lat},${element.lon}`}`;
    request.elements.set(key, element);
  }
  let pool = [...request.elements.values()];
  if (request.kind === "station" && request.access) {
    pool = pool.map(element => {
      const name = String(element.tags?.["name:ja"] || element.tags?.name || "").replace(/駅$/, "");
      const station = request.access.stations.find(s => s.name === name
        && map.distance([element.lat ?? element.center?.lat, element.lon ?? element.center?.lon], [s.lat, s.lng]) < 250);
      if (!station) return element;
      const entry = [...station.entrances].sort((a, b) => routeNearbyPosition(a, request.plan).distance - routeNearbyPosition(b, request.plan).distance)[0];
      return { ...element, lat: entry.lat, lon: entry.lng };
    });
  }
  const origin = { lat: request.plan.points[0][0], lng: request.plan.points[0][1] };
  const places = nearbyConveniencePlaces(pool, origin, request.kind, { plan: request.plan });
  routeNearbyState.last = { route: request.route, plan: request.plan, kind: request.kind, elements: pool, complete: !!request.complete, at: request.snapshotAt };
  showNearbyConvenience(places, request.kind, "route");
  message(ui["nearby-convenience-status"], `ルートから300m以内：${places.length}件${places.length === 200 ? "（表示上限）" : ""}${request.complete ? "" : "・検索中…"}`);
  return places;
}

async function routeNearbyLocal(request) {
  const plan = request.plan;
  if (request.kind === "toilet") {
    routeNearbyPublish(request, await localNearbyToilets({ bounds: "-90,-180,90,180" }, request));
    return;
  }
  if (!["station", "bus_stop"].includes(request.kind)) return;
  let count = 0;
  for (const cell of plan.cells.values()) {
    if (!routeNearbyCurrent(request)) throw new DOMException("Aborted", "AbortError");
    const area = { bounds: cell.bounds.map(n => n.toFixed(6)).join(",") };
    const elements = request.kind === "station" ? await localNearbyStations(area, request) : await localNearbyBusStops(area, request);
    for (const element of elements) request.elements.set(`${element.source}/${element.type}/${element.id}`, element);
    if (++count % 8 === 0) {
      routeNearbyPublish(request);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  routeNearbyPublish(request);
}

async function searchRouteNearby({ automatic = false } = {}) {
  const route = routeChoices.get(activeRouteKind)?.route;
  if (!route) { message(ui["nearby-convenience-status"], "徒歩ルートを表示してから検索できます。"); return; }
  clearNearbyConvenience({ preserveRoute: true });
  routeNearbyState.intended = true;
  if (!automatic) { routeNearbyState.visible = 8; routeNearbyState.expanded = true; }
  const request = { scope: "route", route, kind: ui["nearby-kind"].value, controller: new AbortController(), elements: new Map(), complete: false, snapshotAt: Date.now() };
  nearbyConvenienceRequest = request;
  ui["nearby-convenience"].disabled = true;
  ui["nearby-convenience"].setAttribute("aria-busy", "true");
  ui["clear-nearby-convenience"].hidden = false;
  message(ui["nearby-convenience-status"], "ルート沿いを検索中…");
  request.deadlineAt = Date.now() + 30000;
  request.timeout = setTimeout(() => { request.timedOut = true; request.controller.abort(); }, 30000);
  let incomplete = false;
  try {
    request.plan = routeNearbyPlan(route.points);
    if (request.kind === "station") request.access = await loadRouteAccess(request);
    const previous = routeNearbyState.last;
    if (previous?.complete && Date.now() - previous.at < 600000 && previous.kind === request.kind && routeNearbyCovered(request.plan, previous.plan)) {
      request.snapshotAt = previous.at;
      routeNearbyPublish(request, previous.elements);
    } else {
      let localComplete = true;
      try { await routeNearbyLocal(request); } catch (error) { if (request.controller.signal.aborted) throw error; localComplete = false; }
      if (request.timedOut) throw new DOMException("Timed out", "AbortError");
      if (!routeNearbyCurrent(request)) return;
      const local = routeNearbyPublish(request) || [];
      if (!localComplete || !local.length) {
        const jobs = routeNearbyQueries(request.plan, request.kind);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
          while (next < jobs.length && routeNearbyCurrent(request)) {
            const query = jobs[next++], key = `${request.kind}:${query}`;
            try {
              let cached = routeNearbyCache.get(key);
              if (!cached || Date.now() - cached.at > 600000) {
                const elements = await fetchDiscoveryMapData(query, request, 6000, false, { providerDelayMs: 1000, ignoreCooldown: true });
                if (!routeNearbyCurrent(request)) return;
                cached = { at: Date.now(), elements };
                if (routeNearbyCache.size >= 20) routeNearbyCache.delete(routeNearbyCache.keys().next().value);
                routeNearbyCache.set(key, cached);
              }
              request.snapshotAt = Math.min(request.snapshotAt, cached.at);
              incomplete ||= cached.elements.length >= 500;
              routeNearbyPublish(request, cached.elements);
            } catch (error) {
              if (request.controller.signal.aborted) throw error;
              incomplete = true;
            }
          }
        }));
      }
    }
    if (request.timedOut) throw new DOMException("Timed out", "AbortError");
    if (!routeNearbyCurrent(request)) return;
    request.complete = !incomplete;
    const places = routeNearbyPublish(request) || [];
    message(ui["nearby-convenience-status"], incomplete
      ? (places.length ? `${places.length}件を表示・一部の検索を完了できませんでした。` : "検索先から取得できませんでした。再度お試しください。")
      : places.length ? `ルートから300m以内：${places.length}件${places.length === 200 ? "（表示上限）" : ""}` : "ルートから300m以内の候補は地図データにありませんでした。", incomplete && !places.length);
  } catch (error) {
    if (nearbyConvenienceRequest === request && (!request.controller.signal.aborted || request.timedOut)) {
      if (routeNearbyState.last?.route === route) routeNearbyState.last.complete = false;
      message(ui["nearby-convenience-status"], routeNearbyState.places.length
        ? `${routeNearbyState.places.length}件を表示・検索の一部が時間切れになりました。`
        : "ルート周辺の検索を完了できませんでした。再度お試しください。", !routeNearbyState.places.length);
    }
  } finally {
    clearTimeout(request.timeout);
    if (nearbyConvenienceRequest === request) {
      nearbyConvenienceRequest = null;
      ui["nearby-convenience"].disabled = false;
      ui["nearby-convenience"].removeAttribute("aria-busy");
    }
  }
}

function renderRouteNearbyResults(places, scope) {
  if (scope !== "route") { routeNearbyState.places = []; ui["nearby-results-panel"].hidden = true; return; }
  const wasHidden = ui["nearby-results-panel"].hidden;
  routeNearbyState.places = places;
  ui["nearby-results-panel"].hidden = !places.length;
  if (wasHidden && places.length) ui["nearby-results-panel"].open = routeNearbyState.expanded;
  ui["nearby-results-count"].textContent = `${places.length}件`;
  const top = ui["nearby-results"].scrollTop;
  const focused = ui["nearby-results"].contains(document.activeElement) ? document.activeElement.dataset.nearbyKey : null;
  const items = places.slice(0, routeNearbyState.visible).map(place => {
    const item = document.createElement("li"), button = textElement("button", "", "nearby-result-button");
    button.type = "button"; button.dataset.nearbyKey = nearbyMarkerKey(place);
    button.append(textElement("span", place.name, "place-title"), textElement("span", `${nearbyKindLabel(ui["nearby-kind"].value)} · ルートから約${Math.round(place.distanceFromRoute)}m`, "place-detail"));
    button.addEventListener("click", () => {
      focusPlace(place, { keepZoom: true });
      nearbyConvenienceMarkers.getLayers().find(m => m.options.nearbyKey === nearbyMarkerKey(place))?.openPopup();
    });
    item.append(button); return item;
  });
  ui["nearby-results"].replaceChildren(...items);
  ui["nearby-results"].scrollTop = top;
  if (focused) [...ui["nearby-results"].querySelectorAll("button")].find(b => b.dataset.nearbyKey === focused)?.focus({ preventScroll: true });
  ui["nearby-more"].hidden = places.length <= routeNearbyState.visible;
}

function syncNearbyRouteState({ background = false } = {}) {
  const route = routeChoices.get(activeRouteKind)?.route || null;
  ui["nearby-route-option"].disabled = !route;
  ui["route-detours-button"].disabled = !route;
  if (routeNearbyState.route !== route) {
    routeNearbyState.route = route;
    if (ui["nearby-scope"].value === "route") {
      const intended = routeNearbyState.intended;
      clearNearbyConvenience({ preserveRoute: true });
      if (!routeEnabled) {
        ui["nearby-scope"].value = "point"; routeNearbyState.intended = false;
      } else if (intended && route) {
        routeNearbyState.refresh = setTimeout(() => searchRouteNearby({ automatic: true }), background ? 700 : 0);
      }
    }
  }
  if (!nearbyConvenienceRequest) ui["nearby-convenience"].disabled = ui["nearby-scope"].value === "route" && !route;
  const label = nearbyKindLabel(ui["nearby-kind"].value);
  ui["nearby-convenience"].setAttribute("aria-label", `${ui["nearby-scope"].value === "route" ? "ルート沿いの" : "近くの"}${label}を探す`);
  ui["clear-nearby-convenience"].setAttribute("aria-label", `${label}の表示を消す`);
}

function initializeRouteNearby() {
  ui["nearby-scope"].addEventListener("change", () => {
    const hadSearch = Boolean(nearbyConvenienceRequest || !ui["clear-nearby-convenience"].hidden);
    clearNearbyConvenience(); syncNearbyRouteState();
    const label = nearbyKindLabel(ui["nearby-kind"].value);
    ui["nearby-convenience"].setAttribute("aria-label", `${ui["nearby-scope"].value === "route" ? "ルート沿いの" : "近くの"}${label}を探す`);
    if (hadSearch) searchNearbyConvenience();
  });
  ui["route-detours-button"].addEventListener("click", () => {
    ui["nearby-scope"].value = "route"; syncNearbyRouteState(); searchRouteNearby();
  });
  ui["nearby-more"].addEventListener("click", () => {
    routeNearbyState.visible += 8; renderRouteNearbyResults(routeNearbyState.places, "route");
  });
  ui["nearby-results-panel"].addEventListener("toggle", () => {
    if (!ui["nearby-results-panel"].hidden) routeNearbyState.expanded = ui["nearby-results-panel"].open;
  });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(entries => appShell.style.setProperty("--nearby-height", `${entries[0].contentRect.height}px`))
      .observe(document.querySelector(".nearby-convenience-controls"));
  }
  syncNearbyRouteState();
}

if (typeof document !== "undefined") initializeRouteNearby();
