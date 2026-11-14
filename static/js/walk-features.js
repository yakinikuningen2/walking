// Data-only helpers shared by the browser and Node tests. No network requests.
((root) => {
  "use strict";
  function validPoint(p) {
    return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  }
  function meters(a, b) {
    if (!validPoint(a) || !validPoint(b)) return Infinity;
    const rad = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2
      + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  function validWalk(walk) {
    return !!walk && walk.version === 1 && walk.confirmed === true && ["manual", "route"].includes(walk.source)
      && [walk.distanceMeters, walk.durationSeconds].every(value => value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0));
  }
  function walkFromInput({ confirmed, source, distanceKm, minutes }) {
    if (!confirmed) return undefined;
    const number = (value, factor) => {
      if (typeof value !== "string" || !value.trim()) return null;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isFinite(parsed * factor)) throw new Error("Invalid walk value");
      return Math.round(parsed * factor * 1000) / 1000;
    };
    const walk = { version: 1, confirmed: true, source, distanceMeters: number(distanceKm, 1000), durationSeconds: number(minutes, 60) };
    if (!validWalk(walk)) throw new Error("Invalid walk record");
    return walk;
  }
  function monthlyStats(visits, month) {
    const stats = { count: 0, manual: { distance: 0, duration: 0 }, route: { distance: 0, duration: 0 }, missingDistance: 0, missingDuration: 0 };
    for (const visit of visits) {
      if (typeof visit.date !== "string" || visit.date.slice(0, 7) !== month || !validWalk(visit.walk)) continue;
      stats.count++;
      if (visit.walk.distanceMeters === null) stats.missingDistance++;
      else stats[visit.walk.source].distance += visit.walk.distanceMeters;
      if (visit.walk.durationSeconds === null) stats.missingDuration++;
      else stats[visit.walk.source].duration += visit.walk.durationSeconds;
    }
    return stats;
  }
  const api = { meters, validWalk, walkFromInput, monthlyStats };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WalkingFeatures = api;
})(globalThis);
