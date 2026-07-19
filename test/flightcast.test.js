import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkRoute, evaluateRoute, reFeel, worstSegments } from '../flightcast.js';
import { buildFlightPath } from '../route.js';
import { PRESSURE_LEVELS } from '../turbulence.js';

const ORD = { lat: 41.9786, lon: -87.9048 };
const DEN = { lat: 39.8617, lon: -104.6732 };
const DEP = Date.parse('2026-07-18T15:00:00Z');

test('chunkRoute: consecutive chunks with per-chunk hour windows', () => {
  const fp = buildFlightPath(ORD, DEN);
  const chunks = chunkRoute(fp.points, DEP, 15);
  assert.equal(chunks.reduce((n, c) => n + c.points.length, 0), fp.points.length);
  assert.equal(chunks[0].startHour, '2026-07-18T15:00');
  for (const c of chunks) {
    assert.match(c.startHour, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
    assert.ok(c.endHour > c.startHour);
  }
  // Later chunks start no earlier than earlier chunks
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startHour >= chunks[i - 1].startHour);
  }
});

// Build a synthetic Open-Meteo per-point response with a controllable shear layer.
function mkWeather(strongShear) {
  const h = { time: ['2026-07-18T15:00', '2026-07-18T16:00', '2026-07-18T17:00'] };
  for (const p of PRESSURE_LEVELS) {
    // Rough standard-atmosphere heights per level
    const z = Math.round(44330 * (1 - Math.pow(p / 1013.25, 0.1903)));
    h[`geopotential_height_${p}hPa`] = [z, z, z];
    h[`temperature_${p}hPa`] = [15 - z * 0.0065, 15 - z * 0.0065, 15 - z * 0.0065];
    const spd = strongShear ? Math.max(0, (z - 8000) / 100) : 10; // 10 m/s per km above 8 km
    h[`wind_speed_${p}hPa`] = [spd, spd, spd];
    h[`wind_direction_${p}hPa`] = [270, 270, 270];
    h[`cloud_cover_${p}hPa`] = [z > 6000 && z < 12000 ? 60 : 0, 0, 0];
  }
  return { hourly: h };
}

test('evaluateRoute: calm atmosphere → all valid cruise rows smooth-ish, no NaN', () => {
  const fp = buildFlightPath(ORD, DEN);
  const weather = fp.points.map(() => mkWeather(false));
  const rows = evaluateRoute(fp.points, weather, DEP, 'heavy');
  assert.equal(rows.length, fp.points.length);
  const valid = rows.filter(r => !r.noData);
  assert.ok(valid.length > rows.length * 0.7, `most rows valid (${valid.length}/${rows.length})`);
  for (const r of valid) {
    assert.ok(Number.isFinite(r.layer.Ri) && Number.isFinite(r.edr));
    assert.ok(r.felt && r.cat);
  }
  // Uniform wind = zero shear → smooth
  assert.ok(valid.every(r => r.felt.key === 'smooth'));
});

test('evaluateRoute: strong shear at cruise → non-smooth felt severity + clouds carried', () => {
  const fp = buildFlightPath(ORD, DEN);
  const weather = fp.points.map(() => mkWeather(true));
  const rows = evaluateRoute(fp.points, weather, DEP, 'light');
  const cruise = rows.filter(r => !r.noData && r.point.phase === 'cruise');
  assert.ok(cruise.length > 0);
  assert.ok(cruise.some(r => r.felt.rank > 0), 'strong shear should register for light aircraft');
  assert.ok(cruise.some(r => r.cloud && r.cloud.okta !== 'CLR'), 'cloud layer detected near cruise');
});

test('reFeel switches aircraft class without touching physics', () => {
  const fp = buildFlightPath(ORD, DEN);
  const weather = fp.points.map(() => mkWeather(true));
  const rows = evaluateRoute(fp.points, weather, DEP, 'light');
  const riBefore = rows.find(r => !r.noData).layer.Ri;
  reFeel(rows, 'heavy');
  assert.equal(rows.find(r => !r.noData).layer.Ri, riBefore);
  // Heavy jet should never feel MORE than light aircraft
  const light = evaluateRoute(fp.points, weather, DEP, 'light');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].noData) continue;
    assert.ok(rows[i].felt.rank <= light[i].felt.rank);
  }
});

test('worstSegments merges runs, ranks severe first, empty when smooth', () => {
  const fp = buildFlightPath(ORD, DEN);
  const calm = evaluateRoute(fp.points, fp.points.map(() => mkWeather(false)), DEP, 'heavy');
  assert.equal(worstSegments(calm).length, 0);
  const rough = evaluateRoute(fp.points, fp.points.map(() => mkWeather(true)), DEP, 'light');
  const worst = worstSegments(rough);
  assert.ok(worst.length >= 1 && worst.length <= 3);
  for (const s of worst) {
    assert.ok(s.toMin >= s.fromMin);
    assert.ok(s.rank > 0 && s.color && s.label);
  }
});

test('evaluateRoute handles missing weather gracefully', () => {
  const fp = buildFlightPath(ORD, DEN);
  const weather = fp.points.map((_, i) => (i % 2 === 0 ? mkWeather(false) : null));
  const rows = evaluateRoute(fp.points, weather, DEP, 'heavy');
  assert.ok(rows.filter(r => r.noData).length >= Math.floor(fp.points.length / 2));
  assert.equal(rows.length, fp.points.length);
});
