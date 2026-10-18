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
  "route-button", "route-status", "route-panel", "route-summary", "route-directions",
  "route-steps", "clear-route", "route-options", "route-choice-note",
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
let routeAttributionAdded = false;
let routeChoices = new Map();
let selectedRouteKind = "standard";
let activeRouteKind = null;
const natureCache = new Map();
const convenienceCache = new Map();
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
  if (speedChanged && routeEnabled && !routeAwaitingLocation) requestWalkingRoute();
});

function openMap() {
  ui["setup-screen"].hidden = true;
  appShell.hidden = false;
  appShell.inert = false;
  setDrawerOffset(panelIsOpen() ? searchPanel.getBoundingClientRect().width : 0);
  map.invalidateSize({ animate: false });
  map.getContainer().focus({ preventScroll: true });
}

function openWalkingSettings() {
  clearTimeout(zoomEndTimer);
  finishZoom();
  appShell.hidden = false;
  appShell.inert = true;
  map.invalidateSize({ animate: false });
  ui["setup-screen"].hidden = false;
  ui["walking-settings-form"].querySelector('input:checked').focus({ preventScroll: true });
}

ui["edit-walking-settings"].addEventListener("click", openWalkingSettings);

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

function showCurrentLocation(position, { center = true, keepZoom = routeEnabled } = {}) {
  setLocationBusy(false);
  const { latitude: lat, longitude: lng, accuracy } = position.coords;
  if (!validCoordinates(lat, lng)) {
    message(ui["location-status"], "位置情報を読み取れませんでした。もう一度お試しください。", true);
    routeLocationFailed();
    return;
  }
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
  routeAwaitingLocation = false;
  routePointsChanged();
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
      const viewUnchanged = !initial || (!selectedPlace && !destination && !routeEnabled
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
  if (focusWasInside) destinationSearch.input.focus({ preventScroll: true });
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
  if (focusWasInside) ui[destination ? "route-button" : "destination-search-input"].focus({ preventScroll: true });
}

function routeLocationFailed() {
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
}

function requestWalkingRoute() {
  cancelRouteRequest();
  clearRouteDisplay();
  if (!routeEnabled || !destination || !currentPosition) { setRouteBusy(false); return; }
  const start = { ...currentPosition };
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

async function fetchRouteJson(url, request, timeoutMs = 18000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.controller.signal.aborted) abort();
  request.controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok || data.error || data.remark || (data.code && data.code !== "Ok")) {
      const error = new Error("Route data unavailable");
      error.routeCode = data.error_code || data.code;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
    request.controller.signal.removeEventListener("abort", abort);
  }
}

async function calculateWalkingRoute(start, end, kind, speed, request, via = null) {
  await abortableRouteDelay(Math.max(0, 1000 - (Date.now() - lastRouteAt)), request.controller.signal);
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
  lastRouteAt = Date.now();
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
const destinationSearch = createSearchContext("destination-search", (place) => setDestination(place));

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
if (savedWalkingSpeed) openMap();
else openWalkingSettings();
requestCurrentLocation({ initial: true });
