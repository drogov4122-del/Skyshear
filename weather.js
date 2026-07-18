// weather.js — the only module that touches the network.
// Fetch Open-Meteo with a hard timeout, normalize the response shape, keep the
// last good result, and back off after repeated failures. Never hangs: every
// path resolves within FETCH_TIMEOUT_MS.

import { buildForecastUrl } from './turbulence.js';

export const FETCH_TIMEOUT_MS = 10000;
const BACKOFF_START_MS = 10000;
const BACKOFF_MAX_MS = 60000;

let lastGood = null;          // { data: [...], atMs, key }
let backoffUntilMs = 0;
let backoffMs = BACKOFF_START_MS;

export function getLastGood() { return lastGood; }

/** Cache key: rounded coordinates — same ray ≈ same key. */
export function pointsKey(points) {
  return points.map(p => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`).join(';');
}

export class WeatherError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // 'timeout' | 'http' | 'api' | 'network' | 'shape' | 'backoff'
}

/**
 * Fetch pressure-level forecasts for an array of {lat, lon} points.
 * Resolves { data: [perPointObject...], atMs, fromCache:false }.
 * Throws WeatherError. On failure the caller can render getLastGood().
 */
export async function fetchWeather(points, nowMs, opts = {}) {
  if (nowMs < backoffUntilMs) {
    throw new WeatherError(`Retrying in ${Math.ceil((backoffUntilMs - nowMs) / 1000)}s`, 'backoff');
  }
  const url = buildForecastUrl(points, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    registerFailure(nowMs);
    throw new WeatherError(
      ctrl.signal.aborted ? 'Weather request timed out' : 'Network unreachable',
      ctrl.signal.aborted ? 'timeout' : 'network'
    );
  } finally {
    clearTimeout(timer);
  }
  try {
    body = await res.json();
  } catch {
    registerFailure(nowMs);
    throw new WeatherError('Bad response from weather service', 'shape');
  }
  if (!res.ok || body?.error) {
    registerFailure(nowMs);
    throw new WeatherError(body?.reason || `Weather service error (HTTP ${res.status})`, res.ok ? 'api' : 'http');
  }
  // 1 point → single object; N points → array. Normalize.
  const arr = Array.isArray(body) ? body : [body];
  if (arr.length !== points.length || !arr.every(o => o && o.hourly && Array.isArray(o.hourly.time))) {
    registerFailure(nowMs);
    throw new WeatherError('Unexpected weather response shape', 'shape');
  }
  backoffMs = BACKOFF_START_MS;
  backoffUntilMs = 0;
  lastGood = { data: arr, atMs: nowMs, key: pointsKey(points) };
  return { data: arr, atMs: nowMs, fromCache: false };
}

function registerFailure(nowMs) {
  backoffUntilMs = nowMs + backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

/** Test hook. */
export function _resetForTest() {
  lastGood = null; backoffUntilMs = 0; backoffMs = BACKOFF_START_MS;
}
