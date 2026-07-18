import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aimFromOrientation, compassToAimAzimuth, destPoint, groundDistForAltitude,
  projectRay, flToMeters, horizontalDerivatives, FL_LADDER, MAX_RANGE_KM,
} from '../geometry.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b} (eps ${eps})`);

// ---------- aimFromOrientation: physically anchored cases (back camera = −Z) ----------

test('upright phone facing north → bearing 0, elevation 0', () => {
  const { bearingDeg, elevationDeg } = aimFromOrientation(0, 90, 0);
  close(elevationDeg, 0, 1e-9);
  assert.ok(bearingDeg < 1e-6 || bearingDeg > 360 - 1e-6);
});

test('flat on table, screen up → camera points at the ground (−90)', () => {
  const { elevationDeg } = aimFromOrientation(0, 0, 0);
  close(elevationDeg, -90, 1e-9);
});

test('screen down (beta 180) → camera at zenith (+90)', () => {
  const { elevationDeg } = aimFromOrientation(0, 180, 0);
  close(elevationDeg, 90, 1e-9);
});

test('upright phone yawed 90° CCW (alpha 90) → camera faces west (270)', () => {
  const { bearingDeg, elevationDeg } = aimFromOrientation(90, 90, 0);
  close(elevationDeg, 0, 1e-9);
  close(bearingDeg, 270, 1e-9);
});

test('45° skyward tilt facing north → elevation 45', () => {
  const { bearingDeg, elevationDeg } = aimFromOrientation(0, 135, 0);
  close(elevationDeg, 45, 1e-9);
  assert.ok(bearingDeg < 1e-6 || bearingDeg > 360 - 1e-6);
});

test('null/undefined orientation values treated as 0', () => {
  const r = aimFromOrientation(null, undefined, 0);
  close(r.elevationDeg, -90, 1e-9);
});

// ---------- compass ↔ screen rotation ----------

test('compass correction: portrait passthrough, landscape ±90, wraps', () => {
  close(compassToAimAzimuth(120, 0), 120);
  close(compassToAimAzimuth(120, 90), 210);
  close(compassToAimAzimuth(300, 90), 30);       // wrap over 360
  close(compassToAimAzimuth(30, 270), 300);      // CW-rotated body (window.orientation −90 ≡ 270)
});

// ---------- destPoint ----------

const ONE_DEG_M = Math.PI / 180 * 6371000; // 111194.93 m

test('destPoint east along the equator: 1° of longitude', () => {
  const p = destPoint(0, 0, 90, ONE_DEG_M);
  close(p.lat, 0, 1e-9);
  close(p.lon, 1, 1e-9);
});

test('destPoint north: 1° of latitude', () => {
  const p = destPoint(0, 0, 0, ONE_DEG_M);
  close(p.lat, 1, 1e-9);
  close(p.lon, 0, 1e-9);
});

test('destPoint zero distance → identity', () => {
  const p = destPoint(41.9, -87.6, 123, 0);
  close(p.lat, 41.9, 1e-9);
  close(p.lon, -87.6, 1e-9);
});

test('destPoint wraps across the antimeridian', () => {
  const p = destPoint(0, 179.95, 90, ONE_DEG_M * 0.1);
  close(p.lon, -179.95, 1e-6);
});

test('destPoint round trip out-and-back along a meridian (exact on a sphere)', () => {
  const out = destPoint(45, 10, 0, 50000);
  const back = destPoint(out.lat, out.lon, 180, 50000);
  close(back.lat, 45, 1e-9);
  close(back.lon, 10, 1e-9);
});

test('destPoint oblique out-and-back returns within meridian-convergence error', () => {
  const out = destPoint(45, 10, 60, 50000);
  const back = destPoint(out.lat, out.lon, 240, 50000);
  close(back.lat, 45, 0.01);   // ~1.1 km tolerance — inherent reverse-azimuth error
  close(back.lon, 10, 0.01);
});

// ---------- groundDistForAltitude ----------

test('45° elevation: ground distance equals height difference', () => {
  const { distM, shallowFlag } = groundDistForAltitude(10000, 45);
  close(distM, 10000, 1e-6);
  assert.equal(shallowFlag, false);
});

test('shallow elevation (≤3°) clamps to MAX_RANGE and flags', () => {
  const r = groundDistForAltitude(10000, 3);
  assert.equal(r.distM, MAX_RANGE_KM * 1000);
  assert.equal(r.shallowFlag, true);
});

test('distance beyond MAX_RANGE clamps and flags (low elevation, high FL)', () => {
  const r = groundDistForAltitude(30000, 4); // 30 km up at 4° → ~429 km ground distance
  assert.equal(r.distM, MAX_RANGE_KM * 1000);
  assert.equal(r.shallowFlag, true);
});

test('overhead (≥89°) → distance 0', () => {
  const r = groundDistForAltitude(10000, 89.5);
  assert.equal(r.distM, 0);
  assert.equal(r.overheadFlag, true);
});

// ---------- projectRay ----------

test('straight up: every FL samples the observer location (spec sanity test)', () => {
  const obs = { lat: 41.88, lon: -87.63, altMeters: 200 };
  const pts = projectRay(obs, 123, 90);
  assert.equal(pts.length, FL_LADDER.length);
  for (const p of pts) {
    close(p.lat, obs.lat, 1e-9);
    close(p.lon, obs.lon, 1e-9);
    assert.equal(p.groundDistKm, 0);
  }
});

test('observer above a flight level → belowObserver flag, no NaN', () => {
  const obs = { lat: 47, lon: 8, altMeters: 3000 }; // above FL050 (1524 m)
  const pts = projectRay(obs, 0, 45);
  const fl050 = pts.find(p => p.fl === 50);
  assert.equal(fl050.belowObserver, true);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.groundDistKm));
  }
});

test('FL→meters conversion', () => {
  close(flToMeters(350), 350 * 100 * 0.3048);
  close(flToMeters(50), 1524, 1e-9);
});

test('projectRay 45° north: FL300 lands ~9.1 km minus observer alt north', () => {
  const obs = { lat: 0, lon: 0, altMeters: 0 };
  const pts = projectRay(obs, 0, 45);
  const fl300 = pts.find(p => p.fl === 300);
  const expectM = flToMeters(300); // dh = dist at 45°
  close(fl300.groundDistKm, expectM / 1000, 1e-6);
  close(fl300.lat, (expectM / ONE_DEG_M), 1e-4);
  close(fl300.lon, 0, 1e-9);
});

// ---------- horizontalDerivatives (phase 2) ----------

test('horizontalDerivatives: symmetric ±10 m/s over ±0.25° at equator', () => {
  const d = horizontalDerivatives(0, 0.25, { uE: 10, uW: -10, uN: 0, uS: 0, vE: 0, vW: 0, vN: 5, vS: -5 });
  const dy = 2 * 0.25 * Math.PI / 180 * 6371000;
  close(d.dudx, 20 / dy, 1e-12); // cos(0)=1 → dx = dy
  close(d.dvdy, 10 / dy, 1e-12);
  close(d.dudy, 0, 1e-12);
});
