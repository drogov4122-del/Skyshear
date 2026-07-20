// flightcast.js — turbulence forecast along a modeled flight path.
// Pure computation split from the thin fetch layer so the pipeline is testable.
// Key improvement over a static snapshot: each route point is evaluated at the
// forecast hour when the aircraft is actually THERE.

import {
  buildForecastUrl, parseProfile, layerAt, categorize, pseudoEdr, feltCategory,
  cloudCoverAt, cloudTypeFor, causeFor, nearestHourIndex, isoHourUTC, CATEGORIES,
} from './turbulence.js';

const LOW_LEVEL_M = 3000;   // below this, negative Ri is boundary-layer convection
const MIN_RUN_MIN = 3;      // ignore single-point severity blips in annotations
const LIGHTMOD = CATEGORIES.find(c => c.key === 'lightmod');

const CHUNK_SIZE = 15;          // points per Open-Meteo call (URL + payload size)
const FETCH_TIMEOUT_MS = 15000;

/**
 * Split route points into consecutive chunks, each with its own time window —
 * a 14-hour flight then downloads ~1/3 of the hours per chunk instead of all.
 * Pure. Returns [{ points, startHour, endHour, hourOffsetMs }].
 */
export function chunkRoute(routePoints, departureMs, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < routePoints.length; i += chunkSize) {
    const pts = routePoints.slice(i, i + chunkSize);
    const t0 = departureMs + pts[0].tMin * 60000;
    const t1 = departureMs + pts[pts.length - 1].tMin * 60000;
    chunks.push({
      points: pts,
      startHour: isoHourUTC(t0),
      endHour: isoHourUTC(t1 + 3600000),
    });
  }
  return chunks;
}

/**
 * Pure per-point evaluation. weatherByPoint: array (same order as routePoints)
 * of Open-Meteo per-point objects ({ hourly }). Returns rows:
 * { point, layer, cat, edr, felt, cloud, noData }.
 * Altitudes below the lowest pressure level (ground roll) return noData —
 * rendered as the airport phase, not an error.
 */
export function evaluateRoute(routePoints, weatherByPoint, departureMs, aircraftClass) {
  return routePoints.map((pt, i) => {
    const wx = weatherByPoint[i];
    if (!wx?.hourly?.time?.length) return { point: pt, noData: true };
    const whenMs = departureMs + pt.tMin * 60000;
    const idx = nearestHourIndex(wx.hourly.time, whenMs);
    const profile = parseProfile(wx.hourly, idx, 0);
    // Sample no lower than 600 m — below that the "turbulence" is just surface
    // gustiness the pressure-level model can't represent.
    const sampleAlt = Math.max(600, pt.altM);
    const layer = layerAt(profile, sampleAlt);
    if (!layer) return { point: pt, noData: true };
    const cat = categorize(layer.Ri, layer.VWS_kt_kft);
    const edr = pseudoEdr(layer.Ri, layer.VWS_kt_kft);
    let felt = feltCategory(edr, aircraftClass);
    // Below ~3 km, an unstable Ri is daytime boundary-layer convection —
    // normal climb-out chop, not severe clear-air turbulence. Cap the label.
    const lowLevel = sampleAlt < LOW_LEVEL_M;
    if (lowLevel && felt && felt.rank > LIGHTMOD.rank) felt = LIGHTMOD;
    const cover = cloudCoverAt(profile, sampleAlt);
    const cloud = cloudTypeFor(sampleAlt, cover);
    const cause = causeFor(layer, profile, sampleAlt, cover);
    return { point: pt, layer, cat, edr, felt, cloud, cause, lowLevel, noData: false };
  });
}

/**
 * Re-derive aircraft-dependent fields without refetching.
 */
export function reFeel(rows, aircraftClass) {
  for (const r of rows) {
    if (r.noData || r.edr == null) continue;
    let felt = feltCategory(r.edr, aircraftClass);
    if (r.lowLevel && felt && felt.rank > LIGHTMOD.rank) felt = LIGHTMOD;
    r.felt = felt;
  }
  return rows;
}

/**
 * Summarize contiguous same-severity segments for chart annotations.
 * Returns [{ fromMin, toMin, key, label, color }...] merged runs (rank>0 only
 * unless everything is smooth).
 */
export function worstSegments(rows, maxSegments = 3) {
  const valid = rows.filter(r => !r.noData && r.felt);
  const runs = [];
  for (const r of valid) {
    const last = runs[runs.length - 1];
    if (last && last.key === r.felt.key) {
      last.toMin = r.point.tMin;
    } else {
      runs.push({ key: r.felt.key, label: r.felt.label, color: r.felt.color, rank: r.felt.rank, fromMin: r.point.tMin, toMin: r.point.tMin });
    }
  }
  const flightMin = rows.length ? rows[rows.length - 1].point.tMin : 0;
  // A single-sample hit has fromMin === toMin but really represents ~one sample
  // interval of flight time — pad each run by half the spacing so an isolated
  // spike survives the min-run filter (the chart paints it; the verdict must too).
  const spacing = valid.length > 1 ? flightMin / (valid.length - 1) : 0;
  for (const run of runs) {
    run.fromMin = Math.max(0, run.fromMin - spacing / 2);
    run.toMin = Math.min(flightMin, run.toMin + spacing / 2);
  }
  const minRun = flightMin < 30 ? 0 : MIN_RUN_MIN;
  return runs
    .filter(x => x.rank > 0 && (x.toMin - x.fromMin) >= minRun)
    .sort((a, b) => b.rank - a.rank || (b.toMin - b.fromMin) - (a.toMin - a.fromMin))
    .slice(0, maxSegments);
}

/**
 * Fetch weather for the whole route (chunked, sequential to be kind to the
 * free tier). Throws Error with a friendly message on failure; every path
 * resolves within (chunks × timeout).
 */
export async function fetchRouteWeather(routePoints, departureMs) {
  const chunks = chunkRoute(routePoints, departureMs);
  const out = [];
  for (const chunk of chunks) {
    // Verified live: hour windows reaching into the recent past (the UI allows
    // departures up to 24 h ago) are served without any extra parameter.
    const url = buildForecastUrl(chunk.points, { startHour: chunk.startHour, endHour: chunk.endHour });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res, body;
    try {
      res = await fetch(url, { signal: ctrl.signal });
      body = await res.json();
    } catch {
      throw new Error(ctrl.signal.aborted ? 'Weather request timed out — try again.' : 'Network unreachable — check your connection.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || body?.error) {
      throw new Error(body?.reason || `Weather service error (HTTP ${res.status})`);
    }
    const arr = Array.isArray(body) ? body : [body];
    if (arr.length !== chunk.points.length) throw new Error('Unexpected weather response shape.');
    out.push(...arr);
  }
  return out;
}
