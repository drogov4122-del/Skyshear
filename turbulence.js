// turbulence.js — pure functions only. No DOM, no fetch, no Date.
// Builds vertical profiles from Open-Meteo pressure-level data and derives
// vertical wind shear, Brunt–Väisälä frequency, gradient Richardson number,
// turbulence categories, and (phase 2) Ellrod turbulence indices.

export const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100];

const G = 9.81;
const KAPPA = 0.2857; // R/cp
// 1 (m/s)/m → kt per 1000 ft : ×304.8 m per kft × 1.9438 kt per m/s
const VWS_TO_KT_PER_KFT = 304.8 * 1.9438;
export const RI_LARGE = 999; // stands in for "no shear / effectively infinite Ri"

export const CATEGORIES = [
  { key: 'severe',   label: 'Moderate–Severe potential', color: '#FF3D8B', rank: 4 },
  { key: 'moderate', label: 'Moderate potential',        color: '#FF8A3D', rank: 3 },
  { key: 'lightmod', label: 'Light–Moderate potential',  color: '#F2C94C', rank: 2 },
  { key: 'light',    label: 'Light potential',           color: '#E8E37A', rank: 1 },
  { key: 'smooth',   label: 'Smooth',                    color: '#3FE0C5', rank: 0 },
];

const CAT_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

/** Wind FROM direction (meteorological) + speed → u (east), v (north) components. */
export function windToUV(speedMs, dirDeg) {
  const r = dirDeg * Math.PI / 180;
  return { u: -speedMs * Math.sin(r), v: -speedMs * Math.cos(r) };
}

export function potentialTemperature(tempC, pressureHPa) {
  return (tempC + 273.15) * Math.pow(1000 / pressureHPa, KAPPA);
}

/**
 * Build the hourly= parameter variable list (4 vars × each pressure level).
 */
export function hourlyVariableList(levels = PRESSURE_LEVELS) {
  const vars = [];
  for (const L of levels) {
    vars.push(
      `temperature_${L}hPa`,
      `wind_speed_${L}hPa`,
      `wind_direction_${L}hPa`,
      `geopotential_height_${L}hPa`,
      `cloud_cover_${L}hPa`,
    );
  }
  return vars;
}

/**
 * Pure URL builder for the Open-Meteo multi-point forecast call.
 * points: array of { lat, lon }. Coordinates rounded to 3 decimals (~110 m) —
 * plenty for a 13–25 km model grid and keeps URLs short and cache-friendly.
 */
export function buildForecastUrl(points, { models = 'gfs_seamless', forecastDays = 1, levels = PRESSURE_LEVELS, startHour, endHour } = {}) {
  const lats = points.map(p => p.lat.toFixed(3)).join(',');
  const lons = points.map(p => p.lon.toFixed(3)).join(',');
  // startHour/endHour ("YYYY-MM-DDTHH:00", UTC) window the response to just the
  // hours needed — a 1-hour window is ~24× less hourly data than a full day.
  // Verified live: windows reaching into the recent past are served as-is
  // (and past_days is mutually exclusive with hour windows — never combine).
  const timeSel = startHour && endHour
    ? `&start_hour=${startHour}&end_hour=${endHour}`
    : `&forecast_days=${forecastDays}`;
  return 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lats}&longitude=${lons}`
    + `&hourly=${hourlyVariableList(levels).join(',')}`
    + '&wind_speed_unit=ms'
    + timeSel
    + `&models=${models}`
    + '&timezone=GMT';
}

/** Epoch ms → "YYYY-MM-DDTHH:00" in UTC (Open-Meteo hour-window format). */
export function isoHourUTC(ms) {
  return new Date(ms).toISOString().slice(0, 13) + ':00';
}

/**
 * Index of the hourly timestamp nearest to nowMs (epoch ms, UTC).
 * Open-Meteo returns ISO strings without a zone suffix; with timezone=GMT they
 * are UTC — parse them as such.
 */
export function nearestHourIndex(times, nowMs) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(times[i] + (times[i].endsWith('Z') ? '' : 'Z'));
    const diff = Math.abs(t - nowMs);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

/**
 * Extract a sorted vertical profile from one point's `hourly` block at hour idx.
 * Drops levels that are non-finite or at/below the observer altitude (spec:
 * geopotential_height is MSL; skip below-observer / below-ground / NaN).
 * Returns [{ p, z, tempC, theta, u, v }] sorted ascending by z.
 */
export function parseProfile(hourly, idx, observerAltM = 0, levels = PRESSURE_LEVELS) {
  const profile = [];
  for (const p of levels) {
    const z = hourly[`geopotential_height_${p}hPa`]?.[idx];
    const tempC = hourly[`temperature_${p}hPa`]?.[idx];
    const spd = hourly[`wind_speed_${p}hPa`]?.[idx];
    const dir = hourly[`wind_direction_${p}hPa`]?.[idx];
    if (![z, tempC, spd, dir].every(Number.isFinite)) continue;
    if (z <= observerAltM) continue;
    const { u, v } = windToUV(spd, dir);
    const cover = hourly[`cloud_cover_${p}hPa`]?.[idx];
    profile.push({
      p, z, tempC, theta: potentialTemperature(tempC, p), u, v,
      cover: Number.isFinite(cover) ? Math.max(0, Math.min(100, cover)) : null,
    });
  }
  profile.sort((a, b) => a.z - b.z);
  return profile;
}

/**
 * Shear/stability across the layer bracketing targetAltM.
 * Returns { VWS, VWS_kt_kft, N2, Ri, zLower, zUpper } or null if no bracket.
 * All outputs guaranteed finite.
 */
export function layerAt(profile, targetAltM) {
  if (!profile || profile.length < 2) return null;
  for (let i = 0; i < profile.length - 1; i++) {
    const lo = profile[i], up = profile[i + 1];
    if (!(lo.z <= targetAltM && targetAltM <= up.z)) continue;
    const dz = up.z - lo.z;
    if (!(dz >= 1)) continue; // degenerate (duplicate z) — the next pair may still bracket

    const dudz = (up.u - lo.u) / dz;
    const dvdz = (up.v - lo.v) / dz;
    const VWS = Math.hypot(dudz, dvdz);
    const thetaMean = (up.theta + lo.theta) / 2;
    const N2 = (G / thetaMean) * ((up.theta - lo.theta) / dz);
    const Ri = VWS < 1e-6 ? RI_LARGE : Math.min(RI_LARGE, Math.max(-RI_LARGE, N2 / (VWS * VWS)));

    const out = { VWS, VWS_kt_kft: VWS * VWS_TO_KT_PER_KFT, N2, Ri, zLower: lo.z, zUpper: up.z };
    if (Object.keys(out).every(k => Number.isFinite(out[k]))) return out;
  }
  return null;
}

/**
 * Linear interpolation of wind components at targetAltM within the profile.
 * Returns { u, v } or null if no bracketing pair. Used for Ellrod neighbor columns.
 */
export function interpolateUV(profile, targetAltM) {
  if (!profile || profile.length < 2) return null;
  for (let i = 0; i < profile.length - 1; i++) {
    const lo = profile[i], up = profile[i + 1];
    if (!(lo.z <= targetAltM && targetAltM <= up.z)) continue;
    const dz = up.z - lo.z;
    if (!(dz >= 1)) continue; // degenerate (duplicate z) — the next pair may still bracket
    const f = (targetAltM - lo.z) / dz;
    const u = lo.u + f * (up.u - lo.u);
    const v = lo.v + f * (up.v - lo.v);
    if (Number.isFinite(u) && Number.isFinite(v)) return { u, v };
  }
  return null;
}

/**
 * Ri + shear → turbulence category (spec bands; honest, uncalibrated).
 */
export function categorize(Ri, VWS_kt_kft) {
  if (!Number.isFinite(Ri) || !Number.isFinite(VWS_kt_kft)) return null;
  if (Ri < 0.25) return CAT_BY_KEY.severe;
  if (Ri < 1.0) return CAT_BY_KEY.moderate;
  if (Ri < 10) return VWS_kt_kft >= 6 ? CAT_BY_KEY.lightmod : CAT_BY_KEY.light;
  return CAT_BY_KEY.smooth;
}

/**
 * Monotonic 0–1 heuristic for display familiarity. Explicitly NOT calibrated
 * EDR — the UI must label it "estimated, not measured".
 * Blends inverse-Ri instability with shear magnitude, both saturating.
 */
export function pseudoEdr(Ri, VWS_kt_kft) {
  if (!Number.isFinite(Ri) || !Number.isFinite(VWS_kt_kft)) return 0;
  const riTerm = 1 / (1 + Math.max(Ri, 0));          // 1 at Ri=0 → 0 as Ri grows
  const shearTerm = Math.min(VWS_kt_kft / 20, 1);    // saturate at 20 kt/1000ft
  return Math.max(0, Math.min(1, 0.6 * riTerm + 0.4 * shearTerm));
}

/**
 * Cloud cover (%) at targetAltM, linearly interpolated between the bracketing
 * levels. If one side lacks data, the other side is used; null if neither has.
 */
export function cloudCoverAt(profile, targetAltM) {
  if (!profile || profile.length < 1) return null;
  if (profile.length === 1) return profile[0].cover;
  for (let i = 0; i < profile.length - 1; i++) {
    const lo = profile[i], up = profile[i + 1];
    if (!(lo.z <= targetAltM && targetAltM <= up.z)) continue;
    if (lo.cover == null && up.cover == null) return null;
    if (lo.cover == null) return up.cover;
    if (up.cover == null) return lo.cover;
    const dz = up.z - lo.z;
    if (!(dz >= 1)) continue;
    const f = (targetAltM - lo.z) / dz;
    return lo.cover + f * (up.cover - lo.cover);
  }
  return null;
}

/**
 * METAR-style coverage bucket + cloud genus for an altitude (m MSL).
 * Étage boundaries (mid-latitudes): low < 2 km, mid 2–6 km, high > 6 km.
 * Honest labeling: genus is inferred from altitude band + coverage only —
 * the model reports coverage, not cloud type.
 */
export function cloudTypeFor(altM, coverPct) {
  if (!Number.isFinite(coverPct)) return null;
  let okta;
  if (coverPct < 10) return { okta: 'CLR', genus: 'Clear', coverPct };
  else if (coverPct < 25) okta = 'FEW';
  else if (coverPct < 50) okta = 'SCT';
  else if (coverPct < 90) okta = 'BKN';
  else okta = 'OVC';

  let genus;
  if (altM > 6000) genus = coverPct >= 50 ? 'Cirrostratus' : 'Cirrus';
  else if (altM > 2000) genus = coverPct >= 50 ? 'Altostratus' : 'Altocumulus';
  else genus = coverPct >= 90 ? 'Stratus' : coverPct >= 50 ? 'Stratocumulus' : 'Cumulus';
  return { okta, genus, coverPct };
}

/**
 * Attribute the LIKELY physical cause of turbulence at a point, from the same
 * profile data. Heuristics follow standard CAT climatology:
 *  - unstable layer (N² ≤ 0) + meaningful cloud → convection/storms
 *  - strong winds aloft (≥ 30 m/s above ~25,000 ft) → jet-stream shear
 *  - low altitude (< ~10,000 ft) → low-level shear / thermals
 *  - otherwise → shear between stable air layers (Kelvin–Helmholtz)
 * Returns { key, label, icon } or null for smooth/no-data.
 */
export function causeFor(layer, profile, sampleAltM, coverPct) {
  if (!layer || !Number.isFinite(layer.Ri)) return null;
  if (layer.Ri >= 10) return null; // smooth — no cause worth naming
  const uv = interpolateUV(profile, sampleAltM);
  const windMs = uv ? Math.hypot(uv.u, uv.v) : 0;
  if (layer.N2 <= 1e-6 && (coverPct ?? 0) >= 40) {
    return { key: 'storm', label: 'Convection — storm activity' };
  }
  if (layer.N2 <= 1e-6) {
    return { key: 'thermal', label: 'Unstable air — thermals/convection' };
  }
  if (windMs >= 30 && sampleAltM > 7600) {
    return { key: 'jet', label: 'Jet stream wind shear' };
  }
  if (sampleAltM < 3000) {
    return { key: 'lowlevel', label: 'Low-level wind shear' };
  }
  return { key: 'shear', label: 'Shear between air layers' };
}

/**
 * Aircraft classes. How bumpy the same air feels depends on wing loading and
 * speed — a C172 gets tossed where a 777 barely ripples. Thresholds are applied
 * to the ESTIMATED EDR (pseudoEdr) and follow the shape of ICAO Annex 3 /
 * WMO EDR reporting bands per weight class (light/medium/heavy). Because our
 * EDR is a forecast-derived estimate (not measured), these remain honest
 * "potential" labels, not observations.
 */
export const AIRCRAFT_CLASSES = [
  { key: 'light', label: 'Light aircraft', short: 'GA',  thresholds: { light: 0.10, moderate: 0.20, severe: 0.45 } },
  { key: 'medium', label: 'Regional jet',  short: 'RJ',  thresholds: { light: 0.15, moderate: 0.35, severe: 0.50 } },
  { key: 'heavy', label: 'Mainline jet', short: 'JET', thresholds: { light: 0.20, moderate: 0.45, severe: 0.60 } },
];

const CLASS_BY_KEY = Object.fromEntries(AIRCRAFT_CLASSES.map(c => [c.key, c]));

/**
 * Per-aircraft "felt as" severity from estimated EDR.
 * Returns one of CATEGORIES (smooth / light / moderate / severe keys).
 */
export function feltCategory(edrEstimate, aircraftClassKey) {
  const cls = CLASS_BY_KEY[aircraftClassKey];
  if (!cls || !Number.isFinite(edrEstimate)) return null;
  const t = cls.thresholds;
  if (edrEstimate >= t.severe) return CAT_BY_KEY.severe;
  if (edrEstimate >= t.moderate) return CAT_BY_KEY.moderate;
  if (edrEstimate >= t.light) return CAT_BY_KEY.light;
  return CAT_BY_KEY.smooth;
}

/**
 * Phase 2 — Ellrod turbulence indices (Ellrod & Knapp 1992).
 * derivs = { dudx, dudy, dvdx, dvdy } in 1/s (from geometry.horizontalDerivatives).
 * Returns { DEF, CVG, TI1, TI2 } — all 1/s² scale (display ×1e7 conventionally).
 */
export function ellrod(VWS, derivs) {
  if (!derivs || !Number.isFinite(VWS)) return null;
  const { dudx, dudy, dvdx, dvdy } = derivs;
  if (![dudx, dudy, dvdx, dvdy].every(Number.isFinite)) return null;
  const DSH = dvdx + dudy;
  const DST = dudx - dvdy;
  const DEF = Math.hypot(DSH, DST);
  const CVG = -(dudx + dvdy);
  return { DEF, CVG, TI1: VWS * DEF, TI2: VWS * (DEF + CVG) };
}

/** Ellrod TI display bands (×1e-7 s⁻² thresholds from operational usage; conservative labels). */
export function categorizeTI(TI) {
  if (!Number.isFinite(TI)) return null;
  const t = TI * 1e7;
  if (t >= 12) return CAT_BY_KEY.severe;
  if (t >= 8) return CAT_BY_KEY.moderate;
  if (t >= 4) return CAT_BY_KEY.lightmod;
  if (t >= 2) return CAT_BY_KEY.light;
  return CAT_BY_KEY.smooth;
}
