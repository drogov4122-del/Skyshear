import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windToUV, potentialTemperature, buildForecastUrl, hourlyVariableList,
  nearestHourIndex, parseProfile, layerAt, categorize, pseudoEdr,
  ellrod, categorizeTI, interpolateUV, feltCategory, AIRCRAFT_CLASSES,
  cloudCoverAt, cloudTypeFor, PRESSURE_LEVELS, RI_LARGE,
} from '../turbulence.js';
import { horizontalDerivatives } from '../geometry.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b} (eps ${eps})`);

// ---------- wind components ----------

test('wind FROM west (270°) blows eastward: u=+spd, v≈0', () => {
  const { u, v } = windToUV(10, 270);
  close(u, 10, 1e-9);
  close(v, 0, 1e-9);
});

test('wind FROM north (0°) blows southward: v=−spd', () => {
  const { u, v } = windToUV(10, 0);
  close(u, 0, 1e-9);
  close(v, -10, 1e-9);
});

// ---------- potential temperature ----------

test('potential temperature at 1000 hPa equals absolute temperature', () => {
  close(potentialTemperature(15, 1000), 288.15, 1e-9);
});

test('potential temperature exceeds T aloft (500 hPa)', () => {
  const theta = potentialTemperature(-20, 500);
  close(theta, 253.15 * Math.pow(2, 0.2857), 1e-6);
  assert.ok(theta > 253.15);
});

// ---------- URL builder ----------

test('buildForecastUrl: all params, all levels, m/s units, GFS, GMT', () => {
  const url = buildForecastUrl([{ lat: 41.8781, lon: -87.6298 }, { lat: 42.0, lon: -87.5 }]);
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
  assert.ok(url.includes('latitude=41.878,42.000'));
  assert.ok(url.includes('longitude=-87.630,-87.500'));
  assert.ok(url.includes('wind_speed_unit=ms'));
  assert.ok(url.includes('models=gfs_seamless'));
  assert.ok(url.includes('forecast_days=1'));
  assert.ok(url.includes('timezone=GMT'));
  for (const L of PRESSURE_LEVELS) {
    for (const v of ['temperature', 'wind_speed', 'wind_direction', 'geopotential_height', 'cloud_cover']) {
      assert.ok(url.includes(`${v}_${L}hPa`), `missing ${v}_${L}hPa`);
    }
  }
  assert.equal(hourlyVariableList().length, PRESSURE_LEVELS.length * 5);
});

test('buildForecastUrl: hour windowing replaces forecast_days', async () => {
  const { isoHourUTC } = await import('../turbulence.js');
  const start = isoHourUTC(Date.parse('2026-07-18T04:25:00Z'));
  const end = isoHourUTC(Date.parse('2026-07-18T04:25:00Z') + 3600000);
  assert.equal(start, '2026-07-18T04:00');
  assert.equal(end, '2026-07-18T05:00');
  const url = buildForecastUrl([{ lat: 41.88, lon: -87.63 }], { startHour: start, endHour: end });
  assert.ok(url.includes('start_hour=2026-07-18T04:00'));
  assert.ok(url.includes('end_hour=2026-07-18T05:00'));
  assert.ok(!url.includes('forecast_days'));
});

// ---------- hour index ----------

test('nearestHourIndex picks the closest UTC hour', () => {
  const times = ['2026-07-18T00:00', '2026-07-18T01:00', '2026-07-18T02:00'];
  assert.equal(nearestHourIndex(times, Date.parse('2026-07-18T00:29:00Z')), 0);
  assert.equal(nearestHourIndex(times, Date.parse('2026-07-18T00:31:00Z')), 1);
  assert.equal(nearestHourIndex(times, Date.parse('2026-07-18T05:00:00Z')), 2); // clamps to last
});

// ---------- profile parsing ----------

function mkHourly() {
  // Two usable levels (700, 500 hPa) + one below observer (1000) + one with null.
  const h = { time: ['2026-07-18T00:00'] };
  for (const p of PRESSURE_LEVELS) {
    h[`temperature_${p}hPa`] = [null];
    h[`wind_speed_${p}hPa`] = [null];
    h[`wind_direction_${p}hPa`] = [null];
    h[`geopotential_height_${p}hPa`] = [null];
  }
  const set = (p, z, t, spd, dir) => {
    h[`geopotential_height_${p}hPa`] = [z];
    h[`temperature_${p}hPa`] = [t];
    h[`wind_speed_${p}hPa`] = [spd];
    h[`wind_direction_${p}hPa`] = [dir];
  };
  set(1000, 100, 20, 5, 180);   // below observer at 200 m → dropped
  set(700, 3000, 5, 10, 270);
  set(500, 5800, -10, 25, 270);
  set(300, 9200, -45, NaN, 270); // NaN speed → dropped
  return h;
}

test('parseProfile drops below-observer and non-finite levels, sorts by z', () => {
  const prof = parseProfile(mkHourly(), 0, 200);
  assert.equal(prof.length, 2);
  assert.equal(prof[0].p, 700);
  assert.equal(prof[1].p, 500);
  assert.ok(prof[0].z < prof[1].z);
  close(prof[0].u, 10, 1e-9); // west wind → +u
});

// ---------- layer computation: exact known answers ----------

function twoLevelProfile({ zLo = 9000, zUp = 10000, uLo = 10, uUp = 20, thetaLo = 300, thetaUp = 303 } = {}) {
  return [
    { p: 300, z: zLo, tempC: 0, theta: thetaLo, u: uLo, v: 0 },
    { p: 250, z: zUp, tempC: 0, theta: thetaUp, u: uUp, v: 0 },
  ];
}

test('layerAt: exact VWS, N², Ri for a hand-built profile', () => {
  const layer = layerAt(twoLevelProfile(), 9500);
  // du/dz = 10 m/s over 1000 m
  close(layer.VWS, 0.01, 1e-12);
  close(layer.VWS_kt_kft, 0.01 * 304.8 * 1.9438, 1e-9); // 5.9247024
  const N2 = (9.81 / 301.5) * (3 / 1000);
  close(layer.N2, N2, 1e-12);
  close(layer.Ri, N2 / 1e-4, 1e-9); // 0.97612…
  assert.equal(categorize(layer.Ri, layer.VWS_kt_kft).key, 'moderate');
});

test('layerAt: zero shear → Ri = RI_LARGE, Smooth, never Infinity', () => {
  const layer = layerAt(twoLevelProfile({ uUp: 10 }), 9500);
  assert.equal(layer.Ri, RI_LARGE);
  assert.ok(Number.isFinite(layer.Ri));
  assert.equal(categorize(layer.Ri, layer.VWS_kt_kft).key, 'smooth');
});

test('layerAt: no bracketing pair → null (target above/below profile)', () => {
  assert.equal(layerAt(twoLevelProfile(), 12000), null);
  assert.equal(layerAt(twoLevelProfile(), 100), null);
  assert.equal(layerAt([], 9500), null);
  assert.equal(layerAt(twoLevelProfile().slice(0, 1), 9500), null);
});

test('layerAt: degenerate dz → null, no division blowup', () => {
  const prof = twoLevelProfile({ zUp: 9000.5 });
  assert.equal(layerAt(prof, 9000.2), null);
});

test('unstable layer (θ decreasing) → negative Ri → severe', () => {
  const layer = layerAt(twoLevelProfile({ thetaUp: 297 }), 9500);
  assert.ok(layer.Ri < 0);
  assert.equal(categorize(layer.Ri, layer.VWS_kt_kft).key, 'severe');
});

// ---------- category band edges ----------

test('category band edges are exact', () => {
  assert.equal(categorize(0.2499, 0).key, 'severe');
  assert.equal(categorize(0.25, 0).key, 'moderate');
  assert.equal(categorize(0.9999, 0).key, 'moderate');
  assert.equal(categorize(1.0, 5.9).key, 'light');
  assert.equal(categorize(5, 6).key, 'lightmod');
  assert.equal(categorize(9.9999, 20).key, 'lightmod');
  assert.equal(categorize(10, 50).key, 'smooth');
  assert.equal(categorize(NaN, 5), null);
});

// ---------- pseudo-EDR ----------

test('pseudoEdr is bounded [0,1] and monotonic in instability', () => {
  assert.ok(pseudoEdr(0.1, 15) > pseudoEdr(1, 10));
  assert.ok(pseudoEdr(1, 10) > pseudoEdr(50, 1));
  assert.ok(pseudoEdr(0, 100) <= 1);
  assert.equal(pseudoEdr(NaN, 5), 0);
  assert.ok(pseudoEdr(RI_LARGE, 0) >= 0);
});

// ---------- clouds ----------

test('cloudCoverAt interpolates, tolerates one-sided nulls, null when no data', () => {
  const prof = [
    { z: 1000, cover: 20 },
    { z: 2000, cover: 80 },
    { z: 3000, cover: null },
    { z: 4000, cover: null },
  ];
  close(cloudCoverAt(prof, 1500), 50, 1e-9);
  close(cloudCoverAt(prof, 2500), 80, 1e-9);  // upper null → lower side used
  assert.equal(cloudCoverAt(prof, 3500), null); // both null
  assert.equal(cloudCoverAt(prof, 9000), null); // outside profile
  assert.equal(cloudCoverAt([], 1000), null);
});

test('cloudTypeFor: METAR buckets and genus by étage', () => {
  assert.equal(cloudTypeFor(9000, 5).okta, 'CLR');
  assert.deepEqual(
    [cloudTypeFor(9000, 30).okta, cloudTypeFor(9000, 30).genus], ['SCT', 'Cirrus']);
  assert.equal(cloudTypeFor(9000, 70).genus, 'Cirrostratus');
  assert.equal(cloudTypeFor(4000, 30).genus, 'Altocumulus');
  assert.equal(cloudTypeFor(4000, 60).genus, 'Altostratus');
  assert.equal(cloudTypeFor(1000, 30).genus, 'Cumulus');
  assert.equal(cloudTypeFor(1000, 60).genus, 'Stratocumulus');
  assert.equal(cloudTypeFor(1000, 95).genus, 'Stratus');
  assert.equal(cloudTypeFor(1000, 95).okta, 'OVC');
  assert.equal(cloudTypeFor(1000, 25).okta, 'SCT');
  assert.equal(cloudTypeFor(1000, 24.9).okta, 'FEW');
  assert.equal(cloudTypeFor(1000, NaN), null);
});

test('parseProfile carries cloud cover through (clamped), missing → null', () => {
  const h = mkHourly();
  h['cloud_cover_700hPa'] = [45];
  h['cloud_cover_500hPa'] = [130]; // out-of-range from model → clamped to 100
  const prof = parseProfile(h, 0, 200);
  assert.equal(prof.find(l => l.p === 700).cover, 45);
  assert.equal(prof.find(l => l.p === 500).cover, 100);
});

// ---------- per-aircraft felt severity ----------

test('same air, different aircraft: light aircraft feels it worse', () => {
  const edr = 0.25;
  assert.equal(feltCategory(edr, 'light').key, 'moderate');
  assert.equal(feltCategory(edr, 'medium').key, 'light');
  assert.equal(feltCategory(edr, 'heavy').key, 'light');
  assert.equal(feltCategory(0.5, 'heavy').key, 'moderate');
  assert.equal(feltCategory(0.5, 'light').key, 'severe');
  assert.equal(feltCategory(0.05, 'light').key, 'smooth');
});

test('feltCategory guards bad input; classes are ordered light→heavy', () => {
  assert.equal(feltCategory(NaN, 'heavy'), null);
  assert.equal(feltCategory(0.3, 'unknown-class'), null);
  assert.equal(AIRCRAFT_CLASSES.length, 3);
  // Monotonic: every threshold grows with weight class
  for (const band of ['light', 'moderate', 'severe']) {
    assert.ok(AIRCRAFT_CLASSES[0].thresholds[band] <= AIRCRAFT_CLASSES[1].thresholds[band]);
    assert.ok(AIRCRAFT_CLASSES[1].thresholds[band] <= AIRCRAFT_CLASSES[2].thresholds[band]);
  }
});

// ---------- interpolateUV ----------

test('interpolateUV: midpoint of the layer averages the winds', () => {
  const prof = twoLevelProfile(); // u 10→20 over 9000→10000
  const r = interpolateUV(prof, 9500);
  close(r.u, 15, 1e-9);
  close(r.v, 0, 1e-9);
  assert.equal(interpolateUV(prof, 12000), null);
  assert.equal(interpolateUV([], 9500), null);
});

// ---------- Ellrod (phase 2) ----------

test('ellrod: pure-deformation field gives TI1 = VWS·DEF, CVG = 0', () => {
  const derivs = { dudx: 1e-5, dudy: 0, dvdx: 0, dvdy: -1e-5 }; // DST=2e-5, DSH=0, CVG=0
  const r = ellrod(0.01, derivs);
  close(r.DEF, 2e-5, 1e-18);
  close(r.CVG, 0, 1e-18);
  close(r.TI1, 0.01 * 2e-5, 1e-18);
  close(r.TI2, r.TI1, 1e-18);
});

test('ellrod chains with horizontalDerivatives', () => {
  const d = horizontalDerivatives(45, 0.25, { uE: 15, uW: 5, uN: 10, uS: 10, vE: 0, vW: 0, vN: 0, vS: 0 });
  const r = ellrod(0.005, d);
  assert.ok(Number.isFinite(r.TI1) && r.TI1 > 0);
});

test('categorizeTI bands', () => {
  assert.equal(categorizeTI(13e-7).key, 'severe');
  assert.equal(categorizeTI(9e-7).key, 'moderate');
  assert.equal(categorizeTI(5e-7).key, 'lightmod');
  assert.equal(categorizeTI(2.5e-7).key, 'light');
  assert.equal(categorizeTI(0.5e-7).key, 'smooth');
  assert.equal(categorizeTI(NaN), null);
});
