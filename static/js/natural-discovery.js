// OSM nature is not itself a walking destination. Resolve it to a mapped path/entrance.
// Raw Overpass data stays in this short-lived cache; it is not a bundled database.
const NATURAL_KINDS = ["forest", "waterside", "coast"];
const naturalDataCache = new Map();
const NATURAL_LIMIT = 32;
const NATURAL_NEAR_METERS = 120;
const NATURAL_DENIED = /^(no|private|permit|customers|members|military|agricultural|forestry|restricted|official|emergency|delivery)$/;
const NATURAL_ROADS = /^(footway|path|pedestrian|steps|track|residential|living_street|service|unclassified)$/;

function naturalAllowed(tags = {}) {
  return !NATURAL_DENIED.test(tags.access || "") && !NATURAL_DENIED.test(tags.foot || "")
    && !["use_sidepath"].includes(tags.foot) && tags.locked !== "yes" && tags.opening_hours !== "closed"
    && !["yes", "true"].includes(tags.disused) && !["yes", "true"].includes(tags.abandoned)
    && !tags.construction && !tags.proposed && !tags["disused:highway"] && !tags["abandoned:highway"];
}

function naturalXY(point, origin) {
  const delta = ((point.lng - origin.lng + 540) % 360) - 180;
  return { x: delta * 111195 * Math.max(.001, Math.cos(origin.lat * Math.PI / 180)), y: (point.lat - origin.lat) * 111195 };
}

function naturalLatLng(point, origin) {
  return { lat: origin.lat + point.y / 111195,
    lng: ((origin.lng + point.x / (111195 * Math.max(.001, Math.cos(origin.lat * Math.PI / 180))) + 540) % 360) - 180 };
}

function naturalProject(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function naturalGap(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function naturalClosest(a, b, c, d) {
  const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
  const cross = ux * vy - uy * vx;
  if (Math.abs(cross) > 1e-9) {
    const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / cross;
    const s = ((c.x - a.x) * uy - (c.y - a.y) * ux) / cross;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return { x: a.x + t * ux, y: a.y + t * uy };
  }
  return [a, b, naturalProject(c, a, b), naturalProject(d, a, b)]
    .sort((p, q) => naturalGap(p, naturalProject(p, c, d)) - naturalGap(q, naturalProject(q, c, d)))[0];
}

function naturalLines(element, origin, includeInner = false) {
  const raw = element.type === "node" ? [[{ lat: element.lat, lon: element.lon }]]
    : element.naturalParts || (Array.isArray(element.geometry) ? [element.geometry]
      : (element.members || []).filter(m => (includeInner || m.role !== "inner") && Array.isArray(m.geometry)).map(m => m.geometry));
  const lines = [];
  for (const geometry of raw) {
    let line = [];
    for (const point of geometry) {
      if (!point || !validCoordinates(point.lat, point.lon)) { if (line.length) lines.push(line); line = []; continue; }
      line.push(naturalXY({ lat: point.lat, lng: point.lon }, origin));
    }
    if (line.length) lines.push(line);
  }
  return lines;
}

function naturalSegments(lines) {
  return lines.flatMap(line => line.length === 1 ? [[line[0], line[0]]] : line.slice(1).map((p, i) => [line[i], p]));
}

function naturalGeometryCount(element) {
  return (element.geometry?.length || 0) + (element.naturalParts || []).reduce((n, part) => n + part.length, 0)
    + (element.members || []).reduce((n, member) => n + (member.geometry?.length || 0), 0);
}

function naturalRings(element, origin, inner = false) {
  const pieces = element.type === "way" && !inner ? naturalLines(element, origin)
    : element.type === "relation" ? (element.members || [])
      .filter(m => (m.role === "inner") === inner && Array.isArray(m.geometry))
      .flatMap(m => naturalLines({ type: "way", geometry: m.geometry }, origin)) : [];
  // Multipolygon rings can consist of several ways, in either direction.
  const pending = pieces.map(line => [...line]), rings = [];
  while (pending.length) {
    const line = pending.shift();
    while (line.length > 1 && naturalGap(line[0], line.at(-1)) > .05) {
      const i = pending.findIndex(other => naturalGap(line.at(-1), other[0]) < .05 || naturalGap(line.at(-1), other.at(-1)) < .05);
      if (i < 0) break;
      const next = pending.splice(i, 1)[0];
      if (naturalGap(line.at(-1), next.at(-1)) < .05) next.reverse();
      line.push(...next.slice(1));
    }
    if (line.length >= 4 && naturalGap(line[0], line.at(-1)) < .05) rings.push(line);
  }
  return rings;
}

function naturalInside(p, ring) {
  if (!ring.bounds) {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const point of ring) { box.minX = Math.min(box.minX, point.x); box.minY = Math.min(box.minY, point.y); box.maxX = Math.max(box.maxX, point.x); box.maxY = Math.max(box.maxY, point.y); }
    ring.bounds = box;
  }
  if (p.x < ring.bounds.minX || p.x > ring.bounds.maxX || p.y < ring.bounds.minY || p.y > ring.bounds.maxY) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (naturalGap(p, naturalProject(p, a, b)) < .05) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function naturalInArea(p, outer, inner) {
  return outer.some(ring => naturalInside(p, ring)) && !inner.some(ring => naturalInside(p, ring));
}

function naturalCirclePoints(a, b, radius) {
  const dx = b.x - a.x, dy = b.y - a.y, aa = dx * dx + dy * dy;
  const bb = 2 * (a.x * dx + a.y * dy), cc = a.x * a.x + a.y * a.y - radius * radius;
  const discriminant = bb * bb - 4 * aa * cc;
  if (!aa || discriminant < 0) return [];
  return [(-bb - Math.sqrt(discriminant)) / (2 * aa), (-bb + Math.sqrt(discriminant)) / (2 * aa)]
    .filter(t => t >= 0 && t <= 1).map(t => ({ x: a.x + t * dx, y: a.y + t * dy }));
}

function naturalInTime(point, criteria, start) {
  const latlng = naturalLatLng(point, start);
  const minutes = map.distance(start, latlng) * DISCOVERY_DISTANCE_FACTOR / (criteria.speed * 1000 / 60);
  return validCoordinates(latlng.lat, latlng.lng) && minutes >= (criteria.minMinutes || 0) && minutes <= criteria.minutes
    && discoveryDirectionMatches(start, latlng, criteria.direction);
}

function naturalPointInBoxes(point, boxes) {
  return !boxes.length || boxes.some(box => {
    const [south, west, north, east] = box.split(',').map(Number);
    return point.lat >= south && point.lat <= north && (west <= east ? point.lng >= west && point.lng <= east : point.lng >= west || point.lng <= east);
  });
}

function naturalFocusPoints(feature, criteria, start, boxes = []) {
  const min = (criteria.minMinutes || 0) * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  const max = criteria.minutes * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  const points = naturalSegments(naturalLines(feature, start, true)).flatMap(([a, b]) => [a, b, naturalProject({ x: 0, y: 0 }, a, b),
    ...naturalCirclePoints(a, b, min + Math.min(80, (max - min) / 3)), ...naturalCirclePoints(a, b, (min + max) / 2)]);
  const selected = [];
  for (const point of points.filter(p => naturalPointInBoxes(naturalLatLng(p, start), boxes)
    && naturalInTime(p, { ...criteria, minMinutes: Math.max(0, (criteria.minMinutes || 0) - 5), minutes: criteria.minutes + 5 }, start))
    .sort((a, b) => naturalGap(a, { x: 0, y: 0 }) - naturalGap(b, { x: 0, y: 0 }))) {
    if (selected.every(other => naturalGap(point, other) >= 600)) selected.push(point);
    if (selected.length === 2) break;
  }
  return selected.map(p => naturalLatLng(p, start));
}

function naturalSearchBoxes(criteria, start, radius) {
  const center = { lat: Math.round(start.lat * 500) / 500, lng: Math.round(start.lng * 500) / 500 };
  if (radius <= 30000) return { boxes: [discoveryDirectionalBounds(center, radius + 250, criteria.direction)], limited: false };
  const min = (criteria.minMinutes || 0) * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  const middle = (min + radius) / 2, direction = DISCOVERY_DIRECTIONS[criteria.direction]?.bearing;
  const bearings = Number.isFinite(direction) ? [direction - 30, direction, direction + 30] : [0, 90, 180, 270];
  const boxes = bearings.map(degrees => {
    const angle = degrees * Math.PI / 180, arc = middle / 6371000, lat = start.lat * Math.PI / 180, lng = start.lng * Math.PI / 180;
    const target = Math.asin(Math.sin(lat) * Math.cos(arc) + Math.cos(lat) * Math.sin(arc) * Math.cos(angle));
    return discoveryBounds({ lat: target * 180 / Math.PI,
      lng: ((lng + Math.atan2(Math.sin(angle) * Math.sin(arc) * Math.cos(lat), Math.cos(arc) - Math.sin(lat) * Math.sin(target))) * 180 / Math.PI + 540) % 360 - 180 }, 3500);
  });
  return { boxes, limited: true };
}

async function naturalRead(query, request, timeoutMs = 10000) {
  if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const saved = naturalDataCache.get(query);
  if (saved && Date.now() - saved.at < 600000) return saved.elements;
  const elements = await fetchDiscoveryMapData(query, request, timeoutMs, false, { providerDelayMs: 1000 });
  if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (naturalDataCache.size >= 32) naturalDataCache.delete(naturalDataCache.keys().next().value);
  naturalDataCache.set(query, { at: Date.now(), elements });
  return elements;
}

function naturalIndexQuery(kinds, boxes, limit) {
  const denied = '[access!~"^(private|no|permit|customers|members|military|agricultural|forestry|restricted|official|emergency|delivery)$"][foot!~"^(no|private|permit|customers|members|military|restricted|official|emergency|delivery)$"]';
  const body = kinds.map(kind => '(' + boxes.map(bounds => discoveryTagFilters(kind).map(tags => `nwr(${bounds})`
    + Object.entries(tags).map(([key, values]) => `[${key}~"^(${values.join("|")})$"]`).join("") + denied + ';').join('')).join('')
    + `);out count;out body center ${limit + 1};`).join('');
  return `[out:json][timeout:8][maxsize:67108864];${body}`;
}

function naturalAccessCenters(points) {
  const centers = [];
  for (const point of points) {
    if (centers.some(center => map.distance(center, point) <= 250)) continue;
    centers.push({ lat: Math.round(point.lat * 1000) / 1000, lng: Math.round(point.lng * 1000) / 1000 });
  }
  return centers;
}

function naturalPathQuery(points, roads = false) {
  return '[out:json][timeout:8][maxsize:67108864];' + naturalAccessCenters(points).map(center => {
    const bounds = discoveryBounds(center, 450);
    const tags = roads ? 'residential|living_street|service|unclassified' : 'footway|path|pedestrian|steps|track';
    return `way(${bounds})[highway~"^(${tags})$"];out count;out body geom(${bounds}) 65;`;
  }).join('');
}

function naturalAccessQuery(points) {
  const outputs = [], restricted = [];
  for (const point of naturalAccessCenters(points)) {
    const center = { lat: Math.round(point.lat * 1000) / 1000, lng: Math.round(point.lng * 1000) / 1000 };
    const bounds = discoveryBounds(center, 450);
    outputs.push(`(node(${bounds})[entrance][entrance!~"^(no|exit|emergency)$"];node(${bounds})[barrier~"^(gate|lift_gate|kissing_gate|stile|entrance)$"];);out count;out body 25;`
      + `nwr(${bounds})[leisure~"^(park|garden)$"];out count;out body geom(${bounds}) 17;`);
    restricted.push(`nwr(${bounds})[access~"^(private|no|permit|customers|members|military|agricultural|forestry|restricted|official|emergency|delivery)$"];`
      + `nwr(${bounds})[foot~"^(private|no|permit|customers|members|military|restricted|official|emergency|delivery)$"];node(${bounds})[locked=yes];`);
  }
  return `[out:json][timeout:5][maxsize:67108864];${outputs.join('')}(${restricted.join('')});out count;out body geom 65;`;
}

function naturalDataTruncated(elements, limits) {
  const counts = elements.filter(e => e.type === "count");
  return counts.some((item, i) => Number(item.tags?.total) > limits[i]);
}

function naturalPathAllowed(path) {
  const tags = path.tags || {};
  return path.type === "way" && NATURAL_ROADS.test(tags.highway || "") && naturalAllowed(tags)
    && !tags.ford && tags.informal !== "yes" && !["bad", "horrible", "no"].includes(tags.trail_visibility)
    && (!tags.sac_scale || tags.sac_scale === "hiking");
}

function naturalPathBlocked(path, lines, restricted, origin) {
  for (const item of restricted) {
    if (item.type === "node") {
      if (path.nodes?.includes(item.id)) return true;
      if ((item.tags?.barrier || item.tags?.entrance || item.tags?.highway) && validCoordinates(item.lat, item.lon)
        && (path.tags?.layer || "0") === (item.tags?.layer || "0")) {
        const point = naturalXY({ lat: item.lat, lng: item.lon }, origin);
        if (naturalSegments(lines).some(([a, b]) => naturalGap(point, naturalProject(point, a, b)) < .75)) return true;
      }
      continue;
    }
    const outer = item.naturalOuter || naturalRings(item, origin), inner = item.naturalInner || naturalRings(item, origin, true);
    if (!outer.length) continue;
    for (const [a, b] of naturalSegments(lines)) {
      if (naturalInArea(a, outer, inner) || naturalInArea(b, outer, inner)) return true;
      for (const ring of outer) for (const [c, d] of naturalSegments([ring])) {
        const point = naturalClosest(a, b, c, d);
        if (naturalGap(point, naturalProject(point, c, d)) < .05) return true;
      }
    }
  }
  return false;
}

function naturalPrepareAccess(data, start) {
  if (data.some(e => !naturalAllowed(e.tags) && naturalGeometryCount(e) > 6000)) {
    return { entries: [], parks: [], paths: [], limited: true };
  }
  const restricted = data.filter(e => !naturalAllowed(e.tags) && e.type !== "count")
    .map(e => e.type === "node" ? e : { ...e, naturalOuter: naturalRings(e, start), naturalInner: naturalRings(e, start, true) });
  const entries = data.filter(e => e.type === "node" && naturalAllowed(e.tags)
    && validCoordinates(e.lat, e.lon) && (e.tags?.entrance && !["no", "exit", "emergency"].includes(e.tags.entrance)
      || /^(gate|lift_gate|kissing_gate|stile|entrance)$/.test(e.tags?.barrier)))
    .map(e => ({ ...e, xy: naturalXY({ lat: e.lat, lng: e.lon }, start) }));
  const parks = data.filter(e => naturalAllowed(e.tags) && ["park", "garden"].includes(e.tags?.leisure))
    .map(e => ({ outer: naturalRings(e, start), inner: naturalRings(e, start, true) }));
  const paths = data.filter(e => naturalPathAllowed(e) && naturalGeometryCount(e) <= 4000).map(path => ({ path, lines: naturalLines(path, start) }))
    .filter(({path,lines}) => !naturalPathBlocked(path, lines, restricted, start));
  return { entries, parks, paths };
}

function naturalResolve(feature, kind, data, criteria, start, prepared = null) {
  if (!naturalAllowed(feature.tags)) return null;
  const featureLines = naturalLines(feature, start, true), edges = naturalSegments(featureLines);
  if (!edges.length || edges.length > 6000) return null;
  const tags = feature.tags || {}, waterArea = tags.natural === "water" || tags.waterway === "riverbank" || ["lake", "pond", "harbour"].includes(tags.water);
  const outer = waterArea ? naturalRings(feature, start) : [], inner = waterArea ? naturalRings(feature, start, true) : [];
  const { entries, parks, paths } = prepared || naturalPrepareAccess(data, start);
  const candidates = [];
  const min = (criteria.minMinutes || 0) * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  const max = criteria.minutes * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  for (const {path,lines} of paths) {
    for (const [a, b] of naturalSegments(lines)) {
      const near = edges.filter(([c, d]) => Math.max(a.x, b.x) + 121 >= Math.min(c.x, d.x) && Math.min(a.x, b.x) - 121 <= Math.max(c.x, d.x)
        && Math.max(a.y, b.y) + 121 >= Math.min(c.y, d.y) && Math.min(a.y, b.y) - 121 <= Math.max(c.y, d.y));
      if (!near.length) continue;
      let closest = null, closestGap = Infinity;
      for (const [c, d] of near) {
        const p = naturalClosest(a, b, c, d), gap = naturalGap(p, naturalProject(p, c, d));
        if (gap < closestGap) { closest = p; closestGap = gap; }
      }
      const positions = [a, b, closest, naturalProject({ x: 0, y: 0 }, a, b),
        ...naturalCirclePoints(a, b, min + Math.min(40, (max - min) / 3)), ...naturalCirclePoints(a, b, (min + max) / 2)];
      for (const position of positions) {
        if (!naturalInTime(position, criteria, start)) continue;
        const gap = Math.min(...near.map(([c, d]) => naturalGap(position, naturalProject(position, c, d))));
        if (gap > NATURAL_NEAR_METERS) continue;
        const elevatedCrossing = path.tags.bridge && path.tags.bridge !== "no" || path.tags.tunnel && path.tags.tunnel !== "no";
        if (waterArea && !elevatedCrossing && (outer.length ? naturalInArea(position, outer, inner) : feature.type !== "node" || gap < 10)) continue;
        if (["river", "stream", "riverbank"].includes(tags.waterway) && !elevatedCrossing) {
          const width = /^\d+(?:\.\d+)?$/.test(tags.width || "") ? Math.min(500, Number(tags.width)) : tags.waterway === "stream" ? 2 : 6;
          if (gap < width / 2 + .5) continue;
        }
        const entry = entries.find(e => naturalGap(position, e.xy) < 12);
        const conditional = [feature.tags, path.tags, entry?.tags].some(t => t && (t["access:conditional"] || t["foot:conditional"] || t.opening_hours));
        const explicit = ["yes", "designated", "permissive"].includes(path.tags.foot) && !conditional && !(waterArea && !outer.length) && !prepared?.incomplete;
        const park = parks.some(e => naturalInArea(position, e.outer, e.inner));
        candidates.push({ point: naturalLatLng(position, start), path, entry, park, explicit, gap,
          rank: (explicit ? 0 : 1e6) + (entry ? 0 : 10000) + naturalGap(position, { x: 0, y: 0 }) });
      }
    }
  }
  const best = candidates.sort((a, b) => a.rank - b.rank || a.gap - b.gap)[0];
  if (!best) return null;
  const name = String(tags["name:ja"] || tags.name || "").slice(0, 100);
  const generic = { forest: "森", waterside: "水辺", coast: "海辺" }[kind];
  const walkway = /^(footway|path|pedestrian|steps)$/.test(best.path.tags.highway);
  const label = best.entry ? walkway ? "入口付近の歩道" : "入口付近の道"
    : best.park ? walkway ? "公園の歩道" : "公園内の道" : walkway ? "周辺の歩道" : "周辺の道";
  const note = prepared?.incomplete ? "周辺の立入制限を確認できず、徒歩アクセスは未確認"
    : best.explicit ? "OSMに徒歩通行可の記載あり・現地未確認"
      : walkway ? "徒歩アクセス未確認・OSMの歩道を候補にしています" : "徒歩アクセス未確認・OSMの道路を候補にしています";
  return { ...feature, tags: { ...tags, name: `${name || generic}・${label}`, "name:ja": `${name || generic}・${label}` },
    naturalAccess: { version: 1, kind, point: best.point, status: best.explicit ? "mapped" : "unknown", note,
      anchorType: "way", anchorId: best.path.id, featureName: name, unnamed: !name } };
}

async function findNaturalDiscoveryElements(kinds, criteria, start, radius, request, onUpdate = async () => {}) {
  const scope = naturalSearchBoxes(criteria, start, radius), limit = request.randomProbe ? 12 : NATURAL_LIMIT;
  request.natureLimited ||= scope.limited;
  const raw = await naturalRead(naturalIndexQuery(kinds, scope.boxes, limit), request);
  request.natureLimited ||= naturalDataTruncated(raw, kinds.map(() => limit));
  const pool = mergeDiscoveryElements(raw.filter(e => ["node", "way", "relation"].includes(e.type)
    && Number.isSafeInteger(e.id) && e.id > 0 && naturalAllowed(e.tags) && kinds.some(k => discoveryKindMatches(e.tags || {}, k))));
  const min = (criteria.minMinutes || 0) * criteria.speed * 1000 / 60 / DISCOVERY_DISTANCE_FACTOR;
  pool.sort((a, b) => {
    const p = discoveryPoint(a), q = discoveryPoint(b), middle = (min + radius) / 2;
    return (p ? Math.abs(map.distance(start, p) - middle) : Infinity) - (q ? Math.abs(map.distance(start, q) - middle) : Infinity);
  });
  const maxFeatures = request.kindProbe ? 1 : request.randomProbe ? 4 : 12;
  if (pool.length > maxFeatures) request.natureLimited = true;
  const selected = pool.slice(0, maxFeatures), results = [];
  for (let offset = 0; offset < selected.length; offset += 4) {
    if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const batch = selected.slice(offset, offset + 4);
    try {
      const ids = ["node", "way", "relation"].map(type => {
        const values = batch.filter(e => e.type === type).map(e => e.id);
        return values.length ? `${type}(id:${values.join(',')});` : "";
      }).join('');
      // Bounding geometry avoids downloading an entire long river/coast relation.
      const geometry = await naturalRead(`[out:json][timeout:8][maxsize:67108864];(${ids})->.features;`
        + scope.boxes.map(box => `.features out body geom(${box});`).join(''), request);
      const features = batch.map(base => {
        const parts = geometry.filter(e => e.type === base.type && e.id === base.id);
        if (parts.length < 2) return { ...base, ...parts[0] };
        return base.type === "way" ? { ...base, ...parts[0], geometry: undefined, naturalParts: parts.map(e => e.geometry).filter(Array.isArray) }
          : base.type === "relation" ? { ...base, ...parts[0], members: parts.flatMap(e => e.members || []) } : { ...base, ...parts[0] };
      });
      const bounded = features.filter(e => naturalGeometryCount(e) <= 6000);
      if (bounded.length < features.length) request.natureLimited = true;
      const points = naturalAccessCenters(bounded.flatMap(e => naturalFocusPoints(e, criteria, start, scope.boxes)));
      if (!points.length) { request.natureAccessUnresolved = true; continue; }
      let paths = await naturalRead(naturalPathQuery(points), request);
      let pathsLimited = naturalDataTruncated(paths, points.map(() => 65));
      if (!paths.some(naturalPathAllowed)) {
        paths = await naturalRead(naturalPathQuery(points, true), request);
        pathsLimited ||= naturalDataTruncated(paths, points.map(() => 65));
      }
      request.natureLimited ||= pathsLimited;
      if (!paths.some(naturalPathAllowed)) { request.natureAccessUnresolved = true; continue; }
      let access = [], incomplete = pathsLimited;
      try { access = await naturalRead(naturalAccessQuery(points), request, 6000); }
      catch (error) {
        if (request.controller.signal.aborted || error.routeCode === "MapQuery" || [400,422].includes(error.httpStatus)) throw error;
        request.natureUnavailable = true; incomplete = true;
      }
      const accessLimited = naturalDataTruncated(access, [...points.flatMap(() => [25, 17]), 65]);
      request.natureLimited ||= accessLimited;
      const elements = mergeDiscoveryElements([...paths,...access].filter(e => e.type !== "count"));
      const prepared = naturalPrepareAccess(elements, start);
      prepared.incomplete = incomplete || accessLimited;
      request.natureLimited ||= prepared.limited;
      for (const feature of bounded) {
        const kind = kinds.find(k => discoveryKindMatches(feature.tags || {}, k));
        const result = naturalResolve(feature, kind, elements, criteria, start, prepared);
        if (result) results.push(result); else request.natureAccessUnresolved = true;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      }
      if (request.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      await onUpdate([...results]);
    } catch (error) {
      if (request.controller.signal.aborted) throw error;
      if (!results.length) throw error;
      request.natureUnavailable = true;
      break;
    }
  }
  return results;
}

let naturalResultLayer = null;
const naturalResultMarkers = new Map();
const naturalLeafSVG = '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><circle cx="14" cy="14" r="12" fill="#fff" stroke="#245744" stroke-width="1.5"/><path d="M8 18C7 10 12 7 21 7c0 9-4 13-11 12M7 22 19 10" fill="none" stroke="#245744" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderNaturalDiscoveryMarkers(places) {
  const natural = places.filter(discoveryNaturalPlaceReady);
  if (!naturalResultLayer && natural.length) naturalResultLayer = L.layerGroup().addTo(map);
  for (const [key, marker] of naturalResultMarkers) {
    if (!natural.some(p => p.key === key)) { naturalResultLayer.removeLayer(marker); naturalResultMarkers.delete(key); }
  }
  for (const place of natural) {
    let marker = naturalResultMarkers.get(place.key);
    const signature = `${place.lat},${place.lng}|${place.name}|${place.accessNote}|${place.accessAnchor.id}`;
    if (marker?.naturalSignature === signature) continue;
    const popup = document.createElement("div");
    popup.className = "natural-place-popup";
    popup.append(textElement("strong", place.name), textElement("p", place.accessNote || "徒歩アクセス未確認"));
    const source = document.createElement("a");
    source.href = `https://www.openstreetmap.org/way/${place.accessAnchor.id}`;
    source.textContent = "OSMの歩道情報"; source.target = "_blank"; source.rel = "noopener";
    const button = document.createElement("button");
    button.type = "button"; button.textContent = "目的地に指定";
    button.addEventListener("click", () => { setDiscoveryOpen(false, false); setDestination(place); });
    popup.append(source, button);
    if (!marker) {
      marker = L.marker([place.lat, place.lng], { icon: L.divIcon({ className: "natural-result-marker", html: naturalLeafSVG,
        iconSize: [28, 28], iconAnchor: [14, 14] }), title: place.name, bubblingMouseEvents: false }).addTo(naturalResultLayer);
      naturalResultMarkers.set(place.key, marker);
    } else marker.setLatLng([place.lat, place.lng]);
    marker.bindPopup(popup, { autoPan: false });
    marker.naturalSignature = signature;
  }
  let legend = document.getElementById("natural-result-legend");
  if (!legend && natural.length) {
    legend = document.createElement("span"); legend.id = "natural-result-legend"; legend.className = "legend-item";
    const icon = document.createElement("span"); icon.className = "natural-legend-icon"; icon.innerHTML = naturalLeafSVG;
    legend.append(icon, document.createTextNode("自然スポットの徒歩候補"));
    document.querySelector(".map-legend")?.append(legend);
  }
  if (legend) legend.hidden = !natural.length;
}

function syncNaturalDestinationNote(place) {
  let note = document.getElementById("natural-destination-note");
  if (!note && place?.accessNote) {
    note = document.createElement("p"); note.id = "natural-destination-note"; note.className = "natural-access-note";
    document.getElementById("destination-name").after(note);
  }
  if (note) { note.textContent = place?.accessNote || ""; note.hidden = !place?.accessNote; }
}
