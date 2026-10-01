const map = L.map("map", {
  dragging: true,
  scrollWheelZoom: false,
  zoomSnap: 0,
}).setView([35.681236, 139.767125], 13);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

let pendingX = 0;
let pendingY = 0;
let panScheduled = false;

map.getContainer().addEventListener("wheel", (event) => {
  event.preventDefault();

  const size = map.getSize();
  if (event.ctrlKey) {
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.y : 1;
    const zoom = map.getZoom() - event.deltaY * scale * 0.01;
    map.setZoomAround(map.mouseEventToContainerPoint(event), zoom, { animate: false });
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

    if (x !== 0 || y !== 0) {
      map.panBy([x, y], { animate: false });
    }
  });
}, { passive: false });
