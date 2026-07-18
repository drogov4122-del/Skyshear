// geometry.js — pure functions only. No DOM, no fetch, no Date.
// World frame: x = East, y = North, z = Up. Bearings: 0 = N, 90 = E (clockwise).

export const EARTH_RADIUS_M = 6371000;
export const MAX_RANGE_KM = 400;
export const SHALLOW_ELEVATION_DEG = 3;
export const OVERHEAD_ELEVATION_DEG = 89;

// Flight-level ladder (spec): FL050 → FL450.
export const FL_LADDER = [50, 100, 150, 200, 250, 300, 340, 390, 450];

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function flToMeters(fl) {
  return fl * 100 * 0.3048;
}

/**
 * Device orientation (deg, W3C Z-X'-Y'' intrinsic: alpha yaw CCW, beta pitch, gamma roll)
 * → world direction of the BACK CAMERA (device −Z), plus screen-rotation note.
 *
 * NOTE: the build spec's reference snippet returns device +Z (out of the screen,
 * toward the user): with it an upright phone facing north reads bearing 180 and a
 * sky-pointed phone reads negative elevation. The spec instructs "verify
 * empirically" — the sign is corrected here and locked by unit tests:
 *   (0, 90, 0)  upright, back camera level facing north → bearing 0, elevation 0
 *   (0, 0, 0)   flat on table, screen up → elevation −90 (camera at the ground)
 *   (0, 180, 0) screen down, camera at zenith → elevation +90
 *
 * alpha/beta/gamma are reported in the device's NATURAL (portrait) frame and do
 * not change with UI rotation, so this function needs no screen-angle input.
 */
export function aimFromOrientation(alpha, beta, gamma) {
  const a = (alpha || 0) * D2R;
  const b = (beta || 0) * D2R;
  const g = (gamma || 0) * D2R;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  // Column 3 of R = Rz(alpha)·Rx(beta)·Ry(gamma) is device +Z in world coords:
  //   (+Z)ᵂ = ( cA·sG + sA·sB·cG,  sA·sG − cA·sB·cG,  cB·cG )
  // Back camera aim = −(+Z)ᵂ.
  let east = -(cA * sG + sA * sB * cG);
  let north = -(sA * sG - cA * sB * cG);
  let up = -(cB * cG);

  const n = Math.hypot(east, north, up) || 1;
  east /= n; north /= n; up /= n;

  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, up))) * R2D;
  let bearingDeg = Math.atan2(east, north) * R2D;
  if (bearingDeg < 0) bearingDeg += 360;
  return { bearingDeg, elevationDeg };
}

/**
 * Compass heading reports where the TOP of the device (natural portrait frame)
 * points. Held in landscape the top points sideways from the aim, so the aim
 * azimuth = compassHeading + screenAngle (screen.orientation.angle: 0/90/180/270;
 * window.orientation −90 ≡ 270). Verified: rotate the body 90° CW about the aim
 * axis → UI angle 270, device top = aim + 90° → aim = compass − 90 = compass + 270 (mod 360).
 */
export function compassToAimAzimuth(compassHeadingDeg, screenAngleDeg) {
  const a = ((compassHeadingDeg + (screenAngleDeg || 0)) % 360 + 360) % 360;
  return a;
}

/**
 * Ground distance (m) to reach altitude difference dh (m) at a given elevation angle.
 * Returns { distM, shallowFlag, overheadFlag }.
 */
export function groundDistForAltitude(dh, elevationDeg) {
  if (elevationDeg >= OVERHEAD_ELEVATION_DEG) {
    return { distM: 0, shallowFlag: false, overheadFlag: true };
  }
  if (elevationDeg <= SHALLOW_ELEVATION_DEG) {
    return { distM: MAX_RANGE_KM * 1000, shallowFlag: true, overheadFlag: false };
  }
  const distM = dh / Math.tan(elevationDeg * D2R);
  const max = MAX_RANGE_KM * 1000;
  if (distM > max) return { distM: max, shallowFlag: true, overheadFlag: false };
  return { distM, shallowFlag: false, overheadFlag: false };
}

/** Spherical forward geodesic. Returns { lat, lon } with lon normalized to [−180, 180). */
export function destPoint(lat, lon, bearingDeg, distM, R = EARTH_RADIUS_M) {
  const delta = distM / R;
  const theta = bearingDeg * D2R;
  const phi1 = lat * D2R;
  const lam1 = lon * D2R;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lam2 = lam1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return { lat: phi2 * R2D, lon: ((lam2 * R2D + 540) % 360) - 180 };
}

/**
 * Project the line of sight onto the FL ladder.
 * observer = { lat, lon, altMeters }
 * Returns array of { fl, targetAltM, lat, lon, groundDistKm, shallowFlag, overheadFlag, belowObserver }.
 */
export function projectRay(observer, bearingTrueDeg, elevationDeg, ladder = FL_LADDER) {
  const out = [];
  for (const fl of ladder) {
    const targetAltM = flToMeters(fl);
    const dh = targetAltM - (observer.altMeters || 0);
    if (dh <= 0) {
      out.push({
        fl, targetAltM,
        lat: observer.lat, lon: observer.lon,
        groundDistKm: 0, shallowFlag: false, overheadFlag: false, belowObserver: true,
      });
      continue;
    }
    const { distM, shallowFlag, overheadFlag } = groundDistForAltitude(dh, elevationDeg);
    const p = distM > 0
      ? destPoint(observer.lat, observer.lon, bearingTrueDeg, distM)
      : { lat: observer.lat, lon: observer.lon };
    out.push({
      fl, targetAltM,
      lat: p.lat, lon: p.lon,
      groundDistKm: distM / 1000,
      shallowFlag, overheadFlag, belowObserver: false,
    });
  }
  return out;
}

/**
 * Horizontal spatial derivatives from 4 neighbor samples (E, W, N, S) offset by
 * ±spacingDeg in lon/lat around centerLat. Values per second per meter.
 * Used by the Ellrod TI (phase 2) computation.
 */
export function horizontalDerivatives(centerLatDeg, spacingDeg, { uE, uW, uN, uS, vE, vW, vN, vS }) {
  const dyM = 2 * spacingDeg * D2R * EARTH_RADIUS_M;
  const dxM = dyM * Math.cos(centerLatDeg * D2R);
  // Poles: cos(90°) is ~6e-17 (not 0) in floating point, so guard on a real
  // metric threshold — spec says ignore polar edge cases.
  if (!(dxM > 1)) return null;
  return {
    dudx: (uE - uW) / dxM,
    dudy: (uN - uS) / dyM,
    dvdx: (vE - vW) / dxM,
    dvdy: (vN - vS) / dyM,
  };
}
