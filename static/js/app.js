const map = L.map("map", {
  dragging: true,
  scrollWheelZoom: false,
  zoomSnap: 0,
  minZoom: 0,
  maxZoom: 19,
  bounceAtZoomLimits: false,
  fadeAnimation: false,
}).setView([35.681236, 139.767125], 13);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

let pendingX = 0;
let pendingY = 0;
let panScheduled = false;
let pendingZoomDelta = 0;
let zoomPoint;
let zoomAnchor = null;
let zoomFrame = null;
let zoomEndTimer;
let zooming = false;
let wheelZooming = false;

function applyZoom() {
  zoomFrame = null;
  if ((zooming && !wheelZooming) || pendingZoomDelta === 0) return;

  const zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(),
    map.getZoom() + pendingZoomDelta));
  pendingZoomDelta = 0;
  if (zoom === map.getZoom()) return;

  if (!zoomAnchor) zoomAnchor = map.containerPointToLatLng(zoomPoint);
  const offset = zoomPoint.subtract(map.getSize().divideBy(2));
  const center = map.unproject(map.project(zoomAnchor, zoom).subtract(offset), zoom);

  // Use Leaflet 1.9.4's native pinch path: update every frame without clearing tiles.
  if (!wheelZooming) {
    map._stop();
    wheelZooming = true;
    map._moveStart(true, false);
  }
  map._move(center, zoom, { pinch: true, round: false });
}

function finishZoom() {
  if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
  applyZoom();
  if (!wheelZooming) return;

  wheelZooming = false;
  zoomAnchor = null;
  // Finish the tile update and release retained tiles after the gesture ends.
  map.fire("viewreset");
  map._moveEnd(true);
}

function scheduleZoom() {
  if (zoomFrame === null) zoomFrame = requestAnimationFrame(applyZoom);
  clearTimeout(zoomEndTimer);
  zoomEndTimer = setTimeout(finishZoom, 120);
}

map.on("zoomstart", () => {
  zooming = true;
});

map.on("zoomend", () => {
  zooming = false;
  if (pendingZoomDelta !== 0) scheduleZoom();
});

map.getContainer().addEventListener("wheel", (event) => {
  event.preventDefault();

  const size = map.getSize();
  if (event.ctrlKey) {
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.y : 1;
    pendingZoomDelta -= Math.max(-100, Math.min(100, event.deltaY * scale)) * 0.01;
    const point = map.mouseEventToContainerPoint(event);
    if (!zoomPoint || !zoomPoint.equals(point)) zoomAnchor = null;
    zoomPoint = point;
    pendingX = 0;
    pendingY = 0;
    scheduleZoom();
    return;
  }

  pendingX += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.x : 1);
  pendingY += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.y : 1);

  if (panScheduled) return;
  panScheduled = true;

  requestAnimationFrame(() => {
    const x = Math.trunc(pendingX);
    const y = Math.trunc(pendingY);
    pendingX -= x;
    pendingY -= y;
    panScheduled = false;

    if (!zooming && (x !== 0 || y !== 0)) {
      map.panBy([x, y], { animate: false });
    }
  });
}, { passive: false });

// Place search and visit records. Records stay in this browser; only the search
// text is sent to Photon. Keep the endpoint here so it can be replaced easily.
const SEARCH_ENDPOINT = "https://photon.komoot.io/api/";
const SEARCH_LIMIT = 15;
const countryNames = new Intl.DisplayNames(["ja"], { type: "region", fallback: "none" });
const VISITS_KEY = "walking.visits.v1";
const ui = Object.fromEntries([
  "search-form", "search-input", "search-button", "search-status", "search-results",
  "place-editor", "selected-address", "visit-form", "visit-name", "visit-date",
  "visit-note", "save-button", "cancel-selection", "visit-status", "undo-delete",
  "visits-list", "visits-empty", "visit-count",
].map((id) => [id, document.getElementById(id)]));
const savedMarkers = L.layerGroup().addTo(map);
const searchCache = new Map();
let selectedPlace = null;
let selectedVisitId = null;
let selectionMarker = null;
let lastDeleted = null;
let searchTimer = null;
let activeSearch = null;
let searchComposing = false;
let lastSearchAt = -Infinity;
let storageReadable = true;
const appShell = document.querySelector(".app-shell");
const searchPanel = document.getElementById("search-panel");
const panelToggle = document.getElementById("panel-toggle");
const panelChevron = panelToggle.querySelector(".panel-chevron");
let panelDrag = null;
let suppressPanelClick = false;

function panelIsOpen() {
  return appShell.classList.contains("panel-open");
}

function setDrawerOffset(offset) {
  appShell.style.setProperty("--drawer-offset", `${offset}px`);
}

function releasePanelDrag() {
  const drag = panelDrag;
  panelDrag = null;
  appShell.classList.remove("panel-dragging");
  if (drag && panelToggle.hasPointerCapture(drag.pointerId)) {
    panelToggle.releasePointerCapture(drag.pointerId);
  }
}

function setPanelOpen(open, focus = true) {
  releasePanelDrag();
  const focusWasInside = searchPanel.contains(document.activeElement);
  clearTimeout(zoomEndTimer);
  finishZoom();
  searchPanel.toggleAttribute("inert", !open);
  searchPanel.setAttribute("aria-hidden", String(!open));
  appShell.classList.toggle("panel-open", open);
  setDrawerOffset(open ? searchPanel.getBoundingClientRect().width : 0);
  panelToggle.setAttribute("aria-expanded", String(open));
  panelChevron.textContent = open ? "‹" : "›";
  panelToggle.setAttribute("aria-label", open ? "場所を登録：閉じる" : "場所を登録：開く");
  panelToggle.title = open ? "左に引っ張ると閉じます" : "右に引っ張ると開きます";
  if (!open && focusWasInside) panelToggle.focus({ preventScroll: true });
  // Leaflet needs the new container size to fill the area and retain its center.
  requestAnimationFrame(() => {
    map.invalidateSize({ animate: false, debounceMoveend: true });
    if (open && panelIsOpen() && focus) {
      ui[selectedPlace ? "visit-name" : "search-input"].focus({ preventScroll: true });
    }
  });
}

panelToggle.addEventListener("click", (event) => {
  if (suppressPanelClick) {
    suppressPanelClick = false;
    event.preventDefault();
    return;
  }
  setPanelOpen(!panelIsOpen());
});

panelToggle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.isPrimary === false || panelDrag) return;
  event.preventDefault();
  panelToggle.focus({ preventScroll: true });
  clearTimeout(zoomEndTimer);
  finishZoom();
  const width = searchPanel.getBoundingClientRect().width;
  panelDrag = { pointerId: event.pointerId, startX: event.clientX,
    wasOpen: panelIsOpen(), width, offset: panelIsOpen() ? width : 0, moved: false };
  appShell.classList.add("panel-dragging");
  panelToggle.setPointerCapture(event.pointerId);
});

panelToggle.addEventListener("pointermove", (event) => {
  if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
  const distance = event.clientX - panelDrag.startX;
  panelDrag.moved ||= Math.abs(distance) > 5;
  panelDrag.offset = Math.max(0, Math.min(panelDrag.width,
    (panelDrag.wasOpen ? panelDrag.width : 0) + distance));
  setDrawerOffset(panelDrag.offset);
});

panelToggle.addEventListener("pointerup", (event) => {
  if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
  const drag = panelDrag;
  releasePanelDrag();
  if (!drag.moved) {
    setDrawerOffset(drag.wasOpen ? drag.width : 0);
    return; // A tap is handled by the normal click event.
  }
  const distance = event.clientX - drag.startX;
  const open = Math.abs(distance) >= 36 ? distance > 0 : drag.offset >= drag.width / 2;
  suppressPanelClick = true;
  setTimeout(() => { suppressPanelClick = false; }, 0);
  setPanelOpen(open);
});

function cancelPanelDrag(event) {
  if (!panelDrag || panelDrag.pointerId !== event.pointerId) return;
  setPanelOpen(panelDrag.wasOpen, false);
}
panelToggle.addEventListener("pointercancel", cancelPanelDrag);
panelToggle.addEventListener("lostpointercapture", cancelPanelDrag);
window.addEventListener("resize", () => setPanelOpen(panelIsOpen(), false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (panelIsOpen() || panelDrag)) {
    event.preventDefault();
    setPanelOpen(false);
  }
});

function message(target, text, error = false) {
  target.textContent = text;
  target.classList.toggle("error", error);
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && localDate(new Date(`${value}T00:00:00`)) === value;
}

function validCoordinates(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function loadVisits() {
  try {
    const raw = localStorage.getItem(VISITS_KEY);
    if (raw === null) return [];
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.visits)) throw new Error("Invalid records");
    const ids = new Set();
    for (const visit of data.visits) {
      if (!visit || typeof visit.id !== "string" || ids.has(visit.id)
        || typeof visit.name !== "string" || !visit.name.trim() || visit.name.length > 120
        || typeof visit.note !== "string" || visit.note.length > 1000
        || typeof visit.address !== "string" || !validDate(visit.date)
        || !validCoordinates(visit.lat, visit.lng)) throw new Error("Invalid record");
      ids.add(visit.id);
    }
    return data.visits;
  } catch {
    storageReadable = false;
    ui["save-button"].disabled = true;
    message(ui["visit-status"], "保存データを読み込めません。ブラウザの保存設定を確認してください。既存のデータは上書きしていません。", true);
    return [];
  }
}

let visits = loadVisits();

function persistVisits(next) {
  if (!storageReadable) return false;
  try {
    localStorage.setItem(VISITS_KEY, JSON.stringify({ version: 1, visits: next }));
    visits = next;
    renderVisits();
    return true;
  } catch {
    message(ui["visit-status"], "保存できませんでした。ブラウザの保存設定や空き容量を確認してください。", true);
    return false;
  }
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function placeButton(place, detail, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.append(textElement("strong", place.name, "place-title"),
    textElement("span", detail, "place-detail"));
  return button;
}

function focusPlace(place) {
  clearTimeout(zoomEndTimer);
  finishZoom();
  pendingX = pendingY = 0;
  const zoom = Math.max(map.getZoom(), 16);
  const zoomChanged = zoom !== map.getZoom();
  // Reuse the pinch path to move immediately without clearing loaded tiles.
  if (map._animatingZoom) map._onZoomTransitionEnd();
  map._stop();
  map._moveStart(zoomChanged, false);
  map._move(L.latLng(place.lat, place.lng), zoom, { pinch: true, round: false });
  map.fire("viewreset");
  map._moveEnd(zoomChanged);
}

function clearSelection() {
  if (selectionMarker) selectionMarker.remove();
  selectionMarker = null;
  selectedPlace = null;
  selectedVisitId = null;
  ui["place-editor"].hidden = true;
  ui["visit-form"].reset();
}

function selectPlace(place, visit = null, moveMap = true) {
  setPanelOpen(true, false);
  clearSelection();
  selectedPlace = place;
  selectedVisitId = visit ? visit.id : null;
  ui["place-editor"].hidden = false;
  ui["selected-address"].textContent = place.address || "";
  ui["selected-address"].hidden = !place.address;
  ui["visit-name"].value = place.name;
  ui["visit-date"].value = visit ? visit.date : localDate();
  ui["visit-note"].value = visit ? visit.note : "";
  ui["save-button"].textContent = visit ? "更新" : "保存";
  selectionMarker = L.circleMarker([place.lat, place.lng], {
    radius: 10, color: "#fff", weight: 3, fillColor: "#d69a32",
    fillOpacity: 1, bubblingMouseEvents: false,
  }).addTo(map);
  if (moveMap) focusPlace(place);
  ui["place-editor"].scrollIntoView({ behavior: "instant", block: "nearest" });
  ui["visit-name"].focus({ preventScroll: true });
}

function renderVisits() {
  savedMarkers.clearLayers();
  ui["visits-list"].replaceChildren();
  ui["visit-count"].textContent = `${visits.length}件`;
  ui["visits-empty"].hidden = visits.length > 0;
  const ordered = [...visits].sort((a, b) => b.date.localeCompare(a.date));
  for (const visit of ordered) {
    const popup = document.createElement("div");
    popup.append(textElement("strong", visit.name), textElement("p", `訪問日：${visit.date}`));
    if (visit.note) popup.append(textElement("p", visit.note, "popup-note"));
    const marker = L.circleMarker([visit.lat, visit.lng], {
      radius: 8, color: "#fff", weight: 2, fillColor: "#28694f",
      fillOpacity: 1, bubblingMouseEvents: false,
    }).addTo(savedMarkers).bindPopup(popup, { autoPan: false });
    if (visit.note.trim()) {
      marker.bindTooltip(textElement("span", visit.note), {
        permanent: true,
        direction: "top",
        offset: [0, -10],
        className: "visit-comment",
        opacity: 1,
      });
    } else {
      marker.bindTooltip(textElement("span", visit.name));
    }
    const item = document.createElement("li");
    item.className = "visit-card";
    const button = placeButton(visit, `${visit.date}${visit.address ? ` · ${visit.address}` : ""}`, "visit-button");
    button.addEventListener("click", () => { focusPlace(visit); marker.openPopup(); });
    item.append(button);
    if (visit.note) item.append(textElement("p", visit.note, "visit-note"));
    const actions = document.createElement("div");
    actions.className = "visit-actions";
    const edit = textElement("button", "編集", "secondary");
    edit.type = "button";
    edit.setAttribute("aria-label", `${visit.name}の記録を編集`);
    edit.addEventListener("click", () => selectPlace(visit, visit));
    const remove = textElement("button", "削除", "secondary");
    remove.type = "button";
    remove.setAttribute("aria-label", `${visit.name}の記録を削除`);
    remove.addEventListener("click", () => {
      if (!persistVisits(visits.filter((entry) => entry.id !== visit.id))) return;
      lastDeleted = visit;
      ui["undo-delete"].hidden = false;
      if (selectedVisitId === visit.id) clearSelection();
      message(ui["visit-status"], `「${visit.name}」の記録を削除しました。`);
    });
    actions.append(edit, remove);
    item.append(actions);
    ui["visits-list"].append(item);
  }
}

function japaneseCountry(properties) {
  const code = typeof properties.countrycode === "string"
    ? properties.countrycode.trim().toUpperCase() : "";
  if (/^[A-Z]{2}$/.test(code)) {
    const name = countryNames.of(code);
    if (name) return name;
  }
  return typeof properties.country === "string" ? properties.country : "";
}

function photonPlaces(data) {
  if (!data || !Array.isArray(data.features)) throw new Error("Invalid search response");
  const seen = new Set();
  return data.features.flatMap((feature) => {
    const p = feature.properties || {};
    const coordinates = feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || !validCoordinates(coordinates[1], coordinates[0])) return [];
    const [lng, lat] = coordinates;
    const address = [...new Set([japaneseCountry(p), p.state, p.city, p.district,
      p.locality, p.street, p.housenumber].filter((value) => typeof value === "string" && value))].join("、");
    const name = String(p.name || p.street || p.city || address || "名前のない場所").slice(0, 120);
    const key = `${lat},${lng},${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, address, lat, lng }];
  }).slice(0, SEARCH_LIMIT);
}

function renderSearch(places) {
  ui["search-results"].replaceChildren();
  for (const place of places) {
    const item = document.createElement("li");
    const button = placeButton(place, place.address, "result-button");
    button.addEventListener("click", () => selectPlace(place));
    item.append(button);
    ui["search-results"].append(item);
  }
  message(ui["search-status"], places.length
    ? `${places.length}件`
    : "見つかりませんでした。市区町村も入れて検索するか、地図をクリックして選んでください。");
}

function clearSearchDisplay() {
  ui["search-results"].replaceChildren();
  message(ui["search-status"], "");
}

function setSearchBusy(busy) {
  ui["search-button"].disabled = busy;
  ui["search-button"].setAttribute("aria-label", busy ? "検索中" : "検索");
  if (busy) ui["search-form"].setAttribute("aria-busy", "true");
  else ui["search-form"].removeAttribute("aria-busy");
}

function cancelSearch() {
  clearTimeout(searchTimer);
  searchTimer = null;
  const previous = activeSearch;
  activeSearch = null;
  if (previous) {
    clearTimeout(previous.timeout);
    previous.controller.abort();
  }
  setSearchBusy(false);
}

function scheduleSearch(delay = 350) {
  cancelSearch();
  clearSearchDisplay();
  const query = ui["search-input"].value.trim();
  if (!query) return;
  if (searchCache.has(query)) { renderSearch(searchCache.get(query)); return; }
  // Wait briefly for typing to pause, and keep requests at least one second apart.
  const wait = Math.max(delay, 1000 - (Date.now() - lastSearchAt));
  searchTimer = setTimeout(() => searchPlaces(query), wait);
}

async function searchPlaces(query) {
  searchTimer = null;
  if (ui["search-input"].value.trim() !== query) return;
  const controller = new AbortController();
  const request = { controller, timeout: setTimeout(() => controller.abort(), 12000) };
  activeSearch = request;
  const isCurrent = () => activeSearch === request
    && ui["search-input"].value.trim() === query;
  lastSearchAt = Date.now();
  setSearchBusy(true);
  message(ui["search-status"], "場所を検索しています…");
  try {
    const url = new URL(SEARCH_ENDPOINT);
    // The public server supports "default", de, en and fr, but rejects "ja".
    // Local names give Japanese addresses in Japan; country codes are localized above.
    url.search = new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT), lang: "default" }).toString();
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Search failed: ${response.status}`);
    const places = photonPlaces(await response.json());
    if (!isCurrent()) return;
    searchCache.set(query, places);
    renderSearch(places);
  } catch (error) {
    if (isCurrent()) {
      message(ui["search-status"], error.name === "AbortError"
        ? "検索に時間がかかっています。少し待ってから再検索してください。"
        : "検索できませんでした。通信を確認して再検索するか、地図をクリックして場所を選んでください。", true);
    }
  } finally {
    clearTimeout(request.timeout);
    if (activeSearch === request) {
      activeSearch = null;
      setSearchBusy(false);
    }
  }
}

ui["search-input"].addEventListener("compositionstart", () => {
  searchComposing = true;
  cancelSearch();
  clearSearchDisplay();
});
ui["search-input"].addEventListener("compositionend", () => {
  searchComposing = false;
  scheduleSearch();
});
ui["search-input"].addEventListener("input", () => scheduleSearch());
ui["search-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (!searchComposing) scheduleSearch(0);
});

ui["visit-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (!selectedPlace || !ui["visit-form"].reportValidity()) return;
  const name = ui["visit-name"].value.trim();
  const date = ui["visit-date"].value;
  const note = ui["visit-note"].value.trim();
  if (!name || name.length > 120 || note.length > 1000 || !validDate(date)) {
    message(ui["visit-status"], "場所の名前と訪問日を確認してください。", true);
    return;
  }
  const duplicate = visits.find((visit) => visit.id !== selectedVisitId && visit.date === date
    && Math.abs(visit.lat - selectedPlace.lat) < 0.00001
    && Math.abs(visit.lng - selectedPlace.lng) < 0.00001);
  if (duplicate) {
    message(ui["visit-status"], "この場所は同じ日付で記録済みです。一覧の「編集」から変更できます。", true);
    return;
  }
  const editing = selectedVisitId !== null;
  const id = selectedVisitId || (crypto.randomUUID
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const visit = { id, name, date, note, address: selectedPlace.address,
    lat: selectedPlace.lat, lng: selectedPlace.lng };
  const next = editing ? visits.map((entry) => entry.id === id ? visit : entry) : [...visits, visit];
  if (!persistVisits(next)) return;
  lastDeleted = null;
  ui["undo-delete"].hidden = true;
  clearSelection();
  message(ui["visit-status"], `「${name}」の記録を${editing ? "更新" : "保存"}しました。`);
});

ui["cancel-selection"].addEventListener("click", clearSelection);
ui["undo-delete"].addEventListener("click", () => {
  if (!lastDeleted || !persistVisits([...visits, lastDeleted])) return;
  message(ui["visit-status"], "削除した記録を元に戻しました。");
  lastDeleted = null;
  ui["undo-delete"].hidden = true;
});
map.on("click", ({ latlng }) => {
  selectPlace({ name: "", address: "", lat: latlng.lat,
    lng: ((latlng.lng + 180) % 360 + 360) % 360 - 180 }, null, false);
});
renderVisits();
