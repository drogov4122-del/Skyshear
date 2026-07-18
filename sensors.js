// sensors.js — geolocation + device orientation with permission gating,
// watchdogs, smoothing, and lifecycle handling. Design rule: no code path may
// wait forever. Every permission request and listener attach races a timeout;
// every failure lands in a named state the UI can render.

import { aimFromOrientation, compassToAimAzimuth } from './geometry.js';

export const SENSOR_STATES = {
  OFF: 'off',                 // not started (initial, or user hasn't tapped Enable)
  STARTING: 'starting',       // tap received, waiting for permission / first event
  LIVE: 'live',               // events flowing
  STALE: 'stale',             // was live, no event for >2 s while visible
  DENIED: 'denied',           // permission explicitly denied
  UNAVAILABLE: 'unavailable', // no API / no events arrived / webview swallowed it
};

const FIRST_EVENT_TIMEOUT_MS = 3000;
const PERMISSION_TIMEOUT_MS = 5000;
const STALE_AFTER_MS = 2000;
const SMOOTH_ALPHA = 0.15;

export function isSecure() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function isLikelyWebview() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /FBAN|FBAV|Instagram|Line\/|; wv\)|GSA\/|Snapchat/i.test(ua);
}

export function orientationApiPresent() {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
}

function screenAngle() {
  if (typeof screen !== 'undefined' && screen.orientation && Number.isFinite(screen.orientation.angle)) {
    return screen.orientation.angle;
  }
  const w = typeof window !== 'undefined' ? window.orientation : 0;
  return Number.isFinite(w) ? ((w % 360) + 360) % 360 : 0;
}

/**
 * Orientation + location controller.
 * opts: {
 *   onAim({bearingDeg, elevationDeg, azimuthSource, raw}),  – smoothed, ~event rate
 *   onState(state, detailMessage),
 *   onLocation({lat, lon, altMeters, accuracy, assumedSeaLevel}),
 *   onLocationError(message),
 *   now: () => ms   – injectable clock for tests
 * }
 */
export function createSensorController(opts) {
  const now = opts.now || (() => Date.now());
  let state = SENSOR_STATES.OFF;
  let lastEventMs = 0;
  let smoothing = null; // { sinB, cosB, elev }
  let watchdogTimer = null;
  let firstEventTimer = null;
  let listenersAttached = false;
  let usingAbsoluteListener = false;

  function setState(next, detail) {
    if (state !== next) {
      state = next;
      opts.onState?.(next, detail || '');
    }
  }

  function detach() {
    if (!listenersAttached) return;
    window.removeEventListener('deviceorientationabsolute', handleOrientation);
    window.removeEventListener('deviceorientation', handleOrientation);
    listenersAttached = false;
  }

  function attach() {
    if (listenersAttached) return;
    // Attach BOTH; prefer absolute events when they carry data (Android), keep
    // plain deviceorientation for iOS (which never fires the absolute variant).
    window.addEventListener('deviceorientationabsolute', handleOrientation, { passive: true });
    window.addEventListener('deviceorientation', handleOrientation, { passive: true });
    listenersAttached = true;
  }

  function handleOrientation(e) {
    // If absolute events flow, ignore the non-absolute stream (Android fires both).
    if (e.type === 'deviceorientationabsolute') usingAbsoluteListener = true;
    else if (usingAbsoluteListener) return;
    if (e.alpha == null && e.beta == null && e.gamma == null) return; // some browsers fire one empty event

    lastEventMs = now();
    if (firstEventTimer) { clearTimeout(firstEventTimer); firstEventTimer = null; }
    if (state === SENSOR_STATES.STARTING || state === SENSOR_STATES.STALE) {
      setState(SENSOR_STATES.LIVE);
    }

    const { bearingDeg: matrixBearing, elevationDeg } = aimFromOrientation(e.alpha, e.beta, e.gamma);

    // Azimuth source priority (spec): iOS compass → absolute alpha (matrix) → matrix fallback.
    let bearing, azimuthSource;
    const compass = e.webkitCompassHeading;
    if (typeof compass === 'number' && Number.isFinite(compass) && compass >= 0) {
      bearing = compassToAimAzimuth(compass, screenAngle());
      azimuthSource = 'compass';
    } else if (e.type === 'deviceorientationabsolute' || e.absolute === true) {
      bearing = matrixBearing;              // absolute alpha → matrix bearing is magnetic-north referenced
      azimuthSource = 'absolute';
    } else {
      bearing = matrixBearing;              // arbitrary origin — usable only with user calibration
      azimuthSource = 'uncalibrated';
    }

    // Circular EMA for bearing (0/360-safe), scalar EMA for elevation.
    const rad = bearing * Math.PI / 180;
    if (!smoothing) {
      smoothing = { sinB: Math.sin(rad), cosB: Math.cos(rad), elev: elevationDeg };
    } else {
      smoothing.sinB += SMOOTH_ALPHA * (Math.sin(rad) - smoothing.sinB);
      smoothing.cosB += SMOOTH_ALPHA * (Math.cos(rad) - smoothing.cosB);
      smoothing.elev += SMOOTH_ALPHA * (elevationDeg - smoothing.elev);
    }
    let smoothBearing = Math.atan2(smoothing.sinB, smoothing.cosB) * 180 / Math.PI;
    if (smoothBearing < 0) smoothBearing += 360;

    opts.onAim?.({
      bearingDeg: smoothBearing,
      elevationDeg: smoothing.elev,
      azimuthSource,
      raw: { alpha: e.alpha, beta: e.beta, gamma: e.gamma, compass, screenAngle: screenAngle(), absolute: e.absolute === true || e.type === 'deviceorientationabsolute' },
    });
  }

  function armFirstEventWatchdog() {
    if (firstEventTimer) clearTimeout(firstEventTimer);
    firstEventTimer = setTimeout(() => {
      if (state === SENSOR_STATES.STARTING) {
        detach();
        setState(SENSOR_STATES.UNAVAILABLE,
          isLikelyWebview()
            ? 'No motion data in this in-app browser — open in Safari or Chrome, or use manual mode.'
            : 'No motion data from this device — manual mode is on.');
      }
    }, FIRST_EVENT_TIMEOUT_MS);
  }

  /** MUST be called synchronously from a user tap handler (iOS requirement). */
  async function enable() {
    if (!isSecure()) {
      setState(SENSOR_STATES.UNAVAILABLE, 'Sensors need HTTPS — manual mode only.');
      return state;
    }
    if (!orientationApiPresent()) {
      setState(SENSOR_STATES.UNAVAILABLE, 'This device has no orientation sensors — manual mode is on.');
      return state;
    }
    setState(SENSOR_STATES.STARTING);
    smoothing = null;
    usingAbsoluteListener = false;

    const needsPermission = typeof DeviceOrientationEvent.requestPermission === 'function';
    if (needsPermission) {
      let result;
      try {
        // Race against a watchdog: some webviews never settle this promise.
        // The native promise keeps its own no-op catch so a late rejection
        // (after the timeout wins) can't surface as an unhandled rejection
        // and trigger the global error banner.
        const native = DeviceOrientationEvent.requestPermission();
        native.catch(() => {});
        result = await Promise.race([
          native,
          new Promise(res => setTimeout(() => res('timeout'), PERMISSION_TIMEOUT_MS)),
        ]);
      } catch {
        // iOS throws (not rejects) when not called from a gesture, or on repeat denials.
        result = 'denied';
      }
      if (result === 'timeout') {
        setState(SENSOR_STATES.UNAVAILABLE, 'Motion permission never answered — open in Safari/Chrome or use manual mode.');
        return state;
      }
      if (result !== 'granted') {
        setState(SENSOR_STATES.DENIED, 'Motion access denied — close and reopen this tab to be asked again, or use manual mode.');
        return state;
      }
    }
    attach();
    armFirstEventWatchdog();
    startStaleWatchdog();
    return state;
  }

  function startStaleWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (state === SENSOR_STATES.LIVE && now() - lastEventMs > STALE_AFTER_MS) {
        setState(SENSOR_STATES.STALE, 'Motion data stopped — move the phone, or tap Enable sensors again.');
      }
    }, 1000);
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible') {
      // iOS can silently stop delivering events after backgrounding; re-attach
      // (free if already attached) and re-arm the first-event watchdog so a dead
      // stream degrades to a visible state instead of a frozen display.
      if (state === SENSOR_STATES.LIVE || state === SENSOR_STATES.STALE) {
        attach();
        setState(SENSOR_STATES.STARTING, 'Rechecking motion sensors…');
        armFirstEventWatchdog();
      }
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  function stop() {
    detach();
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (firstEventTimer) { clearTimeout(firstEventTimer); firstEventTimer = null; }
    setState(SENSOR_STATES.OFF);
  }

  // ---------------- Geolocation ----------------

  let lastFixMs = 0;

  function requestLocation() {
    if (!('geolocation' in navigator)) {
      opts.onLocationError?.('No location service — enter coordinates below.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        lastFixMs = now();
        const { latitude, longitude, altitude, accuracy } = pos.coords;
        opts.onLocation?.({
          lat: latitude,
          lon: longitude,
          altMeters: Number.isFinite(altitude) ? altitude : 0,
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
          assumedSeaLevel: !Number.isFinite(altitude),
        });
      },
      err => {
        const msg = err.code === 1
          ? 'Location is off — enter coordinates below.'
          : 'No location fix — retry, or enter coordinates below.';
        opts.onLocationError?.(msg);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function locationAgeMs() { return lastFixMs ? now() - lastFixMs : Infinity; }

  return {
    enable, stop, requestLocation, locationAgeMs,
    getState: () => state,
    lastEventAgeMs: () => (lastEventMs ? now() - lastEventMs : Infinity),
  };
}
