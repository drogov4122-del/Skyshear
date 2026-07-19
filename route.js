// route.js — pure flight-route modeling. No DOM, no fetch, no Date.
// Models the v1 flight path the way Turbli's fallback does: a great-circle
// track with a realistic climb → cruise → descent altitude/time profile.
// Labeled in the UI as "typical routing — actual flights deviate".

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_RADIUS_KM = 6371;

// Jet performance baseline (typical narrow/wide-body averages).
const CLIMB_FPM = 1800;          // ft/min average to cruise
const DESCENT_FPM = 1500;        // ft/min average
const CLIMB_GS_KMH = 280 * 1.852;   // ground speed during climb
const CRUISE_GS_KMH = 460 * 1.852;  // cruise ground speed
const DESCENT_GS_KMH = 300 * 1.852;

export function greatCircleDistanceKm(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R;
  const dφ = (lat2 - lat1) * D2R, dλ = (lon2 - lon1) * D2R;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Spherical linear interpolation along the great circle, f in [0,1]. */
export function greatCirclePoint(lat1, lon1, lat2, lon2, f) {
  const φ1 = lat1 * D2R, λ1 = lon1 * D2R, φ2 = lat2 * D2R, λ2 = lon2 * D2R;
  const x1 = Math.cos(φ1) * Math.cos(λ1), y1 = Math.cos(φ1) * Math.sin(λ1), z1 = Math.sin(φ1);
  const x2 = Math.cos(φ2) * Math.cos(λ2), y2 = Math.cos(φ2) * Math.sin(λ2), z2 = Math.sin(φ2);
  const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
  const σ = Math.acos(dot);
  if (σ < 1e-9) return { lat: lat1, lon: lon1 };
  const sinσ = Math.sin(σ);
  const A = Math.sin((1 - f) * σ) / sinσ, B = Math.sin(f * σ) / sinσ;
  const x = A * x1 + B * x2, y = A * y1 + B * y2, z = A * z1 + B * z2;
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) * R2D,
    lon: Math.atan2(y, x) * R2D,
  };
}

/** Typical cruise altitude (ft) by stage length. */
export function cruiseAltFt(distKm) {
  if (distKm < 400) return 24000;
  if (distKm < 900) return 30000;
  if (distKm < 2000) return 34000;
  if (distKm < 5000) return 36000;
  return 38000;
}

/**
 * Build the modeled path: N points with {lat, lon, altM, tMin, distKm, phase}.
 * origin/dest: {lat, lon}. Returns { points, totalKm, durationMin, cruiseFt }.
 * Guarantees: tMin strictly increasing, altitudes finite, phases ordered
 * climb → cruise → descent, and the profile fits even on short hops.
 */
export function buildFlightPath(origin, dest, { samples = 40 } = {}) {
  const totalKm = greatCircleDistanceKm(origin.lat, origin.lon, dest.lat, dest.lon);
  if (!(totalKm > 1)) return null;

  let cruiseFt = cruiseAltFt(totalKm);
  let climbKm = (cruiseFt / CLIMB_FPM) / 60 * CLIMB_GS_KMH;
  let descentKm = (cruiseFt / DESCENT_FPM) / 60 * DESCENT_GS_KMH;
  if (climbKm + descentKm > totalKm * 0.85) {
    const scale = (totalKm * 0.85) / (climbKm + descentKm);
    cruiseFt = Math.max(10000, Math.round(cruiseFt * scale / 1000) * 1000);
    climbKm = (cruiseFt / CLIMB_FPM) / 60 * CLIMB_GS_KMH;
    descentKm = (cruiseFt / DESCENT_FPM) / 60 * DESCENT_GS_KMH;
  }
  const cruiseKm = Math.max(0, totalKm - climbKm - descentKm);

  const climbMin = (cruiseFt / CLIMB_FPM);
  const cruiseMin = cruiseKm / CRUISE_GS_KMH * 60;
  const descentMin = (cruiseFt / DESCENT_FPM);
  const durationMin = climbMin + cruiseMin + descentMin;

  const points = [];
  const n = Math.max(8, Math.min(60, samples));
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const d = f * totalKm;
    const { lat, lon } = greatCirclePoint(origin.lat, origin.lon, dest.lat, dest.lon, f);

    let altFt, tMin, phase;
    if (d <= climbKm) {
      const g = climbKm > 0 ? d / climbKm : 1;
      altFt = cruiseFt * g;
      tMin = climbMin * g;
      phase = 'climb';
    } else if (d <= climbKm + cruiseKm) {
      altFt = cruiseFt;
      tMin = climbMin + (d - climbKm) / CRUISE_GS_KMH * 60;
      phase = 'cruise';
    } else {
      const g = Math.min(1, descentKm > 0 ? (d - climbKm - cruiseKm) / descentKm : 1);
      altFt = Math.max(0, cruiseFt * (1 - g));
      tMin = climbMin + cruiseMin + descentMin * g;
      phase = 'descent';
    }
    points.push({
      lat, lon,
      altM: altFt * 0.3048,
      altFt: Math.round(altFt),
      tMin,
      distKm: d,
      phase,
    });
  }
  return { points, totalKm, durationMin, cruiseFt };
}

/** "1h 45m" style formatting for durations in minutes. */
export function formatDuration(min) {
  if (!Number.isFinite(min) || min < 0) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
