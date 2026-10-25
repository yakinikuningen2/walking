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
const ROUTE_ENDPOINT = "https://valhalla1.openstreetmap.de/route";
const MAP_DATA_ENDPOINT = "https://overpass.private.coffee/api/interpreter";
const DISCOVERY_MAP_ENDPOINTS = [MAP_DATA_ENDPOINT, "https://overpass-api.de/api/interpreter"];
const DISCOVERY_MAP_TIMEOUT_MS = 60000;
const DISCOVERY_PROVIDER_DELAY_MS = 4000;
const discoveryMapProviders = DISCOVERY_MAP_ENDPOINTS.map(() => ({ retryAt: 0 }));
let preferredDiscoveryMapProvider = 0;
let lastDiscoveryMapError = null;
const configuredMapApi = document.querySelector('meta[name="walking-map-api"]')?.content;
const MAP_PROXY_ENDPOINT = configuredMapApi ? new URL(configuredMapApi, window.location.href).href
  : window.location.protocol === "http:" && ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:8000/api/overpass" : null;
let mapProxyRetryAt = 0;
// Allow for ordinary detours when estimating walks without a route request.
const DISCOVERY_DISTANCE_FACTOR = 1.3;
const DISCOVERY_KINDS = {
  places: { label: "散歩先", kinds: ["mountain", "forest", "waterside", "coast", "neighborhood", "park", "sightseeing"] },
  any: { label: "すべて", tags: null },
  mountain: { label: "山", tags: { natural: ["peak"] } },
  forest: { label: "森・林", tags: { natural: ["wood"] }, alternatives: [{ landuse: ["forest"] }, { boundary: ["forest"] }], geometry: true },
  waterside: { label: "川辺・湖畔", tags: { natural: ["water", "spring"] }, alternatives: [{ waterway: ["riverbank", "waterfall"] }], geometry: true },
  coast: { label: "海辺・浜辺", tags: { natural: ["beach", "coastline"] }, geometry: true },
  neighborhood: { label: "街並み・集落", tags: { place: ["neighbourhood", "quarter", "suburb", "village", "hamlet"] } },
  park: { label: "公園・緑地", tags: { leisure: ["park", "garden", "nature_reserve"] } },
  cafe: { label: "カフェ", tags: { amenity: ["cafe"] } },
  restaurant: { label: "食事", tags: { amenity: ["restaurant", "fast_food"] } },
  sightseeing: { label: "景色・観光", tags: { tourism: ["viewpoint", "attraction"] } },
  culture: { label: "美術館・博物館", tags: { tourism: ["museum", "gallery"] } },
  shrine: { label: "神社・寺院", tags: { amenity: ["place_of_worship"], religion: ["shinto", "buddhist"] } },
  shopping: { label: "買い物", tags: { shop: ["mall", "department_store", "supermarket"] } },
  convenience: { label: "コンビニ", tags: { shop: ["convenience"] } },
};
const DISCOVERY_MOOD_WORDS = { urban: ["都会", "都会寄り", "街中", "まちなか", "都市"], rural: ["田舎", "田舎寄り", "田園", "里山"], nature: ["自然", "自然が多い", "緑", "緑が多い"] };
const DISCOVERY_ELEVATION_WORDS = ["高台", "高原", "標高高め", "標高が高い", "標高が高め"];
const DISCOVERY_KIND_WORDS = { mountain: ["山", "山頂", "低山", "登山"], forest: ["森", "林", "森林"], waterside: ["川", "川辺", "川沿い", "河川敷", "水辺", "湖", "湖畔", "池", "滝"], coast: ["海", "海辺", "海岸", "浜辺", "砂浜"], neighborhood: ["街", "街並み", "住宅街", "集落"], park: ["公園", "緑地"], cafe: ["カフェ", "喫茶店", "コーヒー"], restaurant: ["食事", "ご飯", "ランチ"], sightseeing: ["観光", "景色", "絶景"], culture: ["美術館", "博物館"], shrine: ["神社", "寺院", "お寺"], shopping: ["買い物", "ショッピング"], convenience: ["コンビニ"] };
const WALKING_SETTINGS_KEY = "walking.preferences.v1";
const MIN_WALKING_SPEED = 2.5;
const MAX_WALKING_SPEED = 6.5;
const WALKING_SPEEDS = {
  slow: { label: "ゆっくり", kmh: 3 },
  normal: { label: "ふつう", kmh: 4 },
  fast: { label: "はやめ", kmh: 5.5 },
};
const ROUTE_KINDS = [
  { id: "standard", label: "基本のルート", detail: "", color: "#2476cf" },
  { id: "gentle", label: "坂道少なめ", detail: "坂道・階段をなるべく避けるルート", color: "#8250b5" },
  { id: "convenience", label: "コンビニが多い道", detail: "コンビニがある道を経由するルート", color: "#b96b16" },
  { id: "nature", label: "自然を楽しむ", detail: "公園・緑地内の歩道を経由するルート", color: "#41834b" },
];
const countryNames = new Intl.DisplayNames(["ja"], { type: "region", fallback: "none" });
const VISITS_KEY = "walking.visits.v1";
const DISCOVERY_HISTORY_KEY = "walking.discovery-history.v1";
const DISCOVERY_HISTORY_LIMIT = 10;
const ui = Object.fromEntries([
  "search-form", "search-input", "search-button", "search-status", "search-results",
  "place-editor", "selected-address", "visit-form", "visit-name", "visit-date",
  "visit-note", "save-button", "cancel-selection", "visit-status", "undo-delete",
  "visits-list", "visits-empty", "visit-count",
  "location-button", "location-status", "location-legend",
  "setup-screen", "walking-settings-form", "custom-walking-speed", "custom-speed-value", "settings-status", "edit-walking-settings",
  "set-destination", "destination-panel", "destination-name", "destination-address",
  "clear-destination", "destination-legend",
  "destination-search-form", "destination-search-input",
  "destination-search-button", "destination-search-status", "destination-search-results",
  "change-start", "start-name", "start-picker", "use-current-start", "start-legend",
  "pick-start-on-map", "start-map-selection", "cancel-start-map", "set-start",
  "start-search-form", "start-search-input", "start-search-button", "start-search-status", "start-search-results",
  "route-button", "route-status", "route-panel", "route-summary", "route-directions",
  "route-steps", "clear-route", "route-options", "route-choice-note",
  "discovery-screen", "open-discovery", "close-discovery", "discovery-form", "discovery-kind",
  "discovery-hours", "discovery-minutes", "discovery-time-range", "discovery-ambience", "discovery-keyword",
  "discovery-submit", "discovery-cancel", "discovery-status", "discovery-elapsed-label", "discovery-elapsed", "discovery-results",
  "discovery-history", "discovery-history-list",
  "discovery-high-elevation",
  "close-walking-settings",
].map((id) => [id, document.getElementById(id)]));
const savedMarkers = L.layerGroup().addTo(map);
const searchCache = new Map();
let selectedPlace = null;
let selectedVisitId = null;
let selectionMarker = null;
let lastDeleted = null;
let lastSearchAt = -Infinity;
let storageReadable = true;
let locating = false;
let recenterWhenLocated = false;
let currentLocationMarker = null;
let currentPosition = null;
let searchedStart = null;
let startMarker = null;
let selectingStartOnMap = false;
let locationAccuracyCircle = null;
let destination = null;
let destinationMarker = null;
let destinationIconMarker = null;
let routeEnabled = false;
let routeAwaitingLocation = false;
let routeLayer = null;
const routeLayers = new Map();
let routeRequest = null;
let routeTimer = null;
let routeVersion = 0;
let lastRouteAt = -Infinity;
let routeTurn = Promise.resolve();
let routeAttributionAdded = false;
let routeChoices = new Map();
let selectedRouteKind = "standard";
let activeRouteKind = null;
const natureCache = new Map();
const convenienceCache = new Map();
const discoveryMapCache = new Map();
const discoveryGeometryCache = new Map();
const discoveryContextCache = new Map();
const discoveryElevationCache = new Map();
let discoveryRequest = null;
let discoveryComposing = false;
let discoveryStartedAt = null;
let discoveryElapsedTimer = null;
let discoveryHistory = loadDiscoveryHistory();
let discoveryHasOpened = false;
let discoveryScrollTop = 0;
let walkingSettingsScrollTop = 0;
const destinationMapIcon = L.divIcon({
  className: "destination-map-icon",
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  html: "",
});
const appShell = document.querySelector(".app-shell");
let customWalkingSpeed = 4;
const savedWalkingSpeed = loadWalkingSpeed();
let walkingSpeed = savedWalkingSpeed || "normal";
ui["walking-settings-form"].querySelector(`input[value="${walkingSpeed}"]`).checked = true;
ui["custom-walking-speed"].value = currentWalkingSpeed().kmh;
updateCustomSpeedValue();
const searchPanel = document.getElementById("search-panel");
const panelToggle = document.getElementById("panel-toggle");
const panelChevron = panelToggle.querySelector(".panel-chevron");
let panelDrag = null;
let suppressPanelClick = false;

for (const panel of [ui["setup-screen"], ui["discovery-screen"], searchPanel]) {
  panel.addEventListener("pointerdown", () => bringToolToFront(panel));
  panel.addEventListener("focusin", () => bringToolToFront(panel));
}

function loadWalkingSpeed() {
  try {
    const saved = JSON.parse(localStorage.getItem(WALKING_SETTINGS_KEY));
    if (saved && saved.version === 1) {
      // Bring preferences saved with the former wider range into the current range.
      const savedCustomIsValid = validWalkingSpeed(saved.customKmh, 0.5, 25);
      if (savedCustomIsValid) customWalkingSpeed = Math.min(MAX_WALKING_SPEED, Math.max(MIN_WALKING_SPEED, saved.customKmh));
      if (Object.hasOwn(WALKING_SPEEDS, saved.speed)) return saved.speed;
      if (saved.speed === "custom" && savedCustomIsValid) return "custom";
    }
  } catch { /* Use the default if this browser cannot restore the preference. */ }
  return null;
}

function validWalkingSpeed(value, minimum = MIN_WALKING_SPEED, maximum = MAX_WALKING_SPEED) {
  return Number.isFinite(value) && value >= minimum && value <= maximum
    && Math.abs(value * 10 - Math.round(value * 10)) < 1e-8;
}

function currentWalkingSpeed() {
  return walkingSpeed === "custom" ? { label: "", kmh: customWalkingSpeed } : WALKING_SPEEDS[walkingSpeed];
}

function updateCustomSpeedValue() {
  const value = ui["custom-walking-speed"].valueAsNumber.toFixed(1);
  ui["custom-speed-value"].value = value;
  ui["custom-walking-speed"].setAttribute("aria-valuetext", `時速${value}キロメートル`);
}

ui["walking-settings-form"].addEventListener("change", (event) => {
  if (event.target.name !== "walking-speed") return;
  const preset = WALKING_SPEEDS[event.target.value];
  if (preset) ui["custom-walking-speed"].value = preset.kmh;
  updateCustomSpeedValue();
  message(ui["settings-status"], "");
});
ui["custom-walking-speed"].addEventListener("input", () => {
  ui["walking-settings-form"].querySelector('input[name="walking-speed"][value="custom"]').checked = true;
  updateCustomSpeedValue();
  message(ui["settings-status"], "");
});

ui["setup-screen"].addEventListener("keydown", (event) => {
  if (ui["setup-screen"].hidden || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const increase = event.key === "ArrowRight" || event.key === "ArrowUp";
  const decrease = event.key === "ArrowLeft" || event.key === "ArrowDown";
  if (!increase && !decrease) return;
  // Keep arrows on the slider, including when a preset or Save has focus.
  event.preventDefault();
  event.stopPropagation();
  const slider = ui["custom-walking-speed"];
  const previous = slider.value;
  if (increase) slider.stepUp();
  else slider.stepDown();
  if (slider.value !== previous) slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.focus({ preventScroll: true });
}, true);

ui["walking-settings-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  const choice = ui["walking-settings-form"].querySelector('input[name="walking-speed"]:checked');
  if (!choice || (choice.value !== "custom" && !Object.hasOwn(WALKING_SPEEDS, choice.value))) return;
  const customValue = ui["custom-walking-speed"].valueAsNumber;
  if (choice.value === "custom" && !validWalkingSpeed(customValue)) {
    message(ui["settings-status"], "歩く速さはバーで2.5〜6.5の範囲に調整してください。", true);
    ui["custom-walking-speed"].focus({ preventScroll: true });
    return;
  }
  const speedChanged = walkingSpeed !== choice.value
    || (choice.value === "custom" && customWalkingSpeed !== customValue);
  walkingSpeed = choice.value;
  if (walkingSpeed === "custom") customWalkingSpeed = customValue;
  try {
    localStorage.setItem(WALKING_SETTINGS_KEY, JSON.stringify({ version: 1, speed: walkingSpeed, customKmh: customWalkingSpeed }));
    message(ui["settings-status"], "");
  } catch {
    message(ui["settings-status"], "設定を保存できません。この画面を開いている間は選んだ速さを使います。", true);
  }
  openMap();
  if (speedChanged) cancelDiscovery();
  if (speedChanged && routeEnabled && !routeAwaitingLocation) requestWalkingRoute();
});

function openMap() {
  closeWalkingSettings(false);
  appShell.hidden = false;
  setDrawerOffset(panelIsOpen() ? searchPanel.getBoundingClientRect().width : 0);
  map.invalidateSize({ animate: false });
  map.getContainer().focus({ preventScroll: true });
}

function openWalkingSettings() {
  stopStartMapSelection();
  clearTimeout(zoomEndTimer);
  finishZoom();
  appShell.hidden = false;
  map.invalidateSize({ animate: false });
  ui["setup-screen"].hidden = false;
  ui["edit-walking-settings"].setAttribute("aria-expanded", "true");
  ui["walking-settings-form"].scrollTop = walkingSettingsScrollTop;
  bringToolToFront(ui["setup-screen"]);
  closeOverlappingTools(ui["setup-screen"]);
  ui["custom-walking-speed"].focus({ preventScroll: true });
}

ui["edit-walking-settings"].addEventListener("click", openWalkingSettings);
ui["close-walking-settings"].addEventListener("click", () => closeWalkingSettings());

function closeWalkingSettings(focus = true) {
  if (!ui["setup-screen"].hidden) walkingSettingsScrollTop = ui["walking-settings-form"].scrollTop;
  ui["setup-screen"].hidden = true;
  ui["setup-screen"].style.zIndex = "";
  ui["edit-walking-settings"].setAttribute("aria-expanded", "false");
  if (focus) ui["edit-walking-settings"].focus({ preventScroll: true });
}

function bringToolToFront(active) {
  for (const panel of [ui["setup-screen"], ui["discovery-screen"], searchPanel]) {
    panel.style.zIndex = panel === active ? "1081" : "";
  }
}

function closeOverlappingTools(active, preserveFocus = false) {
  if (active.hidden) return;
  const area = active.getBoundingClientRect();
  for (const panel of [ui["setup-screen"], ui["start-picker"]]) {
    if (panel === active || active.contains(panel) || panel.hidden) continue;
    if (preserveFocus && panel.contains(document.activeElement)) continue;
    const other = panel.getBoundingClientRect();
    if (area.left < other.right && area.right > other.left && area.top < other.bottom && area.bottom > other.top) {
      if (panel === ui["setup-screen"]) closeWalkingSettings(false);
      else setStartPickerOpen(false, false);
    }
  }
}

function panelIsOpen() {
  return appShell.classList.contains("panel-open");
}

function setDrawerOffset(offset) {
  appShell.style.setProperty("--drawer-offset", `${offset}px`);
  ui["discovery-screen"].style.setProperty("--drawer-offset", `${offset}px`);
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
  if (open) stopStartMapSelection();
  releasePanelDrag();
  const focusWasInside = searchPanel.contains(document.activeElement);
  clearTimeout(zoomEndTimer);
  finishZoom();
  searchPanel.toggleAttribute("inert", !open);
  searchPanel.setAttribute("aria-hidden", String(!open));
  appShell.classList.toggle("panel-open", open);
  setDrawerOffset(open ? searchPanel.getBoundingClientRect().width : 0);
  if (open) {
    bringToolToFront(searchPanel);
    closeOverlappingTools(searchPanel);
  } else searchPanel.style.zIndex = "";
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

function focusPlace(place, { keepZoom = false } = {}) {
  clearTimeout(zoomEndTimer);
  finishZoom();
  pendingX = pendingY = 0;
  const zoom = keepZoom ? map.getZoom() : Math.max(map.getZoom(), 16);
  const zoomChanged = zoom !== map.getZoom();
  // Reuse the pinch path to move immediately without clearing loaded tiles.
  if (map._animatingZoom) map._onZoomTransitionEnd();
  map._stop();
  map._moveStart(zoomChanged, false);
  map._move(L.latLng(place.lat, place.lng), zoom, { pinch: true, round: false });
  map.fire("viewreset");
  map._moveEnd(zoomChanged);
}

function setLocationBusy(busy) {
  locating = busy;
  for (const target of [ui["location-button"], ui["location-status"]]) {
    if (busy) target.setAttribute("aria-busy", "true");
    else target.removeAttribute("aria-busy");
  }
}

function getStartPoint() {
  return searchedStart || currentPosition;
}

function setStartPickerOpen(open, focus = true) {
  ui["start-picker"].hidden = !open;
  ui["use-current-start"].hidden = !searchedStart;
  ui["change-start"].setAttribute("aria-expanded", String(open));
  if (open) closeOverlappingTools(ui["start-picker"].closest("section"));
  else {
    if (startSearch.active || startSearch.timer !== null) message(startSearch.status, "");
    cancelSearch(startSearch);
  }
  if (focus) {
    const target = ui[open ? "start-search-input" : "change-start"];
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
}

function startPointChanged() {
  cancelDiscovery();
  routeAwaitingLocation = routeEnabled && !getStartPoint();
  routePointsChanged();
  if (!getStartPoint()) requestCurrentLocation();
}

function setStartPoint(place, { moveMap = true } = {}) {
  if (!place || !validCoordinates(place.lat, place.lng)) return;
  searchedStart = {
    name: typeof place.name === "string" ? place.name.trim().slice(0, 120) : "",
    address: typeof place.address === "string" ? place.address.trim() : "",
    lat: place.lat, lng: place.lng,
  };
  if (startMarker) startMarker.setLatLng([searchedStart.lat, searchedStart.lng]);
  else startMarker = L.circleMarker([searchedStart.lat, searchedStart.lng], {
    radius: 9, color: "#fff", weight: 2, fillColor: "#8250b5", fillOpacity: 1, bubblingMouseEvents: false,
  }).addTo(map);
  startMarker.bringToFront();
  const name = searchedStart.name || "指定した地点";
  ui["start-name"].textContent = name;
  ui["change-start"].setAttribute("aria-label", `スタート地点を検索：${name}`);
  ui["change-start"].title = [name, searchedStart.address].filter(Boolean).join(" ／ ");
  ui["start-legend"].hidden = false;
  cancelSearch(startSearch);
  clearSearchDisplay(startSearch);
  startSearch.input.value = searchedStart.name;
  setStartPickerOpen(false);
  if (moveMap) focusPlace(searchedStart, { keepZoom: true });
  startPointChanged();
}

function stopStartMapSelection(reopen = false) {
  const wasSelecting = selectingStartOnMap;
  selectingStartOnMap = false;
  ui["start-map-selection"].hidden = true;
  map.getContainer().classList.remove("is-selecting-start");
  if (reopen && wasSelecting) setDiscoveryOpen(true);
}

ui["pick-start-on-map"].addEventListener("click", () => {
  setDiscoveryOpen(false, false);
  setPanelOpen(false, false);
  selectingStartOnMap = true;
  ui["start-map-selection"].hidden = false;
  map.getContainer().classList.add("is-selecting-start");
  map.getContainer().focus({ preventScroll: true });
});
ui["cancel-start-map"].addEventListener("click", () => stopStartMapSelection(true));
map.getContainer().addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !selectingStartOnMap) return;
  event.preventDefault();
  event.stopPropagation();
  stopStartMapSelection(true);
});

ui["change-start"].addEventListener("click", () => setStartPickerOpen(true));
ui["start-name"].addEventListener("click", () => setStartPickerOpen(false));
ui["start-picker"].addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  setStartPickerOpen(false);
});
ui["use-current-start"].addEventListener("click", () => {
  const changed = Boolean(searchedStart);
  searchedStart = null;
  if (startMarker) startMarker.remove();
  startMarker = null;
  ui["start-name"].textContent = "現在地";
  ui["change-start"].setAttribute("aria-label", "スタート地点を検索：現在地");
  ui["change-start"].removeAttribute("title");
  ui["start-legend"].hidden = true;
  clearSearchDisplay(startSearch);
  startSearch.input.value = "";
  setStartPickerOpen(false);
  if (currentPosition) focusPlace(currentPosition, { keepZoom: true });
  if (changed) startPointChanged();
  else if (!currentPosition) requestCurrentLocation();
});

function showCurrentLocation(position, { center = true, keepZoom = routeEnabled } = {}) {
  setLocationBusy(false);
  const { latitude: lat, longitude: lng, accuracy } = position.coords;
  if (!validCoordinates(lat, lng)) {
    message(ui["location-status"], "位置情報を読み取れませんでした。もう一度お試しください。", true);
    routeLocationFailed();
    return;
  }
  if (!searchedStart && currentPosition && map.distance([currentPosition.lat, currentPosition.lng], [lat, lng]) > 30) cancelDiscovery();
  currentPosition = { lat, lng };
  const point = [lat, lng];
  if (Number.isFinite(accuracy) && accuracy >= 0) {
    if (locationAccuracyCircle) {
      locationAccuracyCircle.setLatLng(point).setRadius(accuracy);
    } else {
      locationAccuracyCircle = L.circle(point, {
        radius: accuracy, color: "#2476cf", weight: 1,
        fillColor: "#2476cf", fillOpacity: 0.1, interactive: false,
      }).addTo(map);
    }
  } else if (locationAccuracyCircle) {
    locationAccuracyCircle.remove();
    locationAccuracyCircle = null;
  }
  if (currentLocationMarker) {
    currentLocationMarker.setLatLng(point);
  } else {
    currentLocationMarker = L.circleMarker(point, {
      radius: 8, color: "#fff", weight: 2,
      fillColor: "#2476cf", fillOpacity: 1, bubblingMouseEvents: false,
    }).addTo(map);
  }
  currentLocationMarker.bringToFront();
  ui["location-legend"].hidden = false;
  if (center) focusPlace({ lat, lng }, { keepZoom });
  message(ui["location-status"], "");
  if (!searchedStart) {
    routeAwaitingLocation = false;
    routePointsChanged();
  }
  if (!searchedStart && discoveryRequest?.awaitingLocation) {
    discoveryRequest.awaitingLocation = false;
    discoveryRequest.start = { ...currentPosition };
    fetchDiscoverySuggestions(discoveryRequest);
  }
}

function locationFailed(error) {
  recenterWhenLocated = false;
  setLocationBusy(false);
  const reasons = {
    1: "位置情報が許可されていません。ブラウザと端末の設定で位置情報を許可して、もう一度お試しください。",
    2: "現在地を取得できませんでした。端末の位置情報と通信環境を確認して、もう一度お試しください。",
    3: "現在地の取得に時間がかかっています。場所を変えるか、少し待ってからもう一度お試しください。",
  };
  message(ui["location-status"], reasons[error.code]
    || "現在地を取得できませんでした。もう一度お試しください。", true);
  routeLocationFailed();
}

function requestCurrentLocation({ initial = false, recenter = false } = {}) {
  recenterWhenLocated ||= recenter;
  if (locating) return;
  if (window.isSecureContext === false) {
    recenterWhenLocated = false;
    message(ui["location-status"], "現在地を取得するには、HTTPS または localhost・127.0.0.1 の Live Server で開いてください。", true);
    routeLocationFailed();
    return;
  }
  if (!navigator.geolocation) {
    recenterWhenLocated = false;
    message(ui["location-status"], "このブラウザは現在地の取得に対応していません。対応したブラウザで開いてください。", true);
    routeLocationFailed();
    return;
  }
  setLocationBusy(true);
  message(ui["location-status"], "");
  const forRoute = routeAwaitingLocation;
  const initialView = initial ? { center: map.getCenter(), zoom: map.getZoom() } : null;
  try {
    navigator.geolocation.getCurrentPosition((position) => {
      // A slow startup fix must not replace a destination or a view the user moved.
      const viewUnchanged = !initial || (!selectedPlace && !destination && !searchedStart && !routeEnabled
        && map.getZoom() === initialView.zoom
        && map.project(map.getCenter()).distanceTo(map.project(initialView.center)) <= 1);
      const requestedRecenter = recenterWhenLocated;
      recenterWhenLocated = false;
      showCurrentLocation(position, {
        center: requestedRecenter || (!forRoute && viewUnchanged),
        keepZoom: requestedRecenter || routeEnabled,
      });
    }, locationFailed, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 0,
    });
  } catch (error) {
    locationFailed(error);
  }
}

ui["location-button"].addEventListener("click", () => {
  if (currentPosition) focusPlace(currentPosition, { keepZoom: true });
  requestCurrentLocation({ recenter: true });
});

function setDestination(place) {
  if (!place || !validCoordinates(place.lat, place.lng)) return;
  destination = {
    name: typeof place.name === "string" ? place.name.trim().slice(0, 120) : "",
    address: typeof place.address === "string" ? place.address.trim() : "",
    lat: place.lat, lng: place.lng,
  };
  if (destinationMarker) {
    destinationMarker.setLatLng([destination.lat, destination.lng]);
  } else {
    destinationMarker = L.circleMarker([destination.lat, destination.lng], {
      radius: 9, color: "#fff", weight: 2,
      fillColor: "#c44938", fillOpacity: 1, bubblingMouseEvents: false,
    }).addTo(map);
  }
  destinationMarker.bringToFront();
  if (destinationIconMarker) {
    destinationIconMarker.setLatLng([destination.lat, destination.lng]);
  } else {
    destinationIconMarker = L.marker([destination.lat, destination.lng], {
      icon: destinationMapIcon, keyboard: false, bubblingMouseEvents: false,
    }).addTo(map);
  }
  ui["destination-name"].textContent = destination.name;
  ui["destination-name"].hidden = !destination.name;
  ui["destination-address"].textContent = destination.address;
  ui["destination-address"].hidden = !destination.address;
  ui["destination-panel"].hidden = false;
  ui["destination-legend"].hidden = false;
  map.closePopup();
  focusPlace(destination, { keepZoom: true });
  setPanelOpen(false, false);
  closeOverlappingTools(ui["destination-panel"]);
  cancelSearch(destinationSearch);
  clearSearchDisplay(destinationSearch);
  destinationSearch.input.value = destination.name;
  routePointsChanged();
}

function clearDestination() {
  const focusWasInside = ui["destination-panel"].contains(document.activeElement);
  stopWalkingRoute();
  if (destinationMarker) destinationMarker.remove();
  if (destinationIconMarker) destinationIconMarker.remove();
  destinationMarker = null;
  destinationIconMarker = null;
  destination = null;
  ui["destination-panel"].hidden = true;
  ui["destination-legend"].hidden = true;
  ui["destination-name"].textContent = "";
  ui["destination-address"].textContent = "";
  cancelSearch(destinationSearch);
  clearSearchDisplay(destinationSearch);
  destinationSearch.input.value = "";
  if (focusWasInside) ui["open-discovery"].focus({ preventScroll: true });
}

function destinationButton(place) {
  const button = textElement("button", "目的地に指定", "secondary destination-button");
  button.type = "button";
  button.setAttribute("aria-label", `${place.name || "この場所"}を目的地に指定`);
  button.addEventListener("click", () => setDestination(place));
  return button;
}

function setRouteBusy(busy) {
  ui["route-button"].disabled = busy;
  ui["route-button"].textContent = busy ? "取得中…" : routeLayer ? "ルートを更新" : "徒歩ルートを表示";
  if (busy) ui["route-button"].setAttribute("aria-busy", "true");
  else ui["route-button"].removeAttribute("aria-busy");
}

function cancelRouteRequest() {
  routeVersion += 1;
  clearTimeout(routeTimer);
  routeTimer = null;
  const previous = routeRequest;
  routeRequest = null;
  if (previous) {
    clearTimeout(previous.timeout);
    previous.controller.abort();
  }
}

function clearRouteDisplay() {
  for (const layer of routeLayers.values()) layer.remove();
  routeLayers.clear();
  routeLayer = null;
  activeRouteKind = null;
  routeChoices.clear();
  ui["route-options"].replaceChildren();
  ui["route-options"].hidden = true;
  ui["route-choice-note"].textContent = "";
  ui["route-summary"].textContent = "";
  ui["route-steps"].replaceChildren();
  ui["route-directions"].hidden = true;
  ui["route-panel"].hidden = true;
}

function stopWalkingRoute() {
  const focusWasInside = ui["route-panel"].contains(document.activeElement);
  routeEnabled = false;
  routeAwaitingLocation = false;
  selectedRouteKind = "standard";
  cancelRouteRequest();
  clearRouteDisplay();
  ui["route-directions"].open = false;
  message(ui["route-status"], "");
  setRouteBusy(false);
  if (focusWasInside) ui[destination ? "route-button" : "open-discovery"].focus({ preventScroll: true });
}

function routeLocationFailed() {
  if (discoveryRequest?.awaitingLocation) {
    cancelDiscovery();
    message(ui["discovery-status"], "現在地を利用できません。「現在地」から再度お試しください。", true);
  }
  if (!routeAwaitingLocation) return;
  routeAwaitingLocation = false;
  routeEnabled = false;
  cancelRouteRequest();
  setRouteBusy(false);
  message(ui["route-status"], "現在地を取得できませんでした。位置情報の設定を確認して、もう一度ルートを表示してください。", true);
}

function routePointsChanged() {
  if (!routeEnabled) return;
  if (routeAwaitingLocation) {
    cancelRouteRequest();
    clearRouteDisplay();
    setRouteBusy(true);
    message(ui["route-status"], "");
    return;
  }
  requestWalkingRoute();
}

function routeDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function routeDuration(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes}分`;
  const remainder = minutes % 60;
  return `${Math.floor(minutes / 60)}時間${remainder ? `${remainder}分` : ""}`;
}

function walkingInstruction(step) {
  const maneuver = step.maneuver;
  if (maneuver.type === "arrive") return "目的地に到着";
  const directions = {
    uturn: "折り返す", "sharp right": "鋭く右折", right: "右折",
    "slight right": "右斜めに進む", straight: "直進", "slight left": "左斜めに進む",
    left: "左折", "sharp left": "鋭く左折",
  };
  const direction = directions[maneuver.modifier] || "直進";
  let instruction = direction;
  switch (maneuver.type) {
    case "depart": instruction = "出発地点から歩き始める"; break;
    case "end of road": instruction = `突き当たりで${direction}`; break;
    case "fork": instruction = `分岐で${direction}`; break;
    case "on ramp": instruction = "連絡路に入る"; break;
    case "off ramp": instruction = "連絡路から出る"; break;
    case "roundabout":
    case "rotary":
      instruction = Number.isInteger(maneuver.exit) && maneuver.exit > 0
        ? `環状交差点を${maneuver.exit}番目の出口で出る` : "環状交差点を進む";
      break;
    case "roundabout turn": instruction = `環状交差点で${direction}`; break;
    case "exit roundabout":
    case "exit rotary": instruction = "環状交差点を出る"; break;
    case "merge": instruction = `合流して${direction}`; break;
  }
  if (step.mode === "ferry") instruction = "フェリーで進む";
  const name = typeof step.name === "string" ? step.name.trim() : "";
  return `${instruction}${name ? `（${name}）` : ""}`;
}

function parseWalkingRoute(data) {
  const route = data.routes && data.routes[0];
  if (!route || !Number.isFinite(route.distance) || route.distance < 0
    || !Number.isFinite(route.duration) || route.duration < 0
    || !route.geometry || route.geometry.type !== "LineString"
    || !Array.isArray(route.geometry.coordinates) || route.geometry.coordinates.length < 2
    || !Array.isArray(route.legs) || !route.legs.length) throw new Error("Invalid route response");
  const points = route.geometry.coordinates.map((point) => {
    if (!Array.isArray(point) || !validCoordinates(point[1], point[0])) throw new Error("Invalid route point");
    return [point[1], point[0]];
  });
  const steps = route.legs.flatMap((leg) => {
    if (!Array.isArray(leg.steps) || !leg.steps.length) throw new Error("Missing route steps");
    return leg.steps;
  });
  for (const step of steps) {
    if (!step || !step.maneuver || typeof step.maneuver.type !== "string"
      || !Number.isFinite(step.distance) || step.distance < 0
      || !["walking", "ferry"].includes(step.mode)) throw new Error("Invalid walking step");
  }
  return { points, steps, distance: route.distance, duration: route.duration };
}

function syncRouteLayers() {
  // Keep every candidate visible below the location and destination markers.
  const pane = map.getPane("walkingRoutes") || map.createPane("walkingRoutes");
  pane.style.zIndex = "350";
  pane.style.pointerEvents = "none";
  for (const [kind, layer] of routeLayers) {
    if (!routeChoices.get(kind)?.route) {
      layer.remove();
      routeLayers.delete(kind);
    }
  }
  for (const kind of ROUTE_KINDS) {
    const choice = routeChoices.get(kind.id);
    if (!choice?.route || routeLayers.has(kind.id)) continue;
    routeLayers.set(kind.id, L.polyline(choice.route.points, {
      pane: "walkingRoutes", color: kind.color, weight: 5, opacity: 0.85, interactive: false,
    }).addTo(map));
  }
  routeLayer = routeLayers.get(activeRouteKind) || null;
}

function renderRouteChoices() {
  syncRouteLayers();
  const availableKinds = ROUTE_KINDS.filter((kind) => routeChoices.get(kind.id)?.route);
  ui["route-options"].hidden = availableKinds.length < 2;
  for (const button of ui["route-options"].querySelectorAll("[data-route-kind]")) {
    if (!routeChoices.get(button.dataset.routeKind)?.route) button.closest("li").remove();
  }
  for (const kind of availableKinds) {
    const choice = routeChoices.get(kind.id);
    let button = ui["route-options"].querySelector(`[data-route-kind="${kind.id}"]`);
    if (!button) {
      const item = document.createElement("li");
      button = textElement("button", "", "route-option");
      button.type = "button";
      button.dataset.routeKind = kind.id;
      const title = textElement("span", "", "route-option-title");
      const label = textElement("strong", "", "route-option-label");
      const swatch = textElement("span", "", "route-option-swatch");
      swatch.style.backgroundColor = kind.color;
      swatch.setAttribute("aria-hidden", "true");
      label.append(swatch, document.createTextNode(kind.label));
      title.append(label, textElement("span", "", "route-option-selected"));
      button.append(title, textElement("span", "", "route-option-detail"));
      button.addEventListener("click", () => {
        const available = routeChoices.get(kind.id);
        if (!available || !available.route) return;
        selectedRouteKind = kind.id;
        displayWalkingRoute(available.route, kind.id);
      });
      item.append(button);
      ui["route-options"].append(item);
    }
    const selected = activeRouteKind === kind.id;
    button.setAttribute("aria-pressed", String(selected));
    button.querySelector(".route-option-selected").textContent = selected ? "選択中" : "";
    button.querySelector(".route-option-detail").textContent = `${routeDistance(choice.route.distance)} ／ 約${routeDuration(choice.route.duration)}`
      + (choice.convenienceCount > 0 ? ` ／ コンビニ${choice.convenienceCount}件` : "");
  }
}

function updateRouteChoiceNote(kind) {
  const choice = routeChoices.get(kind);
  const detail = choice?.detail || ROUTE_KINDS.find((item) => item.id === kind)?.detail || "";
  const stores = choice?.convenienceCount > 0 ? `ルートから約60m以内にコンビニ${choice.convenienceCount}件。` : "";
  ui["route-choice-note"].textContent = `${detail ? `${detail}。` : ""}${stores}`;
}

function displayWalkingRoute(route, kind = "standard") {
  activeRouteKind = kind;
  syncRouteLayers();
  const speed = currentWalkingSpeed();
  ui["route-summary"].textContent = `距離 ${routeDistance(route.distance)} ／ 徒歩 約${routeDuration(route.duration)}（${speed.label ? `${speed.label}・` : ""}時速${speed.kmh} km）`;
  ui["route-steps"].replaceChildren();
  for (const step of route.steps) {
    const item = textElement("li", walkingInstruction(step));
    // Step distance is the distance travelled after this maneuver, up to the next one.
    if (step.maneuver.type !== "arrive" && step.distance > 0) {
      item.append(textElement("span", `${routeDistance(step.distance)}進む`, "route-step-distance"));
    }
    ui["route-steps"].append(item);
  }
  ui["route-directions"].hidden = false;
  ui["route-panel"].hidden = false;
  updateRouteChoiceNote(kind);
  renderRouteChoices();
  message(ui["route-status"], "");
  // A background route update must not close the tool the user is editing.
  closeOverlappingTools(ui["route-panel"], true);
}

function requestWalkingRoute() {
  cancelRouteRequest();
  clearRouteDisplay();
  if (!routeEnabled || !destination || !getStartPoint()) { setRouteBusy(false); return; }
  const start = { ...getStartPoint() };
  const end = { ...destination };
  const version = routeVersion;
  setRouteBusy(true);
  renderRouteChoices();
  message(ui["route-status"], "ルートを検索しています…");
  const wait = Math.max(0, 1000 - (Date.now() - lastRouteAt));
  routeTimer = setTimeout(() => fetchWalkingRoute(start, end, version), wait);
}

function routeErrorMessage(error) {
  if (error.name === "AbortError") return "取得に時間がかかっています。更新してお試しください。";
  if (["NoRoute", "NoSegment", 171, 172, 442].includes(error.routeCode)) return "徒歩で通れるルートが見つかりませんでした。";
  return "取得できませんでした。通信を確認して更新してください。";
}

function abortableRouteDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const aborted = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function fetchMapProxy(url, signal, timeoutMs) {
  const provider = DISCOVERY_MAP_ENDPOINTS.findIndex((endpoint) => url.origin + url.pathname === endpoint);
  if (provider < 0 || !MAP_PROXY_ENDPOINT || Date.now() < mapProxyRetryAt) return null;
  try {
    const response = await fetch(MAP_PROXY_ENDPOINT, {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: url.searchParams.get("data"), provider, timeout_ms: timeoutMs }),
    });
    // An unrelated service on port 8000 must not be mistaken for this relay.
    if (response.headers.get("X-Walking-Map") === "1") return response;
  } catch (error) {
    if (signal.aborted) throw error;
  }
  // Live Server still works directly when the Python process is not running.
  mapProxyRetryAt = Date.now() + 15000;
  return null;
}

async function fetchRouteJson(url, request, timeoutMs = 18000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.controller.signal.aborted) abort();
  request.controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    // Live Server also sends long map queries in the body when the Python relay is offline.
    const mapQuery = DISCOVERY_MAP_ENDPOINTS.includes(url.origin + url.pathname) && url.searchParams.get("data");
    const response = await fetchMapProxy(url, controller.signal, timeoutMs)
      || await fetch(mapQuery ? new URL(url.origin + url.pathname) : url, mapQuery
        ? { method: "POST", body: new URLSearchParams({ data: mapQuery }), signal: controller.signal }
        : { signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch (error) { error.httpStatus = response.status; throw error; }
    if (!response.ok || data.error || data.remark || (data.code && data.code !== "Ok")) {
      const error = new Error("Route data unavailable");
      error.routeCode = data.error_code || data.code;
      error.httpStatus = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
    request.controller.signal.removeEventListener("abort", abort);
  }
}

async function waitForRouteTurn(request) {
  // Share the request interval between routing and elevation lookups.
  const turn = routeTurn.then(async () => {
    await abortableRouteDelay(Math.max(0, 1000 - (Date.now() - lastRouteAt)), request.controller.signal);
    lastRouteAt = Date.now();
  });
  routeTurn = turn.catch(() => {});
  await turn;
}

async function calculateWalkingRoute(start, end, kind, speed, request, via = null) {
  await waitForRouteTurn(request);
  const point = (place, type = "break") => ({ lat: place.lat, lon: place.lng, type, search_cutoff: 100 });
  const locations = [point(start)];
  const viaPoints = Array.isArray(via) ? via : via ? [via] : [];
  for (const place of viaPoints) locations.push({ ...point(place, "via"), search_cutoff: 40 });
  locations.push(point(end));
  const url = new URL(ROUTE_ENDPOINT);
  url.searchParams.set("json", JSON.stringify({
    locations, costing: "pedestrian", format: "osrm", shape_format: "geojson",
    directions_options: { language: "ja-JP", units: "kilometers" },
    costing_options: { pedestrian: {
      walking_speed: speed, use_hills: kind === "gentle" ? 0 : 0.5,
      step_penalty: kind === "gentle" ? 600 : 30, max_hiking_difficulty: 0, use_ferry: 0,
    } },
  }));
  const data = await fetchRouteJson(url, request);
  const route = parseWalkingRoute(data);
  for (const [index, place] of viaPoints.entries()) {
    const snap = data.waypoints?.[index + 1]?.location;
    if (!snap || !validCoordinates(snap[1], snap[0]) || map.distance([place.lat, place.lng], [snap[1], snap[0]]) > 40
      || distanceToRoute(place, route) > 45) {
      throw new Error("The route does not reach the waypoint");
    }
  }
  return route;
}

async function findNatureWaypoint(start, end, request) {
  const distance = map.distance([start.lat, start.lng], [end.lat, end.lng]);
  const lat = (start.lat + end.lat) / 2;
  const lng = ((start.lng + (((end.lng - start.lng + 540) % 360) - 180) / 2 + 540) % 360) - 180;
  const radius = Math.round(Math.min(3500, Math.max(500, distance * 0.6 + 300)));
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
  let cached = natureCache.get(key);
  if (!cached || Date.now() - cached.at > 600000) {
    const around = `(around:${radius},${lat.toFixed(6)},${lng.toFixed(6)})`;
    const publicAccess = '[access!~"^(private|no|customers|permit|military)$"][fee!="yes"]';
    const query = `[out:json][timeout:12];(way${around}[leisure~"^(park|nature_reserve)$"]${publicAccess};`
      + `relation${around}[leisure~"^(park|nature_reserve)$"]${publicAccess};)->.green;`
      + `.green map_to_area->.areas;way(area.areas)${around}[highway~"^(footway|path|pedestrian)$"]`
      + `[foot!~"^(private|no)$"]${publicAccess}->.paths;node(w.paths)(area.areas)${around};out body 500;`;
    const url = new URL(MAP_DATA_ENDPOINT);
    url.searchParams.set("data", query);
    const data = await fetchRouteJson(url, request, 18000);
    if (!Array.isArray(data.elements)) throw new Error("Invalid green-space response");
    cached = { at: Date.now(), points: data.elements.filter((item) => item.type === "node" && validCoordinates(item.lat, item.lon))
      .map((item) => ({ lat: item.lat, lng: item.lon })) };
    if (natureCache.size >= 20) natureCache.delete(natureCache.keys().next().value);
    natureCache.set(key, cached);
  }
  const ranked = cached.points.map((point) => {
    const fromStart = map.distance([start.lat, start.lng], [point.lat, point.lng]);
    const toEnd = map.distance([point.lat, point.lng], [end.lat, end.lng]);
    return { point, fromStart, toEnd, detour: fromStart + toEnd,
      score: fromStart + toEnd + Math.abs(fromStart - toEnd) * 0.25 };
  }).filter((item) => item.fromStart > 60 && item.toEnd > 60 && item.detour <= Math.max(distance * 1.8, distance + 800))
    .sort((a, b) => a.score - b.score);
  return ranked.length ? ranked[0].point : null;
}

function distanceToRoute(place, route) {
  if (!route.projectedPoints) {
    const worldWidth = 2 * Math.PI * L.CRS.EPSG3857.projection.R;
    let referenceX;
    route.projectedPoints = route.points.map((point) => {
      const projected = L.CRS.EPSG3857.project(L.latLng(point));
      if (referenceX !== undefined) projected.x += Math.round((referenceX - projected.x) / worldWidth) * worldWidth;
      referenceX = projected.x;
      return projected;
    });
  }
  const point = L.CRS.EPSG3857.project(L.latLng(place.lat, place.lng));
  const worldWidth = 2 * Math.PI * L.CRS.EPSG3857.projection.R;
  point.x += Math.round((route.projectedPoints[0].x - point.x) / worldWidth) * worldWidth;
  let distance = Infinity;
  for (let i = 1; i < route.projectedPoints.length; i++) {
    distance = Math.min(distance, L.LineUtil.pointToSegmentDistance(point, route.projectedPoints[i - 1], route.projectedPoints[i]));
  }
  return distance * Math.cos(place.lat * Math.PI / 180);
}

function routesEquivalent(first, second) {
  if (Math.abs(first.distance - second.distance) > Math.max(35, Math.max(first.distance, second.distance) * 0.03)) return false;
  const follows = (source, target) => {
    const stride = Math.max(1, Math.floor(source.points.length / 40));
    for (let i = 0; i < source.points.length; i += stride) {
      const [lat, lng] = source.points[i];
      if (distanceToRoute({ lat, lng }, target) > 25) return false;
    }
    const [lat, lng] = source.points[source.points.length - 1];
    return distanceToRoute({ lat, lng }, target) <= 25;
  };
  return follows(first, second) && follows(second, first);
}

function countConvenienceStores(stores, route) {
  return stores.filter((store) => distanceToRoute(store, route) <= 60).length;
}

async function findConvenienceStores(start, end, request) {
  const distance = map.distance([start.lat, start.lng], [end.lat, end.lng]);
  const lat = (start.lat + end.lat) / 2;
  const lng = ((start.lng + (((end.lng - start.lng + 540) % 360) - 180) / 2 + 540) % 360) - 180;
  const radius = Math.round(Math.min(3500, Math.max(500, distance * 0.6 + 300)));
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
  const cached = convenienceCache.get(key);
  if (cached && Date.now() - cached.at <= 600000) return cached.stores;
  const query = `[out:json][timeout:12];nwr(around:${radius},${lat.toFixed(6)},${lng.toFixed(6)})`
    + '[shop="convenience"][access!~"^(private|no)$"][opening_hours!="closed"];out body center 200;';
  const url = new URL(MAP_DATA_ENDPOINT);
  url.searchParams.set("data", query);
  const data = await fetchRouteJson(url, request);
  if (!Array.isArray(data.elements)) throw new Error("Invalid convenience store response");
  const stores = [];
  for (const element of data.elements) {
    if (element.tags?.shop !== "convenience" || ["private", "no"].includes(element.tags.access)
      || element.tags.opening_hours === "closed") continue;
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (!validCoordinates(lat, lng)) continue;
    const name = String(element.tags["name:ja"] || element.tags.name || element.tags.brand || "").normalize("NFKC").replace(/\s/g, "").toLowerCase();
    if (stores.some((other) => map.distance([lat, lng], [other.lat, other.lng]) < 20 && name === other.name)) continue;
    stores.push({ lat, lng, name });
  }
  if (convenienceCache.size >= 20) convenienceCache.delete(convenienceCache.keys().next().value);
  convenienceCache.set(key, { at: Date.now(), stores });
  return stores;
}

async function findConvenienceRoute(start, end, stores, reference, speed, request) {
  const directDistance = map.distance([start.lat, start.lng], [end.lat, end.lng]);
  const referenceCount = countConvenienceStores(stores, reference);
  const targets = stores.map((store) => ({
    ...store,
    fromStart: map.distance([start.lat, start.lng], [store.lat, store.lng]),
    toEnd: map.distance([store.lat, store.lng], [end.lat, end.lng]),
    distanceFromRoute: distanceToRoute(store, reference),
  })).filter((store) => store.distanceFromRoute > 60 && store.fromStart > 40 && store.toEnd > 40
    && store.fromStart + store.toEnd <= Math.max(directDistance * 1.8, directDistance + 800));
  if (!targets.length || stores.length < 2) return null;
  const density = (store) => targets.filter((other) => map.distance([store.lat, store.lng], [other.lat, other.lng]) <= 450).length;
  const ranked = targets.map((store) => ({ ...store, density: density(store) }))
    .sort((a, b) => b.density - a.density || a.fromStart + a.toEnd - b.fromStart - b.toEnd);
  const groups = [];
  for (const anchor of ranked) {
    if (groups.length >= 2) break;
    if (groups.some((group) => group.some((point) => map.distance([point.lat, point.lng], [anchor.lat, anchor.lng]) < 200))) continue;
    const companion = ranked.find((other) => {
      const gap = map.distance([anchor.lat, anchor.lng], [other.lat, other.lng]);
      return gap >= 100 && gap <= 700;
    });
    let group = companion ? [anchor, companion].sort((a, b) => a.fromStart - b.fromStart) : [anchor];
    const viaDistance = group[0].fromStart + (group.length === 2
      ? map.distance([group[0].lat, group[0].lng], [group[1].lat, group[1].lng]) : 0) + group[group.length - 1].toEnd;
    if (viaDistance > Math.max(directDistance * 1.8, directDistance + 1000)) group = [anchor];
    groups.push(group);
  }
  let best = null;
  for (const group of groups) {
    try {
      const route = await calculateWalkingRoute(start, end, "convenience", speed, request, group);
      const count = countConvenienceStores(stores, route);
      if (count < 2 || count <= referenceCount || routesEquivalent(reference, route)
        || route.distance > Math.max(reference.distance * 1.6, reference.distance + 1200)) continue;
      if (!best || count > best.convenienceCount || (count === best.convenienceCount && route.distance < best.route.distance)) {
        best = { route, convenienceCount: count, detail: `基本のルートより近くのコンビニが${count - referenceCount}件多い候補` };
      }
    } catch (error) {
      if (request.controller.signal.aborted) throw error;
      // An inaccessible shop must not prevent showing another useful route.
    }
  }
  return best;
}

async function fetchWalkingRoute(start, end, version) {
  routeTimer = null;
  if (!routeEnabled || version !== routeVersion) return;
  const controller = new AbortController();
  const request = { controller };
  routeRequest = request;
  const isCurrent = () => routeEnabled && routeRequest === request && version === routeVersion;
  if (!routeAttributionAdded) {
    map.attributionControl.addAttribution('ルート: <a href="https://valhalla.openstreetmap.de/">Valhalla / FOSSGIS</a>・周辺情報: <a href="https://overpass.private.coffee/">Overpass</a> | <a href="https://www.openstreetmap.org/fixthemap">地図の修正</a>');
    routeAttributionAdded = true;
  }
  try {
    const speed = currentWalkingSpeed().kmh;
    let stores = null;
    for (const kind of ROUTE_KINDS) {
      if (!isCurrent()) return;
      try {
        let via = null;
        let suggestion = null;
        const reference = routeChoices.get("standard")?.route || routeChoices.values().next().value?.route;
        if (kind.id === "convenience") {
          if (!reference) continue;
          stores = await findConvenienceStores(start, end, request);
          if (!isCurrent()) return;
          for (const choice of routeChoices.values()) choice.convenienceCount = countConvenienceStores(stores, choice.route);
          renderRouteChoices();
          if (activeRouteKind) updateRouteChoiceNote(activeRouteKind);
          suggestion = await findConvenienceRoute(start, end, stores, reference, speed, request);
          if (!isCurrent()) return;
          if (!suggestion) continue;
        }
        if (kind.id === "nature") {
          via = await findNatureWaypoint(start, end, request);
          if (!isCurrent()) return;
          if (!via) continue;
        }
        const route = suggestion?.route || await calculateWalkingRoute(start, end, kind.id, speed, request, via);
        if (!isCurrent()) return;
        if (kind.id !== "standard" && reference && route.distance > Math.max(reference.distance * 2, reference.distance + 1500)) continue;
        if ([...routeChoices.values()].some((choice) => routesEquivalent(choice.route, route))) continue;
        routeChoices.set(kind.id, { ...suggestion, route, convenienceCount: stores ? countConvenienceStores(stores, route) : undefined });
        if (!routeLayer || selectedRouteKind === kind.id) displayWalkingRoute(route, kind.id);
        setRouteBusy(false);
      } catch (error) {
        if (!isCurrent()) return;
        // Extra route types are suggestions; missing ones have no reserved UI slot.
      }
      renderRouteChoices();
    }
    if (!isCurrent()) return;
    message(ui["route-status"], routeLayer ? "" : "ルートを取得できませんでした。目的地や通信状況を確認し、もう一度お試しください。", !routeLayer);
  } catch (error) {
    if (isCurrent()) {
      message(ui["route-status"], routeErrorMessage(error), true);
    }
  } finally {
    clearTimeout(request.timeout);
    if (routeRequest === request) {
      routeRequest = null;
      setRouteBusy(false);
    }
  }
}

ui["route-button"].addEventListener("click", () => {
  if (!destination || ui["route-button"].disabled) return;
  routeEnabled = true;
  if (searchedStart) {
    routeAwaitingLocation = false;
    requestWalkingRoute();
    return;
  }
  routeAwaitingLocation = true;
  cancelRouteRequest();
  clearRouteDisplay();
  setRouteBusy(true);
  message(ui["route-status"], "");
  requestCurrentLocation();
});
ui["clear-route"].addEventListener("click", stopWalkingRoute);

ui["set-destination"].addEventListener("click", () => {
  if (selectedPlace) setDestination({ ...selectedPlace, name: ui["visit-name"].value.trim() });
});
ui["set-start"].addEventListener("click", () => {
  if (!selectedPlace) return;
  const place = { ...selectedPlace, name: ui["visit-name"].value.trim() };
  setPanelOpen(false, false);
  setDiscoveryOpen(true, false);
  setStartPoint(place, { moveMap: false });
});
ui["clear-destination"].addEventListener("click", clearDestination);

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
  cancelSearch(placeSearch);
  clearSearchDisplay(placeSearch);
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
    popup.append(destinationButton(visit));
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
    actions.append(edit, remove, destinationButton(visit));
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

function createSearchContext(prefix, onSelect) {
  const context = { timer: null, active: null, composing: false, onSelect };
  for (const key of ["form", "input", "button", "status", "results"]) {
    context[key] = ui[`${prefix}-${key}`];
  }
  context.label = context.button.getAttribute("aria-label");
  return context;
}

const placeSearch = createSearchContext("search", (place) => selectPlace(place));
const destinationSearch = createSearchContext("destination-search", (place) => {
  setDiscoveryOpen(false, false);
  setDestination(place);
  ui["open-discovery"].focus({ preventScroll: true });
});
const startSearch = createSearchContext("start-search", (place) => setStartPoint(place));

function loadDiscoveryHistory() {
  try {
    const data = JSON.parse(localStorage.getItem(DISCOVERY_HISTORY_KEY));
    if (data?.version !== 1 || !Array.isArray(data.searches)) return [];
    const ids = new Set();
    return data.searches.filter((entry) => {
      const criteria = entry?.criteria;
      if (!entry || typeof entry.id !== "string" || ids.has(entry.id)
        || !Number.isFinite(entry.at) || !Number.isFinite(new Date(entry.at).getTime())
        || !validCoordinates(entry.start?.lat, entry.start?.lng)
        || !criteria || !Object.hasOwn(DISCOVERY_KINDS, criteria.kind)
        || !["any", "urban", "rural", "nature"].includes(criteria.ambience)
        || (criteria.highElevation !== undefined && typeof criteria.highElevation !== "boolean")
        || typeof criteria.keyword !== "string" || criteria.keyword.length > 80
        || !validWalkingSpeed(criteria.speed)
        || !Number.isInteger(criteria.minutes) || criteria.minutes < 35
        || criteria.minMinutes !== Math.max(0, criteria.minutes - 60)
        || !Number.isFinite(entry.elapsedSeconds) || entry.elapsedSeconds < 0
        || !Array.isArray(entry.places) || !entry.places.length || entry.places.length > 5
        || !entry.places.every((place) => place && validCoordinates(place.lat, place.lng)
          && typeof place.key === "string" && typeof place.name === "string" && place.name.length <= 120
          && typeof place.address === "string" && typeof place.ambienceNote === "string"
          && Object.hasOwn(DISCOVERY_KINDS, place.kindId) && DISCOVERY_KINDS[place.kindId].tags
          && Number.isFinite(place.duration) && place.duration >= 0
          && Number.isFinite(place.distance) && place.distance >= 0
          && (place.elevation == null || validDiscoveryElevation(place.elevation))
          && Number.isFinite(place.preferenceScore))) return false;
      ids.add(entry.id);
      return true;
    }).slice(0, DISCOVERY_HISTORY_LIMIT);
  } catch { return []; }
}

function rememberDiscoverySearch(request) {
  if (!request || request.historical || !request.places) return;
  if (!request.historyId && !request.places.length) return;
  request.historyId ||= crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  discoveryHistory = discoveryHistory.filter((entry) => entry.id !== request.historyId);
  if (request.places.length) {
    discoveryHistory.unshift({ id: request.historyId, at: request.startedAt,
      start: { ...request.start }, criteria: { ...request.criteria },
      elapsedSeconds: request.elapsedSeconds || 0, places: request.places.map((place) => ({ ...place })) });
  }
  discoveryHistory = discoveryHistory.slice(0, DISCOVERY_HISTORY_LIMIT);
  try {
    localStorage.setItem(DISCOVERY_HISTORY_KEY, JSON.stringify({ version: 1, searches: discoveryHistory }));
  } catch { /* History remains available in this page when browser storage is unavailable. */ }
  renderDiscoveryHistory();
}

function renderDiscoveryHistory() {
  ui["discovery-history"].hidden = !discoveryHistory.length;
  ui["discovery-history-list"].replaceChildren();
  const moods = { any: "こだわらない", urban: "都会寄り", rural: "田舎寄り", nature: "自然が多い" };
  for (const entry of discoveryHistory) {
    const criteria = entry.criteria;
    const title = `${routeDuration((criteria.minutes - 30) * 60)} / ${DISCOVERY_KINDS[criteria.kind].label} / ${moods[criteria.ambience]}${discoveryPreferences(criteria).highElevation ? " / 標高が高め" : ""}`;
    const date = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(entry.at);
    const button = textElement("button", title, "discovery-history-button");
    button.type = "button";
    button.append(textElement("span", `${date}・${entry.places.length}件${criteria.keyword ? `・${criteria.keyword}` : ""}`, "place-detail"));
    button.addEventListener("click", () => restoreDiscoverySearch(entry));
    const item = document.createElement("li");
    item.append(button);
    ui["discovery-history-list"].append(item);
  }
}

function restoreDiscoverySearch(entry, focus = true) {
  if (discoveryRequest) stopDiscovery();
  const minutes = entry.criteria.minutes - 30;
  ui["discovery-kind"].value = entry.criteria.kind;
  ui["discovery-hours"].value = Math.floor(minutes / 60);
  ui["discovery-minutes"].value = minutes % 60;
  ui["discovery-ambience"].value = entry.criteria.ambience;
  ui["discovery-keyword"].value = entry.criteria.keyword;
  ui["discovery-high-elevation"].checked = !!entry.criteria.highElevation;
  ui["discovery-history"].open = false;
  updateDiscoveryTimeRange();
  renderDiscoveryResults(entry.places, { historical: true, criteria: entry.criteria, start: entry.start });
  message(ui["discovery-status"], `候補 ${entry.places.length}件`);
  ui["discovery-elapsed-label"].textContent = "かかった時間：";
  ui["discovery-elapsed"].textContent = `${entry.elapsedSeconds.toFixed(1)}秒`;
  if (focus) ui["discovery-results"].querySelector("button")?.focus();
}

function finishDiscoverySearch(request) {
  if (!request) return;
  request.elapsedSeconds = Math.max(0, Date.now() - request.startedAt) / 1000;
  rememberDiscoverySearch(request);
}

function updateDiscoveryElapsed() {
  if (discoveryStartedAt === null) return;
  const seconds = Math.max(0, Math.floor((Date.now() - discoveryStartedAt) / 1000));
  ui["discovery-elapsed"].textContent = `${seconds}秒`;
  if (ui["discovery-submit"].disabled) ui["discovery-submit"].textContent = `条件検索中… ${seconds}秒`;
}

function setDiscoveryBusy(busy) {
  ui["discovery-submit"].disabled = busy;
  ui["discovery-submit"].textContent = busy ? "条件検索中… 0秒" : "条件に合う場所を探す";
  ui["discovery-cancel"].hidden = !busy;
  if (busy) ui["discovery-form"].setAttribute("aria-busy", "true");
  else ui["discovery-form"].removeAttribute("aria-busy");
  clearTimeout(discoveryElapsedTimer);
  discoveryElapsedTimer = null;
  if (busy) {
    discoveryStartedAt = Date.now();
    ui["discovery-elapsed-label"].textContent = "経過時間";
    const tick = () => {
      updateDiscoveryElapsed();
      discoveryElapsedTimer = setTimeout(tick, 1000);
    };
    tick();
  } else {
    updateDiscoveryElapsed();
    if (discoveryStartedAt !== null) {
      ui["discovery-elapsed-label"].textContent = "かかった時間：";
      ui["discovery-elapsed"].textContent = `${(Math.max(0, Date.now() - discoveryStartedAt) / 1000).toFixed(1)}秒`;
    }
    discoveryStartedAt = null;
  }
}

function cancelDiscovery() {
  const previous = discoveryRequest;
  discoveryRequest = null;
  if (previous) {
    previous.controller.abort();
    finishDiscoverySearch(previous);
  }
  setDiscoveryBusy(false);
  ui["discovery-results"].replaceChildren();
  message(ui["discovery-status"], "");
}

function stopDiscovery() {
  if (!discoveryRequest) return;
  const previous = discoveryRequest;
  const restoreFocus = document.activeElement === ui["discovery-cancel"];
  discoveryRequest = null;
  previous.controller.abort();
  finishDiscoverySearch(previous);
  setDiscoveryBusy(false);
  const count = ui["discovery-results"].children.length;
  message(ui["discovery-status"], count ? `${count}件の候補を表示しています。` : "検索を中止しました。");
  if (restoreFocus) ui["discovery-submit"].focus({ preventScroll: true });
}

function setDiscoveryOpen(open, focus = true) {
  if (open) stopStartMapSelection();
  const panel = ui["discovery-screen"].querySelector(".discovery-panel");
  if (!open) {
    discoveryScrollTop = panel.scrollTop;
    if (discoveryRequest) stopDiscovery();
    if (destinationSearch.active || destinationSearch.timer !== null) message(destinationSearch.status, "");
    cancelSearch(destinationSearch);
    setStartPickerOpen(false, false);
  }
  ui["discovery-screen"].hidden = !open;
  ui["open-discovery"].setAttribute("aria-expanded", String(open));
  if (open) {
    bringToolToFront(ui["discovery-screen"]);
    closeOverlappingTools(ui["discovery-screen"]);
    if (!discoveryHasOpened) {
      discoveryHasOpened = true;
      if (discoveryHistory[0]) restoreDiscoverySearch(discoveryHistory[0], false);
    }
    renderDiscoveryHistory();
    panel.scrollTop = discoveryScrollTop;
    updateDiscoveryTimeRange();
  } else ui["discovery-screen"].style.zIndex = "";
  const focusTarget = open ? panel.scrollTop > 0 ? "close-discovery" : "destination-search-input" : "open-discovery";
  if (focus) ui[focusTarget].focus({ preventScroll: true });
}

function discoveryText(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

function discoveryPublic(tags, facility = false) {
  const denied = ["private", "no", "permit", "military"];
  if (facility) denied.push("customers");
  return !denied.includes(tags.access) && !["no", "private"].includes(tags.foot)
    && tags.opening_hours !== "closed" && tags.disused !== "yes" && tags.abandoned !== "yes";
}

function discoveryPoint(element) {
  if (!element || typeof element !== "object") return null;
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  return validCoordinates(lat, lng) ? { lat, lng } : null;
}

function discoveryDestinationPoint(element, kind, start) {
  if (!DISCOVERY_KINDS[kind].geometry) return discoveryPoint(element);
  const lines = Array.isArray(element.geometry) ? [element.geometry]
    : (Array.isArray(element.members) ? element.members : [])
      .filter((member) => member && member.role !== "inner" && Array.isArray(member.geometry)).map((member) => member.geometry);
  const origin = L.CRS.EPSG3857.project(L.latLng(start.lat, start.lng));
  const worldWidth = 2 * Math.PI * L.CRS.EPSG3857.projection.R;
  let nearest = null, distance = Infinity;
  for (const line of lines) {
    let previous = null;
    for (const node of line) {
      // Clipped geometry can contain gaps: never connect across a missing node.
      if (!node || !validCoordinates(node.lat, node.lon)) { previous = null; continue; }
      const point = L.CRS.EPSG3857.project(L.latLng(node.lat, node.lon));
      point.x += Math.round((origin.x - point.x) / worldWidth) * worldWidth;
      const closest = previous ? L.LineUtil.closestPointOnSegment(origin, previous, point) : point;
      const gap = origin.distanceTo(closest);
      if (gap < distance) { distance = gap; nearest = closest; }
      previous = point;
    }
  }
  if (nearest) {
    const point = L.CRS.EPSG3857.unproject(nearest).wrap();
    return { lat: point.lat, lng: point.lng };
  }
  const tags = element.tags || {};
  // A water-area centre is in the water, not a destination on its shore.
  if (tags.natural === "water" || tags.natural === "coastline" || tags.waterway === "riverbank") return null;
  return element.type === "node" ? discoveryPoint(element) : null;
}

function discoveryPreferences(criteria) {
  const words = [];
  const kinds = new Set();
  let ambience = criteria.ambience || "any";
  let highElevation = !!criteria.highElevation;
  for (const word of discoveryText(criteria.keyword).split(/[\s,、]+/).filter(Boolean)) {
    const mood = Object.keys(DISCOVERY_MOOD_WORDS).find((key) => DISCOVERY_MOOD_WORDS[key].includes(word));
    const kind = Object.keys(DISCOVERY_KIND_WORDS).find((key) => DISCOVERY_KIND_WORDS[key].includes(word));
    if (DISCOVERY_ELEVATION_WORDS.includes(word)) highElevation = true;
    else if (mood) { if (ambience === "any") ambience = mood; }
    else if (kind) kinds.add(kind);
    else words.push(word);
  }
  return { ambience, kinds, words, highElevation };
}

function discoveryKinds(kind) {
  return kind === "any" ? Object.keys(DISCOVERY_KINDS).filter((key) => DISCOVERY_KINDS[key].tags)
    : DISCOVERY_KINDS[kind].kinds || [kind];
}

function discoverySearchKinds(criteria, preferences) {
  const kinds = discoveryKinds(criteria.kind);
  // A broad place search can also honor an explicitly requested cafe, shrine, etc.
  return criteria.kind === "places" ? [...new Set([...kinds, ...preferences.kinds])] : kinds;
}

function discoveryTagFilters(kind) {
  return [DISCOVERY_KINDS[kind].tags, ...(DISCOVERY_KINDS[kind].alternatives || [])].filter(Boolean);
}

function discoveryKindMatches(tags, kind) {
  return discoveryTagFilters(kind).some((filters) => Object.entries(filters).every(([key, values]) => values.includes(tags[key])));
}

function discoverySurroundings(elements, start) {
  const seen = new Set();
  return elements.flatMap((element) => {
    if (!element || typeof element !== "object") return [];
    const hasOutline = Array.isArray(element.geometry) || element.members?.some((member) => Array.isArray(member?.geometry));
    const kind = start && (!discoveryPoint(element) || hasOutline) && discoveryKinds("places")
      .find((key) => DISCOVERY_KINDS[key].geometry && discoveryKindMatches(element.tags || {}, key));
    const point = kind ? discoveryDestinationPoint(element, kind, start) : discoveryPoint(element);
    if (!point) return [];
    const key = element.id ? `${element.type}/${element.id}` : `${point.lat},${point.lng},${element.tags?.name || ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...point, tags: element.tags || {} }];
  });
}

function discoveryAmbience(point, surroundings, ambience) {
  if (ambience === "any") return { score: 0, note: "" };
  const rural = ambience === "rural";
  let shops = 0, urbanLand = 0, farms = 0, forests = 0, villages = 0, peaks = 0, green = 0, water = 0;
  let commercial = false, residential = false, cityCentre = false, largeCommercial = false;
  for (const other of surroundings) {
    const distance = map.distance([point.lat, point.lng], [other.lat, other.lng]);
    if (distance > (rural ? 2000 : 400)) continue;
    const t = other.tags;
    if (distance <= 400) {
      if (discoveryPublic(t) && ((t.shop && !["no", "vacant"].includes(t.shop))
      || ["cafe", "restaurant", "fast_food", "bank", "library", "post_office", "cinema"].includes(t.amenity))) shops++;
      if (["retail", "commercial"].includes(t.landuse)) urbanLand = Math.max(urbanLand, 1.5);
      else if (t.landuse === "residential") urbanLand = Math.max(urbanLand, 0.5);
      if (["retail", "commercial", "industrial"].includes(t.landuse) || ["mall", "department_store"].includes(t.shop)) commercial = true;
      if (t.landuse === "industrial" || ["mall", "department_store"].includes(t.shop)) largeCommercial = true;
      if (t.landuse === "residential") residential = true;
      if (t.place === "city") cityCentre = true;
    }
    if (distance <= (rural ? 800 : 400) && ["farmland", "farmyard", "orchard", "vineyard"].includes(t.landuse)) farms++;
    if (t.landuse === "forest" || t.natural === "wood") forests++;
    if (distance <= (rural ? 800 : 400) && ["village", "hamlet", "isolated_dwelling"].includes(t.place)) villages++;
    if (t.natural === "peak") peaks++;
    if (["park", "garden", "nature_reserve"].includes(t.leisure)
      || ["forest", "meadow", "orchard"].includes(t.landuse) || ["wood", "grassland", "scrub", "wetland"].includes(t.natural)) green++;
    if (["water", "spring", "beach", "coastline"].includes(t.natural) || ["river", "riverbank", "waterfall"].includes(t.waterway)) water++;
  }
  const urban = Math.min(4, shops / 2) + urbanLand;
  if (ambience === "urban") return { score: urban, note: urban > 0 ? shops >= 3 ? "店・施設が多め（目安）" : urbanLand ? "市街地の近く（目安）" : "店・施設の近く（目安）" : "" };
  if (ambience === "rural") {
    // A quiet area can qualify without farmland; nearby hills and woods improve its ranking.
    // Dense urban centres remain excluded even when mountains or woods are within reach.
    const rejected = largeCommercial || cityCentre || shops >= 6 || (commercial && residential && shops >= 3);
    const score = rejected ? 0 : Math.max(0.5, 2 - urban * 0.5 + Math.min(4, (farms + forests + villages + peaks) * 2));
    return { score, matches: !rejected, rejected, note: rejected ? "" : farms ? "田畑の近く（目安）" : forests ? "山林の近く（目安）" : villages ? "小さな集落の近く（目安）" : peaks ? "山の周辺（目安）" : "" };
  }
  return { score: Math.min(5, green + water * 1.5), note: water ? "水辺の近く（目安）" : green ? "緑地の近く（目安）" : "" };
}

function discoveryCandidates(elements, criteria, start, limit = 8) {
  const preferences = discoveryPreferences(criteria);
  const kinds = discoverySearchKinds(criteria, preferences);
  const surroundings = discoverySurroundings(elements, start);
  const places = [];
  for (const element of elements) {
    const tags = element?.tags || {};
    if (!element || !discoveryPublic(tags)) continue;
    const kindId = kinds.find((key) => discoveryKindMatches(tags, key));
    if (!kindId) continue;
    const point = discoveryDestinationPoint(element, kindId, start);
    if (!point) continue;
    const directDistance = map.distance([start.lat, start.lng], [point.lat, point.lng]);
    const distance = directDistance * DISCOVERY_DISTANCE_FACTOR;
    const duration = distance / (criteria.speed / 3.6);
    if (duration < (criteria.minMinutes || 0) * 60 || duration > criteria.minutes * 60) continue;
    const kind = DISCOVERY_KINDS[kindId];
    const name = String(tags["name:ja"] || tags.name || tags.brand || kind.label).slice(0, 120);
    const searchable = discoveryText([name, tags.brand, tags.description, tags["description:ja"], tags.cuisine].filter(Boolean).join(" "));
    const free = tags.fee === "no" && !tags["fee:conditional"];
    const toilets = tags.toilets === "yes" && !["private", "no", "customers"].includes(tags["toilets:access"]);
    const benches = tags.bench === "yes";
    const mood = discoveryAmbience(point, surroundings, preferences.ambience);
    const cachedElevation = discoveryElevationCache.get(discoveryElevationKey(point));
    const mappedElevation = DISCOVERY_KINDS[kindId].geometry ? null : parseDiscoveryElevation(tags.ele);
    const elevation = mappedElevation ?? (cachedElevation && Date.now() - cachedElevation.at < 600000 ? cachedElevation.height : null);
    const keywordScore = preferences.words.length ? 4 * preferences.words.filter((word) => searchable.includes(word)).length / preferences.words.length : 0;
    const preferenceScore = mood.score * 3 + keywordScore + (preferences.kinds.has(kindId) ? 20 : 0);
    if (places.some((other) => (element.id && other.osmType === element.type && other.osmId === element.id)
      || (discoveryText(other.name).replace(/\s/g, "") === discoveryText(name).replace(/\s/g, "")
      && map.distance([point.lat, point.lng], [other.lat, other.lng]) < 30))) continue;
    const address = [...new Set([tags["addr:province"], tags["addr:city"], tags["addr:suburb"], tags["addr:quarter"],
      tags["addr:neighbourhood"], tags["addr:street"], tags["addr:housenumber"]].filter((value) => typeof value === "string" && value))].join("、");
    places.push({ ...point, name, address, free, toilets, benches, directDistance, distance, duration, preferenceScore, elevation,
      key: `${element.type}/${element.id ?? `${point.lat},${point.lng},${kindId}`}`,
      ambienceNote: mood.note, ruralMatch: !!mood.matches, ruralRejected: !!mood.rejected,
      kindId, kindLabel: kind.label, osmType: element.type, osmId: element.id });
  }
  return places.sort((a, b) => compareDiscoveryElevation(a, b, preferences.highElevation)
    || b.preferenceScore - a.preferenceScore || a.directDistance - b.directDistance).slice(0, limit);
}

function validDiscoveryElevation(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= -12000 && value <= 10000;
}

function parseDiscoveryElevation(value) {
  if (validDiscoveryElevation(value)) return value;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?\s*(?:m)?$/i.test(value.trim())) return null;
  const height = Number(value.trim().replace(/\s*m$/i, ""));
  return validDiscoveryElevation(height) ? height : null;
}

function discoveryElevationKey(place) {
  return `${place.lat.toFixed(6)},${place.lng.toFixed(6)}`;
}

function compareDiscoveryElevation(a, b, enabled) {
  if (!enabled) return 0;
  const knownA = validDiscoveryElevation(a.elevation), knownB = validDiscoveryElevation(b.elevation);
  return knownA !== knownB ? knownA ? -1 : 1 : knownA ? b.elevation - a.elevation : 0;
}

async function fetchDiscoveryElevations(places, request) {
  const pool = places.slice(0, 24).map((place) => ({ ...place }));
  const missing = new Map();
  for (const place of pool) {
    if (validDiscoveryElevation(place.elevation)) continue;
    const key = discoveryElevationKey(place);
    const cached = discoveryElevationCache.get(key);
    if (cached && Date.now() - cached.at < 600000) place.elevation = cached.height;
    else missing.set(key, place);
  }
  if (missing.size) {
    try {
      await waitForRouteTurn(request);
      const url = new URL("height", ROUTE_ENDPOINT);
      url.searchParams.set("json", JSON.stringify({ range: false, height_precision: 0,
        shape: [...missing.values()].map((place) => ({ lat: place.lat, lon: place.lng })) }));
      const data = await fetchRouteJson(url, request, 10000);
      if (!Array.isArray(data.height) || data.height.length !== missing.size) throw new Error("Invalid elevation data");
      for (const [index, key] of [...missing.keys()].entries()) {
        if (discoveryElevationCache.size >= 256) discoveryElevationCache.delete(discoveryElevationCache.keys().next().value);
        discoveryElevationCache.set(key, { at: Date.now(), height: validDiscoveryElevation(data.height[index]) ? data.height[index] : null });
      }
      for (const place of pool) {
        if (!validDiscoveryElevation(place.elevation)) place.elevation = discoveryElevationCache.get(discoveryElevationKey(place))?.height ?? null;
      }
    } catch (error) {
      if (request.controller.signal.aborted) throw error;
      request.elevationUnavailable = true;
    }
  }
  return pool.filter((place) => validDiscoveryElevation(place.elevation));
}

async function fetchDiscoveryMapData(query, request, timeoutMs = DISCOVERY_MAP_TIMEOUT_MS, retry = true) {
  let retries = 0;
  while (true) {
    const order = [preferredDiscoveryMapProvider, ...DISCOVERY_MAP_ENDPOINTS.map((_, index) => index)
      .filter((index) => index !== preferredDiscoveryMapProvider)]
      .filter((index) => Date.now() >= discoveryMapProviders[index].retryAt);
    let lastError = lastDiscoveryMapError;
    if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (order.length) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.controller.signal.addEventListener("abort", abort, { once: true });
      let releaseFallback;
      const firstFailed = new Promise((resolve) => { releaseFallback = resolve; });
      let fatalError = null;
      const attempts = order.map(async (index, offset) => {
        try {
          if (offset) await Promise.race([firstFailed, abortableRouteDelay(DISCOVERY_PROVIDER_DELAY_MS, controller.signal)]);
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const url = new URL(DISCOVERY_MAP_ENDPOINTS[index]);
          url.searchParams.set("data", query);
          const data = await fetchRouteJson(url, { ...request, controller }, timeoutMs);
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (!Array.isArray(data.elements)) throw new Error("Invalid destination data");
          return { elements: data.elements, index };
        } catch (error) {
          if (!controller.signal.aborted) {
            if (error.routeCode === "MapQuery" || [400, 422].includes(error.httpStatus)) {
              fatalError = error;
              controller.abort();
            } else {
              discoveryMapProviders[index].retryAt = Date.now() + 30000;
              lastDiscoveryMapError = lastError = error;
              releaseFallback();
            }
          }
          throw error;
        }
      });
      try {
        const result = await Promise.any(attempts);
        preferredDiscoveryMapProvider = result.index;
        discoveryMapProviders[result.index].retryAt = 0;
        return result.elements;
      } catch {
        if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (fatalError) throw fatalError;
      } finally {
        controller.abort();
        request.controller.signal.removeEventListener("abort", abort);
      }
    }
    if (!retry) throw lastError || new Error("Map services are unavailable");
    const cooldown = Math.max(0, Math.min(...discoveryMapProviders.map((provider) => provider.retryAt)) - Date.now());
    const delay = Math.max(cooldown, Math.min(60000, 10000 * 2 ** Math.min(retries++, 3)));
    message(ui["discovery-status"], "検索中…");
    await abortableRouteDelay(delay, request.controller.signal);
  }
}

function mergeDiscoveryElements(...groups) {
  const merged = new Map();
  for (const element of groups.flat()) {
    if (!element) continue;
    const key = `${element.type}/${element.id}`;
    const previous = merged.get(key);
    const combined = { ...previous, ...element };
    if (previous?.members?.some((member) => Array.isArray(member?.geometry))
      && !element.members?.some((member) => Array.isArray(member?.geometry))) combined.members = previous.members;
    merged.set(key, combined);
  }
  return [...merged.values()];
}

function discoveryBounds(point, radius) {
  const latSpan = radius / 110000;
  const lngSpan = Math.min(180, latSpan / Math.max(0.001, Math.cos(point.lat * Math.PI / 180)));
  const wrap = (lng) => ((lng + 180) % 360 + 360) % 360 - 180;
  return [Math.max(-90, point.lat - latSpan), lngSpan === 180 ? -180 : wrap(point.lng - lngSpan),
    Math.min(90, point.lat + latSpan), lngSpan === 180 ? 180 : wrap(point.lng + lngSpan)]
    .map((value) => value.toFixed(6)).join(",");
}

function discoveryDistanceFilter(start, minRadius, maxRadius) {
  // Leave a margin for the local projection; exact spherical distances are checked in the browser.
  if (Math.abs(start.lat) > 75 || maxRadius > 100000 || Math.abs(start.lng) > 178) return "";
  const dy = `((lat()-(${start.lat.toFixed(6)}))*111195)`;
  const dx = `((lon()-(${start.lng.toFixed(6)}))*${(111195 * Math.cos(start.lat * Math.PI / 180)).toFixed(3)})`;
  const squared = `(${dy}*${dy}+${dx}*${dx})`;
  const margin = Math.ceil(150 + maxRadius ** 2 / 6371000 * Math.abs(Math.tan(start.lat * Math.PI / 180)));
  return `(if:${squared}>=${Math.max(0, minRadius - margin) ** 2}&&${squared}<=${(maxRadius + margin) ** 2})`;
}

async function fetchDiscoveryContext(places, request) {
  const rural = discoveryPreferences(request.criteria).ambience === "rural";
  const points = places.slice(0, rural ? 4 : 8).map((place) => ({ lat: place.lat, lng: place.lng,
    radius: rural ? 800 : 400 }))
    .sort((a, b) => a.lat - b.lat || a.lng - b.lng);
  const key = `bbox:${rural ? "rural-2000:" : ""}${points.map((point) => `${point.radius}:${point.lat.toFixed(6)},${point.lng.toFixed(6)}`).join(";")}`;
  let context = discoveryContextCache.get(key);
  if (!context || Date.now() - context.at >= 600000) {
    // Look around the walking destination, rather than every edge of a large forest or lake.
    const filters = [
      { tags: '[~"^(landuse|natural|place)$"~"^(residential|retail|commercial|industrial|farmland|farmyard|orchard|vineyard|forest|meadow|wood|grassland|scrub|wetland|water|peak|city|village|hamlet|isolated_dwelling)$"]', radius: rural ? 800 : 400, limit: 80 },
      { tags: '[shop]', radius: 400, limit: 16 },
      { tags: '[amenity~"^(cafe|restaurant|fast_food|bank|library|post_office|cinema)$"]', radius: 400, limit: 16 }
    ];
    if (rural) filters.push({ tags: '[~"^(landuse|natural)$"~"^(forest|wood|peak)$"]', radius: 2000, limit: 40 });
    // Keep a separate quota for each place so one busy area cannot hide other places' surroundings.
    const queries = points.map((point) => filters.map((filter) => `nwr(${discoveryBounds(point, filter.radius)})${filter.tags}->.neighborhood;`
      + `.neighborhood out body center ${filter.limit};`).join("")).join("");
    const query = `[out:json][timeout:10];${queries}`;
    context = { at: Date.now(), elements: await fetchDiscoveryMapData(query, request, 15000, false) };
    if (discoveryContextCache.size >= 20) discoveryContextCache.delete(discoveryContextCache.keys().next().value);
    discoveryContextCache.set(key, context);
  }
  return context.elements;
}

async function findDiscoveryPlaces(criteria, start, request, onUpdate = () => {}) {
  const maxRadius = Math.ceil(criteria.minutes * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR);
  const preferences = discoveryPreferences(criteria);
  const { ambience } = preferences;
  const kinds = discoverySearchKinds(criteria, preferences);
  const preferredKinds = kinds.filter((kind) => preferences.kinds.has(kind));
  const minRadius = (criteria.minMinutes || 0) * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  let radius = minRadius > 0 ? maxRadius : Math.min(maxRadius, 2000);
  let elements = [];
  const ruralChecked = new Set();
  const ruralAttempted = new Set();
  const assessmentKey = (place) => `${place.key}|${place.lat.toFixed(5)},${place.lng.toFixed(5)}`;
  const assessPlaces = async () => {
    const candidateLimit = ambience === "rural" ? 250 : 24;
    let candidates = discoveryCandidates(elements, criteria, start, candidateLimit);
    if (ambience !== "rural") { onUpdate(candidates); return candidates; }
    const confirmed = () => candidates.filter((place) => ruralChecked.has(assessmentKey(place)) && place.ruralMatch);
    let matches = confirmed();
    onUpdate(matches);
    while (matches.length < 5 && !request.ambienceUnavailable) {
      const batch = candidates.filter((place) => !place.ruralRejected && !ruralAttempted.has(assessmentKey(place))).slice(0, 4);
      if (!batch.length) break;
      for (const place of batch) ruralAttempted.add(assessmentKey(place));
      try {
        elements = mergeDiscoveryElements(elements, await fetchDiscoveryContext(batch, request));
        for (const place of batch) ruralChecked.add(assessmentKey(place));
      } catch (error) {
        if (request.controller.signal.aborted) throw error;
        request.ambienceUnavailable = true;
      }
      candidates = discoveryCandidates(elements, criteria, start, candidateLimit);
      matches = confirmed();
      onUpdate(matches);
    }
    return matches;
  };
  while (true) {
    if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const key = `${start.lat.toFixed(5)},${start.lng.toFixed(5)},${radius},${kinds.join(",")},min:${minRadius.toFixed(3)}`;
    let cached = discoveryMapCache.get(key);
    if (!cached || Date.now() - cached.at >= 600000) {
      const access = '[access!~"^(private|no|permit|military)$"][foot!~"^(no|private)$"][opening_hours!="closed"]';
      const bounds = discoveryBounds(start, radius);
      const limit = Math.floor(250 / kinds.length);
      // Give each kind a share so nearby shops or woodland fragments cannot fill every slot.
      const queries = kinds.map((kind) => {
        const spatial = `(${discoveryBounds(start, radius + 150)})`;
        const band = DISCOVERY_KINDS[kind].geometry ? "" : discoveryDistanceFilter(start, minRadius, radius);
        const filters = discoveryTagFilters(kind).map((tags) => `nwr${spatial}`
          + Object.entries(tags).map(([tag, values]) => `[${tag}~"^(${values.join("|")})$"]`).join("") + `${access}${band};`).join("");
        return `(${filters});out body center ${limit};`;
      }).join("");
      const query = `[out:json][timeout:30];${queries}`;
      const elements = await fetchDiscoveryMapData(query, request);
      if (discoveryMapCache.size >= 20) discoveryMapCache.delete(discoveryMapCache.keys().next().value);
      cached = { at: Date.now(), elements, bounds };
      discoveryMapCache.set(key, cached);
    }
    elements = mergeDiscoveryElements(elements, cached.elements);
    const needsGeometry = (element) => ["way", "relation"].includes(element.type) && Number.isSafeInteger(element.id) && element.id > 0
      && !Array.isArray(element.geometry) && !element.members?.some((member) => Array.isArray(member?.geometry))
      && kinds.some((kind) => DISCOVERY_KINDS[kind].geometry && discoveryKindMatches(element.tags || {}, kind));
    const geometryKey = (element) => `${cached.bounds}|${element.type}/${element.id}`;
    const pending = [];
    const savedGeometry = [];
    for (const element of elements.filter(needsGeometry)) {
      const saved = discoveryGeometryCache.get(geometryKey(element));
      if (saved && Date.now() - saved.at < 600000) { if (saved.element) savedGeometry.push(saved.element); }
      else pending.push(element);
    }
    elements = mergeDiscoveryElements(elements, savedGeometry);
    let places = await assessPlaces();
    if (ambience === "rural" && request.ambienceUnavailable) return places;
    const geometryPriority = (element) => {
      const point = discoveryPoint(element);
      const preferred = preferredKinds.some((kind) => discoveryKindMatches(element.tags || {}, kind));
      return (preferred ? -1e9 : 0) + (point ? Math.abs(map.distance(start, point) - (minRadius + radius) / 2) : 1e8);
    };
    pending.sort((a, b) => geometryPriority(a) - geometryPriority(b));
    while (pending.length && (places.length < 5 || (preferredKinds.length && !places.some((place) => preferredKinds.includes(place.kindId))))) {
      const batch = pending.splice(0, 12);
      const ids = ["way", "relation"].map((type) => {
        const selected = batch.filter((element) => element.type === type).map((element) => element.id);
        return selected.length ? `${type}(id:${selected.join(",")});` : "";
      }).join("");
      message(ui["discovery-status"], "検索中…");
      const geometry = await fetchDiscoveryMapData(`[out:json][timeout:30];(${ids});out body geom(${cached.bounds});`, request);
      for (const element of batch) {
        if (discoveryGeometryCache.size >= 128) discoveryGeometryCache.delete(discoveryGeometryCache.keys().next().value);
        discoveryGeometryCache.set(geometryKey(element), { at: Date.now(), element: geometry.find((item) => item?.type === element.type && item.id === element.id) || null });
      }
      elements = mergeDiscoveryElements(elements, geometry);
      places = await assessPlaces();
      if (ambience === "rural" && request.ambienceUnavailable) return places;
    }
    if (!["any", "rural"].includes(ambience) && places.length) {
      try {
        elements = mergeDiscoveryElements(elements, await fetchDiscoveryContext(places, request));
      } catch (error) {
        if (request.controller.signal.aborted) throw error;
        request.ambienceUnavailable = true;
      }
      places = discoveryCandidates(elements, criteria, start, 24);
      onUpdate(places);
    }
    if (radius >= maxRadius || (places.length >= 5
      && (!preferredKinds.length || places.some((place) => preferredKinds.includes(place.kindId)))
      && (["any", "rural"].includes(ambience) || places.some((place) => place.ambienceNote) || request.ambienceUnavailable))) return places;
    radius = Math.min(maxRadius, radius * 3);
    message(ui["discovery-status"], "検索中…");
  }
}

function discoveryContextMatches(request) {
  const start = getStartPoint();
  return start && currentWalkingSpeed().kmh === request.criteria.speed
    && map.distance([start.lat, start.lng], [request.start.lat, request.start.lng]) <= 30;
}

function renderDiscoveryResults(results, request) {
  const list = ui["discovery-results"];
  const highElevation = discoveryPreferences(request.criteria).highElevation;
  const ordered = [...results].sort((a, b) => compareDiscoveryElevation(a, b, highElevation)
    || b.preferenceScore - a.preferenceScore || a.duration - b.duration || a.distance - b.distance).slice(0, 5);
  request.places = ordered;
  if (!request.historical) {
    request.elapsedSeconds = Math.max(0, Date.now() - request.startedAt) / 1000;
    rememberDiscoverySearch(request);
  }
  // Keep existing buttons so late results do not remove keyboard focus.
  for (const button of list.querySelectorAll("[data-place-key]")) {
    if (!ordered.some((place) => place.key === button.dataset.placeKey)) button.closest("li").remove();
  }
  for (const [index, place] of ordered.entries()) {
    let button = [...list.querySelectorAll("[data-place-key]")].find((item) => item.dataset.placeKey === place.key);
    const detail = `${place.kindLabel} ／ ${request.historical ? "検索時の目安" : "徒歩の目安"} 約${routeDuration(place.duration)}・${routeDistance(place.distance)}`;
    const content = placeButton(place, detail, "discovery-result");
    if (highElevation && validDiscoveryElevation(place.elevation)) content.append(textElement("span", `標高 約${Math.round(place.elevation).toLocaleString("ja-JP")} m`, "place-detail"));
    const matched = [place.free ? "無料" : "", place.toilets ? "トイレ100m以内" : "", place.benches ? "ベンチ100m以内" : ""].filter(Boolean);
    if (matched.length) content.append(textElement("span", matched.join("・"), "place-detail"));
    if (place.ambienceNote) content.append(textElement("span", place.ambienceNote, "place-detail"));
    if (place.address) content.append(textElement("span", place.address, "place-detail"));
    content.append(textElement("span", "目的地に指定", "discovery-result-action"));
    if (!button) {
      const item = document.createElement("li");
      button = content;
      button.dataset.placeKey = place.key;
      item.append(button);
    } else {
      button.replaceChildren(...content.childNodes);
    }
    button.onclick = () => {
      if (!request.historical && !discoveryContextMatches(request)) {
        cancelDiscovery();
        message(ui["discovery-status"], "スタート地点か歩く速さが変わりました。もう一度探してください。", true);
        return;
      }
      setDiscoveryOpen(false, false);
      setDestination(place);
      ui["open-discovery"].focus({ preventScroll: true });
    };
    const item = button.closest("li") || button.parentElement;
    if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
  }
}

async function fetchDiscoverySuggestions(request) {
  const { criteria, start } = request;
  const rural = discoveryPreferences(criteria).ambience === "rural";
  const highElevation = discoveryPreferences(criteria).highElevation;
  const isCurrent = () => discoveryRequest === request;
  let results = [];
  try {
    const places = await findDiscoveryPlaces(criteria, start, request, (places) => {
      if (!isCurrent()) return;
      if (!discoveryContextMatches(request)) { cancelDiscovery(); return; }
      results = highElevation ? places.filter((place) => validDiscoveryElevation(place.elevation)) : places;
      renderDiscoveryResults(results, request);
    });
    if (highElevation && isCurrent()) {
      results = await fetchDiscoveryElevations(places, request);
      if (!isCurrent()) return;
      if (!discoveryContextMatches(request)) { cancelDiscovery(); return; }
      renderDiscoveryResults(results, request);
    }
    if (isCurrent()) message(ui["discovery-status"], results.length
      ? `候補 ${Math.min(5, results.length)}件`
      : highElevation && places.length ? request.elevationUnavailable ? "標高を取得できませんでした。" : "標高を確認できる候補がありませんでした。"
        : rural && request.ambienceUnavailable ? "周辺情報を取得できませんでした。"
        : "候補が見つかりませんでした。");
  } catch (error) {
    if (isCurrent()) message(ui["discovery-status"], results.length
      ? `取得できた候補 ${Math.min(5, results.length)}件。`
      : error.routeCode === "MapBusy" ? "検索先が混み合っています。少し待ってからお試しください。"
        : error.routeCode === "MapTimeout" ? "検索先の応答に時間がかかっています。少し待ってからお試しください。"
        : error.name === "AbortError" ? "検索に時間がかかっています。もう一度お試しください。"
        : "候補を取得できませんでした。通信を確認して、もう一度お試しください。", !results.length);
  } finally {
    if (isCurrent()) { finishDiscoverySearch(request); discoveryRequest = null; setDiscoveryBusy(false); }
  }
}

ui["open-discovery"].addEventListener("click", () => setDiscoveryOpen(true));
ui["discovery-cancel"].addEventListener("click", stopDiscovery);
ui["close-discovery"].addEventListener("click", () => setDiscoveryOpen(false));
ui["discovery-screen"].addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setDiscoveryOpen(false);
  }
});
function discoveryTimeWindow() {
  const hours = ui["discovery-hours"].valueAsNumber;
  const minutePart = ui["discovery-minutes"].valueAsNumber;
  const minutes = hours * 60 + minutePart;
  if (!Number.isInteger(hours) || hours < 0 || !Number.isInteger(minutePart) || minutePart < 0 || minutePart > 59
    || !Number.isFinite(minutes) || minutes < 5) return null;
  return { minMinutes: Math.max(0, minutes - 30), minutes: minutes + 30 };
}

function updateDiscoveryTimeRange() {
  const time = discoveryTimeWindow();
  message(ui["discovery-time-range"], time
    ? `${time.minMinutes ? routeDuration(time.minMinutes * 60) : "0分"}〜${routeDuration(time.minutes * 60)}の場所を探します。` : "");
}

for (const type of ["input", "change"]) ui["discovery-form"].addEventListener(type, () => {
  cancelDiscovery();
  updateDiscoveryTimeRange();
});
ui["discovery-keyword"].addEventListener("compositionstart", () => { discoveryComposing = true; });
ui["discovery-keyword"].addEventListener("compositionend", () => { discoveryComposing = false; });
ui["discovery-keyword"].addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || discoveryComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat && !ui["discovery-submit"].disabled) ui["discovery-form"].requestSubmit();
});
ui["discovery-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (discoveryComposing || !ui["discovery-form"].reportValidity()) return;
  const kind = ui["discovery-kind"].value;
  const time = discoveryTimeWindow();
  const ambience = ui["discovery-ambience"].value;
  if (!Object.hasOwn(DISCOVERY_KINDS, kind) || !["any", "urban", "rural", "nature"].includes(ambience)) return;
  if (!time) {
    message(ui["discovery-status"], "徒歩時間は5分以上で指定してください。", true);
    ui["discovery-hours"].focus({ preventScroll: true });
    return;
  }
  cancelDiscovery();
  updateDiscoveryTimeRange();
  const criteria = { kind, ...time, ambience, highElevation: ui["discovery-high-elevation"].checked,
    keyword: ui["discovery-keyword"].value.trim(), speed: currentWalkingSpeed().kmh };
  const start = getStartPoint();
  discoveryRequest = { criteria, controller: new AbortController(), startedAt: Date.now(), start: start ? { ...start } : null, awaitingLocation: !start };
  setDiscoveryBusy(true);
  message(ui["discovery-status"], "検索中…");
  if (discoveryRequest.awaitingLocation) requestCurrentLocation();
  else fetchDiscoverySuggestions(discoveryRequest);
});

function renderSearch(places, context = placeSearch) {
  context.results.replaceChildren();
  for (const place of places) {
    const item = document.createElement("li");
    const button = placeButton(place, place.address, "result-button");
    button.addEventListener("click", () => context.onSelect(place));
    item.append(button);
    context.results.append(item);
  }
  message(context.status, places.length
    ? `${places.length}件`
    : "見つかりませんでした。市区町村も入れて検索するか、地図をクリックして選んでください。");
}

function clearSearchDisplay(context = placeSearch) {
  context.results.replaceChildren();
  message(context.status, "");
}

function setSearchBusy(busy, context = placeSearch) {
  context.button.disabled = busy;
  context.button.setAttribute("aria-label", busy ? "検索中" : context.label);
  if (busy) context.form.setAttribute("aria-busy", "true");
  else context.form.removeAttribute("aria-busy");
}

function cancelSearch(context = placeSearch) {
  clearTimeout(context.timer);
  context.timer = null;
  const previous = context.active;
  context.active = null;
  if (previous) {
    clearTimeout(previous.timeout);
    previous.controller.abort();
  }
  setSearchBusy(false, context);
}

function scheduleSearch(context = placeSearch) {
  cancelSearch(context);
  clearSearchDisplay(context);
  const query = context.input.value.trim();
  if (!query) return;
  if (searchCache.has(query)) { renderSearch(searchCache.get(query), context); return; }
  // Explicit searches share a minimum one-second request interval.
  const wait = Math.max(0, 1000 - (Date.now() - lastSearchAt));
  context.timer = setTimeout(() => searchPlaces(query, context), wait);
}

async function searchPlaces(query, context = placeSearch) {
  context.timer = null;
  if (context.input.value.trim() !== query) return;
  if (searchCache.has(query)) { renderSearch(searchCache.get(query), context); return; }
  // Both search fields share the request interval, even when their timers overlap.
  const wait = 1000 - (Date.now() - lastSearchAt);
  if (wait > 0) {
    context.timer = setTimeout(() => searchPlaces(query, context), wait);
    return;
  }
  const controller = new AbortController();
  const request = { controller, timeout: setTimeout(() => controller.abort(), 12000) };
  context.active = request;
  const isCurrent = () => context.active === request
    && context.input.value.trim() === query;
  lastSearchAt = Date.now();
  setSearchBusy(true, context);
  message(context.status, "場所を検索しています…");
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
    renderSearch(places, context);
  } catch (error) {
    if (isCurrent()) {
      message(context.status, error.name === "AbortError"
        ? "検索に時間がかかっています。少し待ってから再検索してください。"
        : "検索できませんでした。通信を確認して再検索するか、地図をクリックして場所を選んでください。", true);
    }
  } finally {
    clearTimeout(request.timeout);
    if (context.active === request) {
      context.active = null;
      setSearchBusy(false, context);
    }
  }
}

function connectSearch(context) {
  const inputChanged = () => {
    cancelSearch(context);
    clearSearchDisplay(context);
  };
  context.input.addEventListener("compositionstart", () => {
    context.composing = true;
    inputChanged();
  });
  context.input.addEventListener("compositionend", () => {
    context.composing = false;
    inputChanged();
  });
  context.input.addEventListener("input", inputChanged);
  context.input.addEventListener("keydown", (event) => {
    // Enter used to confirm Japanese text must not submit a search.
    if (event.key !== "Enter" || event.isComposing || context.composing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) scheduleSearch(context);
  });
  context.button.addEventListener("click", () => scheduleSearch(context));
  context.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!context.composing) scheduleSearch(context);
  });
}
connectSearch(placeSearch);
connectSearch(destinationSearch);
connectSearch(startSearch);

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
  const place = { name: "", address: "", lat: latlng.lat,
    lng: ((latlng.lng + 180) % 360 + 360) % 360 - 180 };
  if (selectingStartOnMap) {
    stopStartMapSelection();
    setDiscoveryOpen(true, false);
    setStartPoint(place, { moveMap: false });
    return;
  }
  selectPlace(place, null, false);
});
renderVisits();
if (savedWalkingSpeed) openMap();
else openWalkingSettings();
requestCurrentLocation({ initial: true });
