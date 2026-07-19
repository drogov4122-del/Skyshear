// flightapp.js — controller for the flight-forecast page.
// Flow: airports autocomplete → modeled route → per-hour weather along it →
// profile chart + 3D globe + segment list. Flight list (AviationStack) is an
// optional layer; everything else needs no key.

import { buildFlightPath, formatDuration } from './route.js';
import { fetchRouteWeather, evaluateRoute, reFeel, worstSegments } from './flightcast.js';
import { renderProfileChart } from './profilechart.js';
import { createGlobe } from './globe.js';
import { getFlights, getApiKey, setApiKey, ScheduleError } from './schedules.js';
import { AIRCRAFT_CLASSES } from './turbulence.js';

const $ = id => document.getElementById(id);

const S = {
  airports: [],
  byIata: new Map(),
  origin: null,
  dest: null,
  aircraftClass: 'heavy',
  rows: null,
  meta: null,
  globe: null,
  searching: false,
};

// ---------------- Airport data + autocomplete ----------------

async function loadAirports() {
  const res = await fetch('./data/airports.json');
  if (!res.ok) throw new Error('airport database failed to load');
  S.airports = await res.json();
  for (const a of S.airports) S.byIata.set(a.i, a);
}

function searchAirports(q) {
  q = q.trim().toUpperCase();
  if (q.length < 2) return [];
  const scored = [];
  for (const a of S.airports) {
    let score = 0;
    if (a.i === q) score = 100;
    else if (a.i.startsWith(q)) score = 80;
    else if (a.c && a.c.toUpperCase().startsWith(q)) score = 60;
    else if (a.n.toUpperCase().includes(q)) score = 40;
    else if (a.c && a.c.toUpperCase().includes(q)) score = 30;
    if (score) scored.push([score + a.s * 5, a]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  return scored.slice(0, 8).map(x => x[1]);
}

function wireAutocomplete(inputId, listId, assign) {
  const input = $(inputId), list = $(listId);
  let active = -1; // keyboard-highlighted option index

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');

  const setExpanded = (open) => {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) { active = -1; input.removeAttribute('aria-activedescendant'); }
  };

  const highlight = (idx) => {
    const items = list.querySelectorAll('.ac-item');
    active = idx;
    items.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.setAttribute('aria-selected', String(i === idx));
    });
    if (idx >= 0 && items[idx]) input.setAttribute('aria-activedescendant', items[idx].id);
    else input.removeAttribute('aria-activedescendant');
  };

  const renderList = (items) => {
    list.textContent = '';
    setExpanded(items.length > 0);
    items.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ac-item';
      b.id = `${listId}-opt-${i}`;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', 'false');
      b.innerHTML = `<strong>${escapeHtml(a.i)}</strong> <span>${escapeHtml(a.c || a.n)}, ${escapeHtml(a.co || '')}</span>`;
      b.addEventListener('click', () => {
        assign(a);
        input.value = `${a.i} — ${a.c || a.n}`;
        setExpanded(false);
      });
      list.appendChild(b);
    });
  };

  input.addEventListener('input', () => {
    assign(null);
    renderList(searchAirports(input.value));
  });
  input.addEventListener('focus', () => {
    if (!input.dataset.touched) { input.dataset.touched = '1'; return; }
    renderList(searchAirports(input.value));
  });
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown' && !list.hidden && items.length) {
      e.preventDefault(); highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp' && !list.hidden && items.length) {
      e.preventDefault(); highlight((active - 1 + items.length) % items.length);
    } else if (e.key === 'Escape') {
      setExpanded(false);
    } else if (e.key === 'Enter' && !list.hidden && active >= 0 && items[active]) {
      e.preventDefault(); items[active].click();
    }
  });
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) setExpanded(false);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Resolve free-typed text to an airport if the user didn't click a suggestion. */
function resolveAirport(inputId, current) {
  if (current) return current;
  const raw = $(inputId).value.trim().toUpperCase();
  const iata = raw.slice(0, 3);
  if (S.byIata.has(iata)) return S.byIata.get(iata);
  const hits = searchAirports(raw);
  return hits[0] || null;
}

// ---------------- Search + forecast ----------------

function departureMs() {
  const v = $('dep-input').value;
  const ms = v ? new Date(v).getTime() : Date.now();
  return Number.isFinite(ms) ? ms : Date.now();
}

async function runSearch() {
  if (S.searching) return;
  const msg = $('search-message');
  const btn = $('search-btn');
  msg.textContent = '';
  // The ENTIRE body is guarded: an exception anywhere must land in the inline
  // message, never escape as an unhandled rejection into the global banner.
  S.searching = true;
  btn.disabled = true;
  btn.textContent = 'Forecasting…';
  try {
    S.origin = resolveAirport('origin-input', S.origin);
    S.dest = resolveAirport('dest-input', S.dest);
    if (!S.origin || !S.dest) { msg.textContent = 'Pick both airports (type a city or code, then tap a suggestion).'; return; }
    if (S.origin.i === S.dest.i) { msg.textContent = 'Origin and destination are the same airport.'; return; }

    const depMs = departureMs();
    const horizon = Date.now() + 7 * 86400000;
    if (depMs > horizon) { msg.textContent = 'Forecasts are only reliable ~7 days out — pick an earlier departure.'; return; }
    if (depMs < Date.now() - 86400000) { msg.textContent = 'That departure is in the past — pick a future time.'; return; }

    const fp = buildFlightPath({ lat: S.origin.la, lon: S.origin.lo }, { lat: S.dest.la, lon: S.dest.lo });
    if (!fp) { msg.textContent = 'Could not build a route between those airports.'; return; }

    const weather = await fetchRouteWeather(fp.points, depMs);
    S.rows = evaluateRoute(fp.points, weather, depMs, S.aircraftClass);
    S.meta = {
      durationMin: fp.durationMin,
      cruiseFt: fp.cruiseFt,
      totalKm: fp.totalKm,
      departureMs: depMs,
      originIata: S.origin.i,
      destIata: S.dest.i,
    };
    renderResults();
    $('result-section').hidden = false;
    $('result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Flight list reflects AviationStack's near-now data — only meaningful when
    // the searched departure is today (viewer's calendar).
    const isToday = new Date(depMs).toDateString() === new Date().toDateString();
    $('flights-section').hidden = !isToday;
    if (isToday) loadFlightList().catch(() => {}); // non-blocking enhancement
  } catch (e) {
    msg.textContent = (e && e.message) || 'Forecast failed — try again.';
  } finally {
    S.searching = false;
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

function renderResults() {
  const worst = worstSegments(S.rows);
  renderProfileChart($('profile-chart'), S.rows, S.meta, worst);
  renderSummary(worst);
  renderSegments();
  if (S.globe) {
    S.globe.setRoute(S.rows, S.meta.originIata, S.meta.destIata);
    S.globe.start();
  }
}

function renderSummary(worst) {
  const m = S.meta;
  const base = `${m.originIata} → ${m.destIata} · ${Math.round(m.totalKm).toLocaleString()} km · ` +
    `${formatDuration(m.durationMin)} · cruise FL${Math.round(m.cruiseFt / 100)} (${m.cruiseFt.toLocaleString()} ft)`;
  let verdict;
  if (!worst.length) {
    verdict = 'Mostly smooth conditions forecast.';
  } else {
    const w = worst[0];
    const range = (w.toMin - w.fromMin) < 5
      ? `around ${fmtHM(w.fromMin)}`
      : `${fmtHM(w.fromMin)}–${fmtHM(w.toMin)}`;
    verdict = `${w.label.replace(' potential', '')} turbulence possible ${range} into the flight.`;
  }
  $('result-summary').textContent = `${base} — ${verdict} Modeled route · times in your local time.`;
}

function fmtHM(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function renderSegments() {
  const list = $('segment-list');
  list.textContent = '';
  const step = Math.max(1, Math.floor(S.rows.length / 12));
  for (let i = 0; i < S.rows.length; i += step) {
    const r = S.rows[i];
    const div = document.createElement('div');
    div.className = 'segment-row';
    if (r.noData) {
      div.innerHTML = `<span class="seg-time mono">${fmtHM(r.point.tMin)}</span>` +
        `<span class="seg-phase">${r.point.phase}</span><span class="seg-cat dim">near airport</span>`;
    } else {
      const OKTA_WORD = { FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast' };
      const cloudTxt = !r.cloud ? '' : r.cloud.okta === 'CLR' ? '☀ Clear'
        : `☁ ${OKTA_WORD[r.cloud.okta] || r.cloud.okta} ${r.cloud.genus}`;
      div.dataset.cat = r.felt?.key || 'none';
      div.innerHTML =
        `<span class="seg-time mono">${fmtHM(r.point.tMin)}</span>` +
        `<span class="seg-fl mono">FL${String(Math.round(r.point.altFt / 100)).padStart(3, '0')}</span>` +
        `<span class="seg-cat">${r.felt ? r.felt.label.replace(' potential', '') : '—'}</span>` +
        `<span class="seg-cloud">${cloudTxt}</span>` +
        `<span class="seg-data mono" title="Vertical wind shear">shear ${r.layer.VWS_kt_kft.toFixed(1)} kt/1,000 ft</span>`;
    }
    list.appendChild(div);
  }
}

// ---------------- Flight list (optional layer) ----------------

async function loadFlightList() {
  const section = $('flights-section');
  const listEl = $('flight-list');
  const msg = $('flights-message');
  section.hidden = false;
  listEl.textContent = '';
  msg.textContent = getApiKey() ? 'Loading flights…' : '';
  try {
    const flights = await getFlights(S.origin.i, S.dest.i);
    msg.textContent = flights.length ? '' : 'No flights found for this route today.';
    for (const f of flights.slice(0, 12)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'flight-card';
      const dep = new Date(f.depTime);
      b.innerHTML = `<strong>${escapeHtml(f.flightIata || f.airline)}</strong>` +
        `<span>${escapeHtml(f.airline)}</span>` +
        `<span class="mono">${dep.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` +
        (f.aircraft ? `<span class="mono dim">${escapeHtml(f.aircraft)}</span>` : '');
      b.addEventListener('click', () => {
        $('dep-input').value = toLocalInputValue(dep);
        runSearch();
      });
      listEl.appendChild(b);
    }
  } catch (e) {
    msg.textContent = e instanceof ScheduleError ? e.message : 'Flight list unavailable.';
  }
}

function toLocalInputValue(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------- Init ----------------

async function init() {
  // Default departure: next half hour, local.
  const now = new Date(Date.now() + 30 * 60000);
  now.setMinutes(now.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (now.getMinutes() === 0) now.setHours(now.getHours() + 1);
  $('dep-input').value = toLocalInputValue(now);
  // Native picker floor: yesterday (matching the 24 h-past validation window).
  $('dep-input').min = toLocalInputValue(new Date(Date.now() - 86400000));

  wireAutocomplete('origin-input', 'origin-list', a => { S.origin = a; });
  wireAutocomplete('dest-input', 'dest-list', a => { S.dest = a; });

  $('swap-btn').addEventListener('click', () => {
    const o = S.origin, oi = $('origin-input').value;
    S.origin = S.dest; S.dest = o;
    $('origin-input').value = $('dest-input').value;
    $('dest-input').value = oi;
  });

  $('search-btn').addEventListener('click', runSearch);
  for (const id of ['origin-input', 'dest-input']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
  }

  // Aircraft class selector (same pattern as point mode)
  const group = $('aircraft-group');
  for (const cls of AIRCRAFT_CLASSES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.textContent = cls.label;
    b.dataset.key = cls.key;
    b.setAttribute('aria-pressed', String(cls.key === S.aircraftClass));
    b.addEventListener('click', () => {
      if (S.searching) return; // don't re-render stale rows mid-search
      S.aircraftClass = cls.key;
      for (const other of group.querySelectorAll('.seg-btn')) {
        other.setAttribute('aria-pressed', String(other.dataset.key === cls.key));
      }
      if (S.rows) {
        reFeel(S.rows, S.aircraftClass);
        renderResults();
      }
    });
    group.appendChild(b);
  }

  // Settings dialog
  const dialog = $('settings-dialog');
  $('settings-btn').addEventListener('click', () => {
    $('api-key-input').value = getApiKey();
    dialog.showModal();
  });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'save') setApiKey($('api-key-input').value);
  });

  // Data loads — airports are required, land is globe-only (degrades gracefully)
  await loadAirports();
  try {
    const res = await fetch('./data/land.json');
    const landPolys = await res.json();
    S.globe = createGlobe($('globe-canvas'), { landPolys });
  } catch {
    $('globe-canvas').closest('.result-block').hidden = true;
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

init().catch(e => window.__ssError?.(`Startup failed: ${e.message}`));
