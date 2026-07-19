import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  greatCircleDistanceKm, greatCirclePoint, cruiseAltFt, buildFlightPath, formatDuration,
} from '../route.js';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b} (eps ${eps})`);

const ORD = { lat: 41.9786, lon: -87.9048 };
const DEN = { lat: 39.8617, lon: -104.6732 };
const JFK = { lat: 40.6413, lon: -73.7781 };
const LHR = { lat: 51.4700, lon: -0.4543 };
const SYD = { lat: -33.9399, lon: 151.1753 };
const SCL = { lat: -33.3930, lon: -70.7858 };

test('known city-pair distances (haversine)', () => {
  close(greatCircleDistanceKm(ORD.lat, ORD.lon, DEN.lat, DEN.lon), 1430, 40);
  close(greatCircleDistanceKm(JFK.lat, JFK.lon, LHR.lat, LHR.lon), 5540, 60);
  close(greatCircleDistanceKm(0, 0, 0, 1), 111.19, 0.5);
  assert.equal(greatCircleDistanceKm(41, -87, 41, -87), 0);
});

test('greatCirclePoint endpoints and midpoint sanity', () => {
  const p0 = greatCirclePoint(JFK.lat, JFK.lon, LHR.lat, LHR.lon, 0);
  const p1 = greatCirclePoint(JFK.lat, JFK.lon, LHR.lat, LHR.lon, 1);
  close(p0.lat, JFK.lat, 1e-9); close(p0.lon, JFK.lon, 1e-9);
  close(p1.lat, LHR.lat, 1e-9); close(p1.lon, LHR.lon, 1e-9);
  // North-Atlantic great circle arcs well NORTH of both endpoints' latitudes
  const mid = greatCirclePoint(JFK.lat, JFK.lon, LHR.lat, LHR.lon, 0.5);
  assert.ok(mid.lat > 52, `mid ${mid.lat} should be > 52°N`);
});

test('greatCirclePoint crosses the antimeridian cleanly (SYD→SCL)', () => {
  let prev = null;
  for (let f = 0; f <= 1.0001; f += 0.05) {
    const p = greatCirclePoint(SYD.lat, SYD.lon, SCL.lat, SCL.lon, Math.min(1, f));
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon));
    assert.ok(p.lon >= -180 && p.lon <= 180);
    prev = p;
  }
});

test('cruise altitude grows with stage length', () => {
  assert.ok(cruiseAltFt(300) < cruiseAltFt(800));
  assert.ok(cruiseAltFt(800) < cruiseAltFt(3000));
  assert.ok(cruiseAltFt(3000) <= cruiseAltFt(6000));
  assert.equal(cruiseAltFt(6000), 38000);
});

test('buildFlightPath ORD→DEN: structure, monotonic time, ordered phases', () => {
  const fp = buildFlightPath(ORD, DEN);
  assert.equal(fp.points.length, 40);
  close(fp.totalKm, 1430, 40);
  // ~2h for ORD→DEN at these speeds
  assert.ok(fp.durationMin > 90 && fp.durationMin < 160, `duration ${fp.durationMin}`);
  assert.equal(fp.cruiseFt, 34000);

  let lastT = -1;
  const phaseOrder = { climb: 0, cruise: 1, descent: 2 };
  let lastPhase = 0;
  for (const p of fp.points) {
    assert.ok(p.tMin > lastT, 'time strictly increasing');
    lastT = p.tMin;
    assert.ok([p.lat, p.lon, p.altM, p.distKm].every(Number.isFinite));
    assert.ok(p.altM >= 0 && p.altFt <= fp.cruiseFt);
    assert.ok(phaseOrder[p.phase] >= lastPhase, 'phases ordered climb→cruise→descent');
    lastPhase = phaseOrder[p.phase];
  }
  assert.equal(fp.points[0].phase, 'climb');
  assert.equal(fp.points.at(-1).phase, 'descent');
  close(fp.points.at(-1).altM, 0, 1);
  close(fp.points.at(-1).tMin, fp.durationMin, 1e-6);
});

test('short hop reduces cruise altitude so the profile fits', () => {
  const fp = buildFlightPath({ lat: 41.9786, lon: -87.9048 }, { lat: 42.9634, lon: -85.6681 }); // ORD→GRR ~190 km
  assert.ok(fp.cruiseFt < 24000, `short hop cruise ${fp.cruiseFt} should be reduced`);
  assert.ok(fp.cruiseFt >= 10000);
  assert.ok(fp.points.some(p => p.phase === 'cruise') || fp.points.some(p => p.phase === 'descent'));
});

test('degenerate same-airport route returns null', () => {
  assert.equal(buildFlightPath(ORD, ORD), null);
});

test('formatDuration', () => {
  assert.equal(formatDuration(125), '2h 05m');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(NaN), '—');
});
