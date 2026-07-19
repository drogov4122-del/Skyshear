// Adversarial QA — tertiary pass over route.js + flightcast.js pure functions.
// Probes antipodal/polar geometry, chunking at day boundaries, malformed weather
// inputs, worstSegments edge rules, reFeel low-level capping, and formatDuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  greatCircleDistanceKm, greatCirclePoint, buildFlightPath, formatDuration,
} from '../route.js';
import { chunkRoute, evaluateRoute, reFeel, worstSegments } from '../flightcast.js';
import { AIRCRAFT_CLASSES } from '../turbulence.js';

const finite = (v) => Number.isFinite(v);

// ---------------------------------------------------------------------------
// Antipodal airports
// ---------------------------------------------------------------------------
const MAD = { lat: 40.4168, lon: -3.7038 };
const WLG = { lat: -41.2865, lon: 174.7762 }; // ~real antipode of Madrid, ~19,855 km apart

test('antipodal (Madrid→Wellington): greatCirclePoint stays finite and in-range across the sweep', () => {
  let prev = null;
  for (let f = 0; f <= 1.0001; f += 0.02) {
    const p = greatCirclePoint(MAD.lat, MAD.lon, WLG.lat, WLG.lon, Math.min(1, f));
    assert.ok(finite(p.lat) && finite(p.lon), `non-finite at f=${f}: ${JSON.stringify(p)}`);
    assert.ok(p.lat >= -90 && p.lat <= 90, `lat out of range at f=${f}: ${p.lat}`);
    assert.ok(p.lon >= -180 && p.lon <= 180, `lon out of range at f=${f}: ${p.lon}`);
    if (prev) {
      const jump = Math.hypot(p.lat - prev.lat, p.lon - prev.lon);
      assert.ok(jump < 20, `discontinuous jump at f=${f}: ${jump.toFixed(2)} deg (prev ${JSON.stringify(prev)} → now ${JSON.stringify(p)})`);
    }
    prev = p;
  }
});

test('antipodal (Madrid→Wellington): buildFlightPath is finite everywhere with sane duration', () => {
  const fp = buildFlightPath(MAD, WLG);
  assert.ok(fp, 'should build a path for a near-antipodal but non-degenerate pair');
  assert.ok(fp.totalKm > 19000 && fp.totalKm < 20100, `totalKm ${fp.totalKm}`);
  assert.equal(fp.cruiseFt, 38000);
  for (const p of fp.points) {
    assert.ok([p.lat, p.lon, p.altM, p.altFt, p.tMin, p.distKm].every(finite), `non-finite point: ${JSON.stringify(p)}`);
    assert.ok(p.lat >= -90 && p.lat <= 90);
  }
  // ~24h+ flight is plausible for a near-max-distance great circle at these cruise speeds
  assert.ok(fp.durationMin > 1300 && fp.durationMin < 1600, `durationMin ${fp.durationMin}`);
});

test('KNOWN LIMITATION — mathematically exact antipodal points destabilize greatCirclePoint (documented, not asserted as a hard failure)', () => {
  // When origin/dest are exactly antipodal (to within ~1e-9°), sin(sigma)→0 and
  // the SLERP weights blow up: no NaN is produced, but the resulting path is
  // NOT a coherent monotonic sweep — points jump wildly (collapsing repeatedly
  // to the arbitrary point (0,-90) here). This never happens for real airports
  // (no two exist at floating-point-exact antipodes), so it's a theoretical
  // edge case, not a practical bug. We assert only the guarantee route.js
  // actually documents (finite outputs), and separately record the instability.
  const A = { lat: 40.4168, lon: -3.7038 };
  const exactAntipode = { lat: -40.4168, lon: 176.2962 };
  let bigJumps = 0, prev = null;
  for (let f = 0; f <= 1.0001; f += 0.025) {
    const p = greatCirclePoint(A.lat, A.lon, exactAntipode.lat, exactAntipode.lon, Math.min(1, f));
    assert.ok(finite(p.lat) && finite(p.lon), 'must stay finite even in the degenerate case');
    if (prev) {
      const jump = Math.hypot(p.lat - prev.lat, p.lon - prev.lon);
      if (jump > 20) bigJumps++;
    }
    prev = p;
  }
  // Documenting the instability rather than failing the suite over a case with
  // zero real-world occurrence probability.
  assert.ok(bigJumps > 0, 'expected the known SLERP instability to reproduce at exact antipode (if this now reads 0, the bug may have been fixed upstream — update the note)');
});

// ---------------------------------------------------------------------------
// Polar route
// ---------------------------------------------------------------------------
const ANC = { lat: 61.2181, lon: -149.9003 };
const DXB = { lat: 25.2532, lon: 55.3657 };

test('polar route (Anchorage→Dubai): high-latitude great circle stays ≤ 90°, all finite', () => {
  const fp = buildFlightPath(ANC, DXB, { samples: 60 });
  assert.ok(fp);
  let maxLat = -Infinity;
  for (const p of fp.points) {
    assert.ok([p.lat, p.lon, p.altM, p.altFt, p.tMin, p.distKm].every(finite));
    assert.ok(p.lat <= 90 && p.lat >= -90, `lat out of range: ${p.lat}`);
    maxLat = Math.max(maxLat, p.lat);
  }
  // Should climb well north of both endpoints (great-circle bulge toward the pole)
  assert.ok(maxLat > 70, `expected high-arctic bulge, got maxLat ${maxLat}`);
});

// ---------------------------------------------------------------------------
// Ultra-short hops / degenerate airports
// ---------------------------------------------------------------------------
test('ultra-short hops: sub-1km returns null, ~1.5km builds a clamped-altitude path', () => {
  const A = { lat: 40.0, lon: -73.0 };
  const tooShort = { lat: 40.0 + 0.9 / 111.0, lon: -73.0 }; // ~0.9 km
  assert.equal(buildFlightPath(A, tooShort), null);

  const justOver = { lat: 40.0 + 1.1 / 111.0, lon: -73.0 }; // ~1.1 km
  const fpOver = buildFlightPath(A, justOver);
  assert.ok(fpOver, 'should build for >1km hop');
  assert.ok(fpOver.cruiseFt >= 10000, 'cruise floor respected');

  const hop40km = { lat: 40.36, lon: -73.0 }; // ~40 km
  const fp40 = buildFlightPath(A, hop40km);
  assert.ok(fp40);
  assert.ok(fp40.totalKm < 50);
  for (const p of fp40.points) assert.ok([p.altM, p.tMin, p.distKm].every(finite));
  assert.ok(fp40.cruiseFt <= 24000, `expected reduced cruise alt for a 40km hop, got ${fp40.cruiseFt}`);
});

test('exactly-equal airports return null (zero distance)', () => {
  const A = { lat: 33.9416, lon: -118.4085 };
  assert.equal(greatCircleDistanceKm(A.lat, A.lon, A.lat, A.lon), 0);
  assert.equal(buildFlightPath(A, { ...A }), null);
});

// ---------------------------------------------------------------------------
// Ultra-long haul
// ---------------------------------------------------------------------------
test('ultra-long haul (SYD→DFW ~13,800km): duration sane, cruise at ceiling', () => {
  const SYD = { lat: -33.9399, lon: 151.1753 };
  const DFW = { lat: 32.8998, lon: -97.0403 };
  const fp = buildFlightPath(SYD, DFW);
  assert.ok(fp.totalKm > 13500 && fp.totalKm < 14100, `totalKm ${fp.totalKm}`);
  assert.equal(fp.cruiseFt, 38000);
  const hours = fp.durationMin / 60;
  assert.ok(hours > 14 && hours < 18, `duration ${hours.toFixed(2)}h out of expected 14-18h band`);
});

// ---------------------------------------------------------------------------
// chunkRoute: chunkSize 1 + UTC day-boundary departure
// ---------------------------------------------------------------------------
test('chunkRoute chunkSize=1 with departure at 23:30Z rolls the date forward correctly', () => {
  const ORD = { lat: 41.9786, lon: -87.9048 };
  const DEN = { lat: 39.8617, lon: -104.6732 };
  const fp = buildFlightPath(ORD, DEN);
  const DEP = Date.parse('2026-07-18T23:30:00Z');
  const chunks = chunkRoute(fp.points, DEP, 1);

  assert.equal(chunks.length, fp.points.length, 'one chunk per point at chunkSize=1');
  for (const c of chunks) assert.equal(c.points.length, 1);

  // Every chunk's startHour must be a valid ISO-hour string and non-decreasing
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startHour >= chunks[i - 1].startHour, `startHour regressed at ${i}`);
  }
  // The date must actually roll over past midnight UTC somewhere in this flight
  assert.ok(chunks.some(c => c.startHour.startsWith('2026-07-18')), 'some chunks stay on the departure date');
  assert.ok(chunks.some(c => c.startHour.startsWith('2026-07-19')), 'later chunks roll to the next UTC date');
  // endHour is always startHour + 1 hour when chunkSize=1 (single-point window)
  for (const c of chunks) {
    const s = Date.parse(c.startHour + ':00Z');
    const e = Date.parse(c.endHour + ':00Z');
    assert.equal(e - s, 3600000, `endHour should be exactly 1h after startHour for a 1-point chunk (${c.startHour} → ${c.endHour})`);
  }
});

// ---------------------------------------------------------------------------
// evaluateRoute: malformed / short weather arrays must never throw
// ---------------------------------------------------------------------------
const ORD = { lat: 41.9786, lon: -87.9048 };
const DEN = { lat: 39.8617, lon: -104.6732 };
const DEP = Date.parse('2026-07-18T15:00:00Z');

test('evaluateRoute: weather array shorter than routePoints does not throw; missing points are noData', () => {
  const fp = buildFlightPath(ORD, DEN);
  const shortWeather = fp.points.slice(0, 5).map(() => ({ hourly: { time: ['2026-07-18T15:00'] } }));
  assert.doesNotThrow(() => evaluateRoute(fp.points, shortWeather, DEP, 'heavy'));
  const rows = evaluateRoute(fp.points, shortWeather, DEP, 'heavy');
  assert.equal(rows.length, fp.points.length, 'output length always matches routePoints, never the weather array length');
  for (let i = 5; i < rows.length; i++) assert.equal(rows[i].noData, true, `index ${i} beyond weather array should be noData`);
});

test('evaluateRoute: hourly.time present but level data arrays empty does not throw; rows are noData', () => {
  const fp = buildFlightPath(ORD, DEN);
  const emptyDataWeather = fp.points.map(() => ({ hourly: { time: ['2026-07-18T15:00', '2026-07-18T16:00'] } }));
  assert.doesNotThrow(() => evaluateRoute(fp.points, emptyDataWeather, DEP, 'heavy'));
  const rows = evaluateRoute(fp.points, emptyDataWeather, DEP, 'heavy');
  assert.equal(rows.length, fp.points.length);
  assert.ok(rows.every(r => r.noData === true), 'no level data anywhere → every row should be noData, not a crash or bogus category');
});

test('evaluateRoute: completely empty weather array does not throw', () => {
  const fp = buildFlightPath(ORD, DEN);
  assert.doesNotThrow(() => evaluateRoute(fp.points, [], DEP, 'heavy'));
  const rows = evaluateRoute(fp.points, [], DEP, 'heavy');
  assert.equal(rows.length, fp.points.length);
  assert.ok(rows.every(r => r.noData === true));
});

// ---------------------------------------------------------------------------
// worstSegments: MIN_RUN_MIN rule + ties in rank
// ---------------------------------------------------------------------------
const felt = (key, rank) => ({ key, label: key, color: '#fff000', rank });

// FIXED CONTRACT (was a bug found in code review): a single-sample severity hit
// represents ~one sample interval of real flight time, so runs are padded by
// half the sample spacing on each side. An isolated blip must now SURVIVE the
// min-run filter — the chart paints it, and the text verdict must agree.
test('worstSegments: single-sample blip survives on long flights (padded by half the sample spacing)', () => {
  const longFlightRows = [
    { noData: false, felt: felt('smooth', 0), point: { tMin: 0 } },
    { noData: false, felt: felt('smooth', 0), point: { tMin: 10 } },
    { noData: false, felt: felt('moderate', 3), point: { tMin: 20 } }, // single-point blip
    { noData: false, felt: felt('smooth', 0), point: { tMin: 30 } },
    { noData: false, felt: felt('smooth', 0), point: { tMin: 40 } }, // spacing = 10 → padded run = 10 min
  ];
  const worstLong = worstSegments(longFlightRows);
  assert.equal(worstLong.length, 1, 'padded blip (10 min) must survive MIN_RUN_MIN on long flights');
  assert.equal(worstLong[0].fromMin, 15); // 20 − spacing/2
  assert.equal(worstLong[0].toMin, 25);   // 20 + spacing/2

  const shortFlightRows = [
    { noData: false, felt: felt('smooth', 0), point: { tMin: 0 } },
    { noData: false, felt: felt('smooth', 0), point: { tMin: 5 } },
    { noData: false, felt: felt('moderate', 3), point: { tMin: 10 } },
    { noData: false, felt: felt('smooth', 0), point: { tMin: 15 } },
    { noData: false, felt: felt('smooth', 0), point: { tMin: 20 } },
  ];
  const worst = worstSegments(shortFlightRows);
  assert.equal(worst.length, 1, 'blip also kept when the whole flight is under 30min');
  assert.equal(worst[0].fromMin, 7.5);
  assert.equal(worst[0].toMin, 12.5);
});

test('worstSegments: ties in rank break on padded run duration (longer run ranks first)', () => {
  const rows = [
    { noData: false, felt: felt('moderate', 3), point: { tMin: 0 } },
    { noData: false, felt: felt('moderate', 3), point: { tMin: 5 } },
    { noData: false, felt: felt('moderate', 3), point: { tMin: 8 } }, // run A: 0–8
    { noData: false, felt: felt('smooth', 0), point: { tMin: 10 } },
    { noData: false, felt: felt('moderate', 3), point: { tMin: 15 } },
    { noData: false, felt: felt('moderate', 3), point: { tMin: 19 } }, // run B: 15–19
    { noData: false, felt: felt('smooth', 0), point: { tMin: 40 } },
  ];
  // spacing = 40/6 ≈ 6.67 → pad ≈ 3.33 each side (clamped to [0, 40])
  const worst = worstSegments(rows);
  const pad = 40 / 6 / 2;
  assert.equal(worst.length, 2);
  assert.ok(Math.abs(worst[0].fromMin - 0) < 1e-9);            // 0 − pad clamps to 0
  assert.ok(Math.abs(worst[0].toMin - (8 + pad)) < 1e-9);
  assert.ok(Math.abs(worst[1].fromMin - (15 - pad)) < 1e-9);
  assert.ok(Math.abs(worst[1].toMin - (19 + pad)) < 1e-9);
  assert.ok(worst[0].rank === worst[1].rank, 'sanity: both runs are the same rank (moderate)');
  assert.ok((worst[0].toMin - worst[0].fromMin) > (worst[1].toMin - worst[1].fromMin),
    'longer padded run must rank first');
});

// ---------------------------------------------------------------------------
// reFeel: low-level cap must apply for EVERY aircraft class
// ---------------------------------------------------------------------------
test('reFeel: lowLevel + high edr caps at lightmod rank for every aircraft class', () => {
  for (const cls of AIRCRAFT_CLASSES) {
    const rows = [{ noData: false, edr: 1.0, lowLevel: true, felt: null, point: { tMin: 0 } }];
    reFeel(rows, cls.key);
    assert.equal(rows[0].felt.key, 'lightmod', `class ${cls.key}: expected lightmod cap, got ${rows[0].felt?.key}`);
    assert.equal(rows[0].felt.rank, 2, `class ${cls.key}: expected rank 2 (lightmod)`);
  }
});

test('reFeel: same high edr WITHOUT lowLevel is NOT capped (sanity control)', () => {
  for (const cls of AIRCRAFT_CLASSES) {
    const rows = [{ noData: false, edr: 1.0, lowLevel: false, felt: null, point: { tMin: 0 } }];
    reFeel(rows, cls.key);
    assert.equal(rows[0].felt.key, 'severe', `class ${cls.key}: expected uncapped severe at edr=1.0`);
  }
});

// ---------------------------------------------------------------------------
// formatDuration: negative input
// ---------------------------------------------------------------------------
test('formatDuration: negative and negative-zero input render the fallback dash', () => {
  assert.equal(formatDuration(-5), '—');
  assert.equal(formatDuration(-0.0001), '—');
  assert.equal(formatDuration(-Infinity), '—');
  assert.equal(formatDuration(0), '0m', 'zero itself is valid, not negative');
});
