const { test } = require('node:test');
const assert = require('node:assert/strict');
const features = require('./static/js/walk-features.js');
const origin = { lat: 35.7787, lng: 139.4966 };
const manual = { version: 1, confirmed: true, source: 'manual', distanceMeters: 4200, durationSeconds: 3600 };

test('old place records are never counted as walks; explicit walks stay split by month and source', () => {
  const visits = [
    { date: '2026-11-01', ...origin },
    { date: '2026-11-02', walk: manual },
    { date: '2026-11-03', walk: { ...manual, source: 'route', distanceMeters: 5600, durationSeconds: 4800 } },
    { date: '2026-11-04', walk: { ...manual, distanceMeters: null, durationSeconds: null } },
    { date: '2026-10-31', walk: manual },
    { date: '2026-11-05', walk: { ...manual, confirmed: false } },
  ];
  assert.deepEqual(features.monthlyStats(visits, '2026-11'), {
    count: 3, manual: { distance: 4200, duration: 3600 }, route: { distance: 5600, duration: 4800 }, missingDistance: 1, missingDuration: 1,
  });
  assert.equal(features.monthlyStats(visits, '2026-10').count, 1);
  assert.equal(features.monthlyStats(visits, '2027-01').count, 0);
  assert.equal(visits[0].walk, undefined);
});

test('only an explicit confirmation creates a walk, with optional metrics and no invented zeros', () => {
  assert.equal(features.walkFromInput({ confirmed: false, source: 'route', distanceKm: '10', minutes: '150' }), undefined);
  assert.deepEqual(features.walkFromInput({ confirmed: true, source: 'manual', distanceKm: '', minutes: '' }), {
    version: 1, confirmed: true, source: 'manual', distanceMeters: null, durationSeconds: null,
  });
  assert.equal(features.walkFromInput({ confirmed: true, source: 'route', distanceKm: '1.234', minutes: '20.5' }).distanceMeters, 1234);
  assert.equal(features.walkFromInput({ confirmed: true, source: 'manual', distanceKm: '0', minutes: '0' }).durationSeconds, 0);
  for (const value of ['-1', 'NaN', 'Infinity', '1e309', 'text']) {
    assert.throws(() => features.walkFromInput({ confirmed: true, source: 'manual', distanceKm: value, minutes: '10' }));
    assert.throws(() => features.walkFromInput({ confirmed: true, source: 'manual', distanceKm: '1', minutes: value }));
  }
  assert.throws(() => features.walkFromInput({ confirmed: true, source: 'gps', distanceKm: '1', minutes: '10' }));
  assert.equal(features.validWalk({ ...manual, distanceMeters: '4200' }), false);
  assert.equal(features.validWalk({ ...manual, durationSeconds: NaN }), false);
});

test('route endpoint distance rejects unknown coordinates and respects the registration vicinity', () => {
  assert.equal(features.meters(origin, origin), 0);
  assert.equal(features.meters(origin, { ...origin, lng: NaN }), Infinity);
  assert.equal(features.meters(origin, null), Infinity);
  assert.ok(features.meters(origin, { ...origin, lat: origin.lat + .001 }) < 300);
  assert.ok(features.meters(origin, { ...origin, lat: origin.lat + .01 }) > 300);
});
