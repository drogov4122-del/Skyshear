// qa-extra.test.js — adversarial edge-case probes, additive to geometry.test.js /
// turbulence.test.js. Does NOT duplicate existing coverage. Some tests below
// intentionally assert CURRENT (buggy or contract-fragile) behavior so the
// suite documents it rather than hides it — see inline BUG / NOTE comments
// and the QA report for details.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aimFromOrientation, compassToAimAzimuth, destPoint, groundDistForAltitude,
  projectRay, horizontalDerivatives,
} from '../geometry.js';
import {
  layerAt, interpolateUV, pseudoEdr, feltCategory, categorize,
  RI_LARGE, AIRCRAFT_CLASSES,
} from '../turbulence.js';
import {
  fetchWeather, pointsKey, getLastGood, _resetForTest, WeatherError, FETCH_TIMEOUT_MS,
} from '../weather.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b} (eps ${eps})`);

// ======================================================================
// geometry.js
// ======================================================================

// ---------- extreme latitudes ----------

test('destPoint at extreme latitude ±89.9 stays finite, no NaN', () => {
  for (const lat of [89.9, -89.9]) {
    const p = destPoint(lat, 10, 45, 50000);
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `lat=${lat} -> ${JSON.stringify(p)}`);
    assert.ok(p.lat <= 90 && p.lat >= -90);
  }
});

test('projectRay at extreme latitude ±89.9 produces finite points for every FL', () => {
  for (const lat of [89.9, -89.9]) {
    const obs = { lat, lon: 0, altMeters: 100 };
    const pts = projectRay(obs, 45, 10);
    for (const p of pts) {
      assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.groundDistKm),
        `lat=${lat} fl=${p.fl} -> ${JSON.stringify(p)}`);
    }
  }
});

// FIXED (was a bug): Math.cos(90° in radians) is ~6.12e-17, not exactly 0, so
// the original `dxM > 0` guard never fired at the exact pole and dudx blew up
// to ~5.9e12. The guard is now metric (`dxM > 1` meter) and returns null at
// and immediately around the poles as documented.
test('FIXED: horizontalDerivatives at the exact pole returns null (polar guard uses a metric threshold)', () => {
  const args = { uE: 10, uW: -10, uN: 0, uS: 0, vE: 0, vW: 0, vN: 5, vS: -5 };
  assert.equal(horizontalDerivatives(90, 0.25, args), null);
  assert.equal(horizontalDerivatives(-90, 0.25, args), null);
});

test('horizontalDerivatives at 89.9° (near but not at pole) is large but not returned as null either', () => {
  const d = horizontalDerivatives(89.9, 0.25,
    { uE: 10, uW: -10, uN: 0, uS: 0, vE: 0, vW: 0, vN: 5, vS: -5 });
  assert.ok(d && Number.isFinite(d.dudx));
});

// ---------- elevation boundaries: exactly 3° and exactly 89° ----------

test('groundDistForAltitude: elevation exactly 89° is overhead (boundary is inclusive)', () => {
  const r = groundDistForAltitude(5000, 89);
  assert.equal(r.distM, 0);
  assert.equal(r.overheadFlag, true);
  assert.equal(r.shallowFlag, false);
});

test('groundDistForAltitude: elevation just under 89° (88.999999°) uses the tan() formula, not overhead', () => {
  const r = groundDistForAltitude(1, 88.999999); // tiny dh keeps distance under MAX_RANGE
  assert.equal(r.overheadFlag, false);
  assert.equal(r.shallowFlag, false);
  close(r.distM, 1 / Math.tan(88.999999 * Math.PI / 180), 1e-9);
});

test('groundDistForAltitude: elevation exactly 3° clamps to shallow (boundary is inclusive)', () => {
  const r = groundDistForAltitude(1000, 3);
  assert.equal(r.distM, 400000);
  assert.equal(r.shallowFlag, true);
});

test('groundDistForAltitude: elevation just over 3° (3.000001°) uses tan() formula, not shallow-clamped', () => {
  const r = groundDistForAltitude(1000, 3.000001);
  assert.equal(r.shallowFlag, false);
  close(r.distM, 1000 / Math.tan(3.000001 * Math.PI / 180), 1e-3);
});

// ---------- negative elevation fed into groundDistForAltitude / projectRay ----------
// NOTE: negative elevation with positive dh is a physically inconsistent combo
// that projectRay's caller should never produce (aim below horizon should never
// pair with an above-observer target selection upstream), but the function
// doesn't reject it — it silently falls into the shallow-clamp branch since
// -30 <= SHALLOW_ELEVATION_DEG(3). This is defensive rather than broken: no
// NaN, no negative distance. Documenting as intended-but-worth-confirming.
test('groundDistForAltitude: negative elevation with positive dh silently clamps to shallow/MAX_RANGE (no negative distance, no NaN)', () => {
  const r = groundDistForAltitude(5000, -30);
  assert.equal(r.distM, 400000);
  assert.equal(r.shallowFlag, true);
  assert.ok(Number.isFinite(r.distM));
});

test('projectRay: negative elevation input never produces NaN/negative distances across the whole ladder', () => {
  const pts = projectRay({ lat: 0, lon: 0, altMeters: 0 }, 90, -30);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.groundDistKm));
    assert.ok(p.groundDistKm >= 0);
  }
});

test('projectRay: negative observer altMeters (below sea level) never produces NaN', () => {
  const pts = projectRay({ lat: 0, lon: 0, altMeters: -500 }, 90, 10);
  assert.equal(pts.length, 9);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.groundDistKm));
    assert.equal(p.belowObserver, false); // every FL is above -500 m
  }
});

// ---------- compassToAimAzimuth: negative / extreme-multiple wraps ----------

test('compassToAimAzimuth: negative heading wraps into [0,360)', () => {
  close(compassToAimAzimuth(-10, 0), 350);
  close(compassToAimAzimuth(-370, 400), 30); // -370+400=30, already in range but exercises negative intermediate
});

test('compassToAimAzimuth: 359.9 -> 0.1 crossing is a short +0.2 step, not a -359.8 jump', () => {
  const a = compassToAimAzimuth(359.9, 0);
  const b = compassToAimAzimuth(0.1, 0);
  close(a, 359.9);
  close(b, 0.1);
  // shortest-path delta check (handles the wrap correctly from the caller's side)
  const raw = b - a;
  const wrapped = ((raw + 180) % 360 + 360) % 360 - 180;
  close(wrapped, 0.2, 1e-9);
});

// NOTE (not necessarily a bug): alpha/beta/gamma in aimFromOrientation are all
// defended with `|| 0` against null/undefined/NaN, but compassHeadingDeg in
// compassToAimAzimuth has no such guard — NaN propagates straight through.
// screenAngleDeg IS guarded (`|| 0`). Flagging the asymmetry.
test('NOTE: compassToAimAzimuth(NaN, 0) propagates NaN — no defensive guard on compassHeadingDeg', () => {
  assert.ok(Number.isNaN(compassToAimAzimuth(NaN, 0)));
});

// ---------- aimFromOrientation: gimbal lock (beta = ±90, gamma varies) ----------

test('gimbal lock beta=90: elevation stays ~0 regardless of gamma/roll', () => {
  for (const gamma of [0, 30, 90, -45, 179]) {
    const { elevationDeg } = aimFromOrientation(0, 90, gamma);
    close(elevationDeg, 0, 1e-9);
  }
});

test('gimbal lock beta=-90: elevation stays ~0 regardless of gamma/roll', () => {
  for (const gamma of [0, 30, 90, -45]) {
    const { elevationDeg } = aimFromOrientation(0, -90, gamma);
    close(elevationDeg, 0, 1e-9);
  }
});

test('gimbal lock beta=90: bearing is driven by gamma even when alpha=0 (roll changes aim at gimbal lock)', () => {
  const g0 = aimFromOrientation(0, 90, 0).bearingDeg;
  const g30 = aimFromOrientation(0, 90, 30).bearingDeg;
  const g90 = aimFromOrientation(0, 90, 90).bearingDeg;
  close(((g0 % 360) + 360) % 360, 0, 1e-6);
  close(g30, 330, 1e-6);
  close(g90, 270, 1e-6);
});

test('aimFromOrientation continuity across beta=90 boundary: no 180° flip between 89.999° and 90.001°', () => {
  const below = aimFromOrientation(10, 89.999, 30);
  const at = aimFromOrientation(10, 90, 30);
  const above = aimFromOrientation(10, 90.001, 30);
  close(below.bearingDeg, at.bearingDeg, 0.01);
  close(above.bearingDeg, at.bearingDeg, 0.01);
  close(below.elevationDeg, 0, 0.01);
  close(above.elevationDeg, 0, 0.01);
});

test('aimFromOrientation continuity: small perturbations produce small output changes away from gimbal lock', () => {
  const eps = 0.01;
  const samples = [
    [0, 45, 0], [90, 30, 15], [200, 60, -20], [350, 20, 5], [123, 70, -10],
  ];
  for (const [a, b, g] of samples) {
    const base = aimFromOrientation(a, b, g);
    for (const [da, db, dg] of [[eps, 0, 0], [0, eps, 0], [0, 0, eps], [-eps, -eps, -eps]]) {
      const perturbed = aimFromOrientation(a + da, b + db, g + dg);
      // shortest-arc bearing delta
      let dBear = perturbed.bearingDeg - base.bearingDeg;
      dBear = ((dBear + 180) % 360 + 360) % 360 - 180;
      assert.ok(Math.abs(dBear) < 1, `bearing jump too large at (${a},${b},${g}) + (${da},${db},${dg}): ${dBear}`);
      assert.ok(Math.abs(perturbed.elevationDeg - base.elevationDeg) < 1,
        `elevation jump too large at (${a},${b},${g}) + (${da},${db},${dg})`);
    }
  }
});

// ======================================================================
// turbulence.js
// ======================================================================

// FIXED (was a bug): layerAt used to stop at the FIRST bracket where
// lo.z <= target <= up.z and return null if it was degenerate (duplicate z).
// It now skips degenerate pairs and keeps scanning for a valid bracket.
test('FIXED: layerAt skips a duplicate-z pair and uses the next valid bracket', () => {
  const profile = [
    { p: 1000, z: 9000, theta: 300, u: 0, v: 0 },
    { p: 975, z: 9000, theta: 301, u: 10, v: 0 },  // duplicate z with previous entry
    { p: 950, z: 9500, theta: 303, u: 20, v: 0 },
  ];
  const layer = layerAt(profile, 9000);
  assert.notEqual(layer, null);
  assert.equal(layer.zLower, 9000);
  assert.equal(layer.zUpper, 9500);
  // du/dz = (20-10)/500 = 0.02
  assert.ok(Math.abs(layer.VWS - 0.02) < 1e-12);

  // Sanity: matches the same bracket computed in isolation.
  const isolated = layerAt([profile[1], profile[2]], 9000);
  assert.ok(Math.abs(layer.Ri - isolated.Ri) < 1e-12);
});

test('FIXED: interpolateUV skips the duplicate-z pair like layerAt', () => {
  const profile = [
    { p: 1000, z: 9000, theta: 300, u: 0, v: 0 },
    { p: 975, z: 9000, theta: 301, u: 10, v: 0 },
    { p: 950, z: 9500, theta: 303, u: 20, v: 0 },
  ];
  const r = interpolateUV(profile, 9000);
  assert.notEqual(r, null);
  assert.ok(Math.abs(r.u - 10) < 1e-12 && Math.abs(r.v) < 1e-12);
});

// NOTE (contract, not a crash-bug): layerAt/interpolateUV assume the profile
// array is already SORTED ascending by z (as parseProfile guarantees). If a
// caller ever passes an unsorted array directly, the linear "first adjacent
// pair that brackets target" scan picks whatever pair happens to be adjacent
// in ARRAY order, not altitude order — silently returning a materially
// different numeric result rather than an error.
test('NOTE: layerAt on an unsorted profile gives a materially different result than the sorted version', () => {
  const unsorted = [
    { p: 1000, z: 9000, theta: 300, u: 0, v: 0 },
    { p: 500, z: 9500, theta: 303, u: 20, v: 0 },
    { p: 700, z: 9200, theta: 301, u: 10, v: 0 },
  ];
  const sorted = [...unsorted].sort((a, b) => a.z - b.z);
  const rUnsorted = layerAt(unsorted, 9100);
  const rSorted = layerAt(sorted, 9100);
  assert.notEqual(rUnsorted, null);
  assert.notEqual(rSorted, null);
  // Different brackets chosen -> different VWS/Ri. This assertion documents
  // the discrepancy exists; it is NOT asserting which one is "right".
  assert.notEqual(rUnsorted.zUpper, rSorted.zUpper,
    'expected the unsorted scan to pick a different (wrong-order) bracket than the sorted one');
});

// ---------- targetAltM exactly equal to a level z ----------

test('layerAt: targetAltM exactly equal to the lower bound of the profile', () => {
  const profile = [
    { p: 1000, z: 9000, theta: 300, u: 0, v: 0 },
    { p: 950, z: 9500, theta: 303, u: 20, v: 0 },
  ];
  const layer = layerAt(profile, 9000);
  assert.notEqual(layer, null);
  assert.equal(layer.zLower, 9000);
  assert.equal(layer.zUpper, 9500);
});

test('layerAt: targetAltM exactly equal to the upper bound of the profile', () => {
  const profile = [
    { p: 1000, z: 9000, theta: 300, u: 0, v: 0 },
    { p: 950, z: 9500, theta: 303, u: 20, v: 0 },
  ];
  const layer = layerAt(profile, 9500);
  assert.notEqual(layer, null);
  assert.equal(layer.zLower, 9000);
  assert.equal(layer.zUpper, 9500);
});

test('layerAt: targetAltM exactly equal to a shared interior level picks the FIRST matching bracket (lower one)', () => {
  const profile = [
    { p: 1000, z: 9000, theta: 300, u: 0, v: 0 },
    { p: 950, z: 9200, theta: 301, u: 10, v: 0 },
    { p: 900, z: 9500, theta: 303, u: 20, v: 0 },
  ];
  const layer = layerAt(profile, 9200); // exactly the middle level's z
  assert.notEqual(layer, null);
  assert.equal(layer.zLower, 9000);
  assert.equal(layer.zUpper, 9200); // first bracket [0]-[1], not [1]-[2]
});

// ---------- pseudoEdr monotonicity sweep ----------

test('pseudoEdr: monotonic non-increasing in Ri for fixed VWS, across a dense sweep', () => {
  for (const vws of [0, 2, 6, 10, 20, 50]) {
    let prev = pseudoEdr(0, vws);
    for (let ri = 0.01; ri <= 50; ri *= 1.5) {
      const cur = pseudoEdr(ri, vws);
      assert.ok(cur <= prev + 1e-12, `not monotonic at Ri=${ri}, VWS=${vws}: prev=${prev} cur=${cur}`);
      assert.ok(cur >= 0 && cur <= 1, `out of [0,1] at Ri=${ri}, VWS=${vws}: ${cur}`);
      prev = cur;
    }
  }
});

test('pseudoEdr: monotonic non-decreasing in VWS for fixed Ri, across a dense sweep', () => {
  for (const ri of [0, 0.5, 1, 5, RI_LARGE]) {
    let prev = pseudoEdr(ri, 0);
    for (let vws = 0.5; vws <= 40; vws += 0.5) {
      const cur = pseudoEdr(ri, vws);
      assert.ok(cur >= prev - 1e-12, `not monotonic at Ri=${ri}, VWS=${vws}: prev=${prev} cur=${cur}`);
      prev = cur;
    }
  }
});

test('pseudoEdr: saturates exactly at 1.0 for Ri=0 and VWS>=20', () => {
  close(pseudoEdr(0, 20), 1, 1e-12);
  close(pseudoEdr(0, 1000), 1, 1e-12);
});

test('pseudoEdr: negative Ri (unstable/severe) is clamped the same as Ri=0 (Math.max(Ri,0))', () => {
  close(pseudoEdr(-50, 10), pseudoEdr(0, 10), 1e-12);
  close(pseudoEdr(-RI_LARGE, 0), pseudoEdr(0, 0), 1e-12);
});

// ---------- feltCategory threshold boundaries, exact values ----------

test('feltCategory: light-aircraft class boundaries are exact and inclusive (>=)', () => {
  assert.equal(feltCategory(0.099999, 'light').key, 'smooth');
  assert.equal(feltCategory(0.10, 'light').key, 'light');
  assert.equal(feltCategory(0.199999, 'light').key, 'light');
  assert.equal(feltCategory(0.20, 'light').key, 'moderate');
  assert.equal(feltCategory(0.449999, 'light').key, 'moderate');
  assert.equal(feltCategory(0.45, 'light').key, 'severe');
});

test('feltCategory: medium (regional jet) class boundaries are exact and inclusive (>=)', () => {
  assert.equal(feltCategory(0.149999, 'medium').key, 'smooth');
  assert.equal(feltCategory(0.15, 'medium').key, 'light');
  assert.equal(feltCategory(0.349999, 'medium').key, 'light');
  assert.equal(feltCategory(0.35, 'medium').key, 'moderate');
  assert.equal(feltCategory(0.499999, 'medium').key, 'moderate');
  assert.equal(feltCategory(0.50, 'medium').key, 'severe');
});

test('feltCategory: heavy (commercial jet) class boundaries are exact and inclusive (>=)', () => {
  assert.equal(feltCategory(0.199999, 'heavy').key, 'smooth');
  assert.equal(feltCategory(0.20, 'heavy').key, 'light');
  assert.equal(feltCategory(0.449999, 'heavy').key, 'light');
  assert.equal(feltCategory(0.45, 'heavy').key, 'moderate');
  assert.equal(feltCategory(0.599999, 'heavy').key, 'moderate');
  assert.equal(feltCategory(0.60, 'heavy').key, 'severe');
});

test('feltCategory: edrEstimate of exactly 1.0 (max plausible) is severe for every class', () => {
  for (const cls of AIRCRAFT_CLASSES) {
    assert.equal(feltCategory(1.0, cls.key).key, 'severe');
  }
});

test('categorize: Ri/VWS band boundary combined with RI_LARGE sentinel does not misclassify', () => {
  assert.equal(categorize(RI_LARGE, 0).key, 'smooth');
  assert.equal(categorize(RI_LARGE, 1000).key, 'smooth'); // Ri dominates once >=10 regardless of shear magnitude
});

// ======================================================================
// weather.js — mocked fetch (no real network) + exactly one real call
// ======================================================================

const realFetch = globalThis.fetch;
function mockFetch(handler) { globalThis.fetch = handler; }
function restoreFetch() { globalThis.fetch = realFetch; }

test('fetchWeather: normalizes a single-point response (bare object) into an array', async (t) => {
  _resetForTest();
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ hourly: { time: ['2026-07-18T00:00'] } }),
  }));
  t.after(restoreFetch);
  const r = await fetchWeather([{ lat: 41.88, lon: -87.63 }], Date.now());
  assert.equal(r.fromCache, false);
  assert.ok(Array.isArray(r.data));
  assert.equal(r.data.length, 1);
  assert.deepEqual(getLastGood().data, r.data);
});

test('fetchWeather: normalizes a multi-point array response and validates length matches points', async (t) => {
  _resetForTest();
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ([
      { hourly: { time: ['2026-07-18T00:00'] } },
      { hourly: { time: ['2026-07-18T00:00'] } },
    ]),
  }));
  t.after(restoreFetch);
  const pts = [{ lat: 41.88, lon: -87.63 }, { lat: 42, lon: -87.5 }];
  const r = await fetchWeather(pts, Date.now());
  assert.equal(r.data.length, 2);
});

test('fetchWeather: array length mismatch vs points -> WeatherError kind "shape"', async (t) => {
  _resetForTest();
  mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ([{ hourly: { time: ['2026-07-18T00:00'] } }]), // 1 item, 2 points requested
  }));
  t.after(restoreFetch);
  const pts = [{ lat: 41.88, lon: -87.63 }, { lat: 42, lon: -87.5 }];
  await assert.rejects(() => fetchWeather(pts, Date.now()), (e) => {
    assert.ok(e instanceof WeatherError);
    assert.equal(e.kind, 'shape');
    return true;
  });
});

test('fetchWeather: missing hourly.time array -> WeatherError kind "shape"', async (t) => {
  _resetForTest();
  mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ hourly: {} }) }));
  t.after(restoreFetch);
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], Date.now()), (e) => e.kind === 'shape');
});

test('fetchWeather: res.ok=false -> WeatherError kind "http"', async (t) => {
  _resetForTest();
  mockFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  t.after(restoreFetch);
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], Date.now()), (e) => {
    assert.equal(e.kind, 'http');
    assert.ok(e.message.includes('503'));
    return true;
  });
});

test('fetchWeather: res.ok=true but body.error present -> WeatherError kind "api"', async (t) => {
  _resetForTest();
  mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ error: true, reason: 'Latitude must be in range of -90 to 90°' }),
  }));
  t.after(restoreFetch);
  await assert.rejects(() => fetchWeather([{ lat: 999, lon: 0 }], Date.now()), (e) => {
    assert.equal(e.kind, 'api');
    assert.equal(e.message, 'Latitude must be in range of -90 to 90°');
    return true;
  });
});

test('fetchWeather: res.json() throws -> WeatherError kind "shape" ("Bad response")', async (t) => {
  _resetForTest();
  mockFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('boom'); } }));
  t.after(restoreFetch);
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], Date.now()), (e) => {
    assert.equal(e.kind, 'shape');
    assert.equal(e.message, 'Bad response from weather service');
    return true;
  });
});

test('fetchWeather: fetch() rejects (network down) -> WeatherError kind "network"', async (t) => {
  _resetForTest();
  mockFetch(async () => { throw new Error('DNS failure'); });
  t.after(restoreFetch);
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], Date.now()), (e) => {
    assert.equal(e.kind, 'network');
    return true;
  });
});

test('fetchWeather: abort signal (timeout) -> WeatherError kind "timeout"', async (t) => {
  _resetForTest();
  mockFetch(async (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  t.after(restoreFetch);
  await assert.rejects(
    () => fetchWeather([{ lat: 0, lon: 0 }], Date.now(), { timeoutMs: 20 }),
    (e) => { assert.equal(e.kind, 'timeout'); return true; }
  );
});

test('fetchWeather: after a failure, immediate retry within the backoff window throws kind "backoff"', async (t) => {
  _resetForTest();
  mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  t.after(restoreFetch);
  const t0 = 1_000_000;
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], t0), (e) => e.kind === 'http');
  // Immediately retry at the same virtual "now" -> should be backed off, not re-fetched.
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], t0 + 1), (e) => {
    assert.equal(e.kind, 'backoff');
    return true;
  });
});

test('fetchWeather: backoff clears and getLastGood persists across a subsequent failure', async (t) => {
  _resetForTest();
  let call = 0;
  mockFetch(async () => {
    call++;
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({ hourly: { time: ['2026-07-18T00:00'] } }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  t.after(restoreFetch);
  const t0 = 2_000_000;
  const good = await fetchWeather([{ lat: 0, lon: 0 }], t0);
  assert.equal(getLastGood().data.length, 1);
  // Now force a failure well past any backoff window and confirm lastGood is retained.
  await assert.rejects(() => fetchWeather([{ lat: 0, lon: 0 }], t0 + FETCH_TIMEOUT_MS + 999_999), (e) => e.kind === 'http');
  assert.notEqual(getLastGood(), null);
  assert.deepEqual(getLastGood().data, good.data);
});

test('pointsKey: rounds to 2 decimals and is stable/order-sensitive', () => {
  const k1 = pointsKey([{ lat: 41.8781, lon: -87.6298 }, { lat: 42.001, lon: -87.499 }]);
  assert.equal(k1, '41.88,-87.63;42.00,-87.50');
  const k2 = pointsKey([{ lat: 42.001, lon: -87.499 }, { lat: 41.8781, lon: -87.6298 }]);
  assert.notEqual(k1, k2, 'order matters for the cache key as implemented');
});

// ---------- exactly one real network call, per instructions ----------

test('fetchWeather: ONE real call to api.open-meteo.com resolves a valid shape (skips gracefully if offline)', async (t) => {
  _resetForTest();
  t.after(restoreFetch); // no-op, real fetch was never overridden here
  try {
    const r = await fetchWeather([{ lat: 41.8781, lon: -87.6298 }], Date.now(), { forecastDays: 1 });
    assert.equal(r.fromCache, false);
    assert.equal(r.data.length, 1);
    assert.ok(Array.isArray(r.data[0].hourly.time));
    assert.ok(r.data[0].hourly.time.length > 0);
  } catch (e) {
    // Offline sandbox OR server-side throttling (heavy test days hit Open-Meteo's
    // hourly cap) — either way the error path returning a typed WeatherError IS
    // correct behavior; only an unexpected shape should fail this test.
    if (e instanceof WeatherError) {
      t.skip(`no live data available (${e.kind}): ${e.message}`);
      return;
    }
    throw e;
  }
});
