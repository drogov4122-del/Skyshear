// schedules.js — flight list for a route via AviationStack (free tier: 100
// requests/month, CORS-enabled, HTTPS). The API key lives ONLY in the user's
// browser localStorage — never in this repo. Aggressive per-route caching keeps
// well inside the free quota. The whole app works without a key; this module
// only powers the optional "pick your exact flight" list.

const KEY_STORAGE = 'ss_avstack_key';
const CACHE_PREFIX = 'ss_flights2_'; // v2 shape: airport-local wall times + epoch
const CACHE_TTL_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 12000;

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* private mode — key just won't persist */ }
}

function cacheKey(dep, arr) {
  const day = new Date().toISOString().slice(0, 10);
  return `${CACHE_PREFIX}${dep}_${arr}_${day}`;
}

function readCache(dep, arr) {
  try {
    const raw = localStorage.getItem(cacheKey(dep, arr));
    if (!raw) return null;
    const { atMs, flights } = JSON.parse(raw);
    if (Date.now() - atMs > CACHE_TTL_MS) return null;
    return flights;
  } catch { return null; }
}

function writeCache(dep, arr, flights) {
  try {
    localStorage.setItem(cacheKey(dep, arr), JSON.stringify({ atMs: Date.now(), flights }));
  } catch { /* storage full/blocked — fine */ }
}

/**
 * AviationStack quirk (verified against Google/OAG): `departure.scheduled` is
 * the AIRPORT-LOCAL wall time wearing a fake "+00:00" suffix. Convert a wall
 * time + IANA zone to a real epoch using the standard two-pass Intl technique.
 */
export function epochFromZonedWall(scheduled, ianaTz) {
  const wall = String(scheduled).replace(/(\.\d+)?([+-]\d\d:?\d\d|Z)$/, '');
  let t = Date.parse(wall + 'Z');
  if (!Number.isFinite(t)) return NaN;
  if (!ianaTz) return t;
  try {
    for (let i = 0; i < 2; i++) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: ianaTz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(t);
      const g = k => parts.find(p => p.type === k)?.value ?? '00';
      const h = g('hour') === '24' ? '00' : g('hour');
      const asUtc = Date.parse(`${g('year')}-${g('month')}-${g('day')}T${h}:${g('minute')}:${g('second')}Z`);
      t += Date.parse(wall + 'Z') - asUtc;
    }
    return t;
  } catch { return Date.parse(wall + 'Z'); }
}

export class ScheduleError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // 'nokey' | 'auth' | 'quota' | 'network' | 'shape'
}

/**
 * Flights for a route today. Returns [{ airline, flightIata, depTime, arrTime,
 * depTerminal, aircraft, status }]. Cached per route per day.
 */
export async function getFlights(depIata, arrIata) {
  const cached = readCache(depIata, arrIata);
  if (cached) return cached;

  const key = getApiKey();
  if (!key) throw new ScheduleError('Add your free AviationStack key (tap the ⚙ gear, top right) to list real flights — or pick a departure time below.', 'nokey');

  const url = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(key)}`
    + `&dep_iata=${depIata}&arr_iata=${arrIata}&limit=25`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(url, { signal: ctrl.signal });
    body = await res.json();
  } catch {
    throw new ScheduleError('Flight list unavailable (network) — pick a departure time below.', 'network');
  } finally {
    clearTimeout(timer);
  }
  if (body?.error) {
    const code = body.error.code || '';
    if (String(code).includes('invalid_access_key')) {
      throw new ScheduleError('AviationStack key rejected — check it via the ⚙ gear (top right).', 'auth');
    }
    if (String(code).includes('usage_limit') || String(code).includes('rate_limit')) {
      throw new ScheduleError('Monthly flight-list quota used up — pick a departure time below.', 'quota');
    }
    throw new ScheduleError('Flight list unavailable — pick a departure time below.', 'shape');
  }
  const data = body?.data;
  if (!Array.isArray(data)) throw new ScheduleError('Unexpected flight-list response — pick a departure time below.', 'shape');

  const flights = data
    .filter(f => f?.departure?.scheduled)
    // Drop marketing codeshares (RJ/QR/CM numbers on UA metal etc.) — the
    // operating carrier's own entry is also in the list and is the one
    // passengers actually board.
    .filter(f => !f?.flight?.codeshared)
    .map(f => ({
      airline: f.airline?.name || f.airline?.iata || 'Unknown airline',
      airlineIata: f.airline?.iata || null,
      flightIata: f.flight?.iata || f.flight?.icao || '',
      // Airport-local wall time (what boarding passes and Google show) + true epoch.
      depWall: String(f.departure.scheduled).replace(/(\.\d+)?([+-]\d\d:?\d\d|Z)$/, ''),
      depMs: epochFromZonedWall(f.departure.scheduled, f.departure?.timezone),
      arrTime: f.arrival?.scheduled || null,
      depTerminal: f.departure?.terminal || null,
      aircraft: f.aircraft?.iata || null,
      status: f.flight_status || null,
    }))
    .sort((a, b) => a.depWall.localeCompare(b.depWall));

  writeCache(depIata, arrIata, flights);
  return flights;
}
