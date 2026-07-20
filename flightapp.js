// flightapp.js — the flight SEARCH page. Airports + date → vertical list of
// remaining flights (with airline logos) → each card opens the big-format
// forecast page in a new tab. Also lists saved forecasts for offline use.
// The forecast itself lives on forecast.html (forecastapp.js).

import { getFlights, getApiKey, setApiKey, ScheduleError } from './schedules.js';

const $ = id => document.getElementById(id);

const S = {
  airports: [],
  byIata: new Map(),
  origin: null,
  dest: null,
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
  let active = -1;

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

  input.addEventListener('input', () => { assign(null); renderList(searchAirports(input.value)); });
  input.addEventListener('focus', () => {
    if (!input.dataset.touched) { input.dataset.touched = '1'; return; }
    renderList(searchAirports(input.value));
  });
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.ac-item');
    if (e.key === 'ArrowDown' && !list.hidden && items.length) { e.preventDefault(); highlight((active + 1) % items.length); }
    else if (e.key === 'ArrowUp' && !list.hidden && items.length) { e.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if (e.key === 'Escape') setExpanded(false);
    else if (e.key === 'Enter' && !list.hidden && active >= 0 && items[active]) { e.preventDefault(); items[active].click(); }
  });
  document.addEventListener('click', (e) => {
    if (!list.contains(e.target) && e.target !== input) setExpanded(false);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resolveAirport(inputId, current) {
  if (current) return current;
  const raw = $(inputId).value.trim().toUpperCase();
  const iata = raw.slice(0, 3);
  if (S.byIata.has(iata)) return S.byIata.get(iata);
  const hits = searchAirports(raw);
  return hits[0] || null;
}

// ---------------- Search → flight list ----------------

function searchDateStr() { return $('dep-date').value; } // YYYY-MM-DD (viewer-local)
function isTodaySearch() { return searchDateStr() === localDateStr(new Date()); }
function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function forecastUrl(depMs, flightIata = '', airline = '') {
  const u = new URLSearchParams({ from: S.origin.i, to: S.dest.i, dep: String(depMs) });
  if (flightIata) u.set('flight', flightIata);
  if (airline) u.set('airline', airline);
  return `forecast.html?${u}`;
}

function logoEl(airlineIata, airlineName) {
  const wrap = document.createElement('span');
  wrap.className = 'al-logo';
  const initials = (airlineIata || airlineName.slice(0, 2)).toUpperCase();
  if (airlineIata) {
    const img = document.createElement('img');
    img.src = `https://pics.avs.io/72/72/${encodeURIComponent(airlineIata)}.png`;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { wrap.textContent = initials; wrap.classList.add('al-logo-fallback'); });
    wrap.appendChild(img);
  } else {
    wrap.textContent = initials;
    wrap.classList.add('al-logo-fallback');
  }
  return wrap;
}

async function runSearch() {
  if (S.searching) return;
  const msg = $('search-message');
  msg.textContent = '';
  const btn = $('search-btn');
  S.searching = true;
  btn.disabled = true;
  btn.textContent = 'Searching…';
  try {
    S.origin = resolveAirport('origin-input', S.origin);
    S.dest = resolveAirport('dest-input', S.dest);
    if (!S.origin || !S.dest) { msg.textContent = 'Pick both airports (type a city or code, then tap a suggestion).'; return; }
    if (S.origin.i === S.dest.i) { msg.textContent = 'Origin and destination are the same airport.'; return; }
    const dateStr = searchDateStr();
    if (!dateStr) { msg.textContent = 'Pick a travel date.'; return; }
    const dayStart = new Date(`${dateStr}T00:00`).getTime();
    if (dayStart > Date.now() + 7 * 86400000) { msg.textContent = 'Forecasts are only reliable ~7 days out — pick an earlier date.'; return; }
    if (dayStart < Date.now() - 86400000 * 1.5) { msg.textContent = 'That date is in the past.'; return; }

    const section = $('flights-section');
    const listEl = $('flight-list');
    const fmsg = $('flights-message');
    section.hidden = false;
    listEl.textContent = '';

    if (isTodaySearch() && getApiKey()) {
      fmsg.textContent = 'Finding flights…';
      try {
        let flights = await getFlights(S.origin.i, S.dest.i);
        // Remaining flights only — nobody needs this morning's departures.
        const cutoff = Date.now() - 20 * 60000;
        flights = flights.filter(f => new Date(f.depTime).getTime() >= cutoff);
        if (flights.length) {
          fmsg.textContent = 'Tap your flight — the forecast opens in a new tab. (List can include partner/codeshare numbers — same plane, different number.)';
          for (const f of flights.slice(0, 20)) renderFlightCard(listEl, f);
        } else {
          fmsg.textContent = 'No remaining flights on this route today — use a custom departure time below.';
        }
      } catch (e) {
        fmsg.textContent = (e instanceof ScheduleError ? e.message : 'Flight list unavailable') + ' Use a custom time below.';
      }
    } else if (isTodaySearch()) {
      fmsg.textContent = 'To pick from real flights, add your free AviationStack key: tap the ⚙ gear (top right). Or use a custom departure time below.';
    } else {
      fmsg.textContent = 'Flight lists are available for today only — pick your departure time below.';
    }
    renderCustomCard(listEl);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    msg.textContent = (e && e.message) || 'Search failed — try again.';
  } finally {
    S.searching = false;
    btn.disabled = false;
    btn.textContent = 'Search';
  }
}

function renderFlightCard(listEl, f) {
  const dep = new Date(f.depTime);
  const a = document.createElement('a');
  a.className = 'flight-row';
  a.href = forecastUrl(dep.getTime(), f.flightIata, f.airline);
  a.target = '_blank';
  a.rel = 'noopener';
  a.append(logoEl(f.airlineIata, f.airline));
  const info = document.createElement('span');
  info.className = 'flight-row-info';
  info.innerHTML = `<strong>${escapeHtml(f.flightIata || f.airline)}</strong><span>${escapeHtml(f.airline)}${f.aircraft ? ' · ' + escapeHtml(f.aircraft) : ''}</span>`;
  a.append(info);
  const t = document.createElement('span');
  t.className = 'flight-row-time mono';
  t.textContent = dep.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  a.append(t);
  listEl.append(a);
}

function renderCustomCard(listEl) {
  const div = document.createElement('div');
  div.className = 'flight-row flight-row-custom';
  div.innerHTML = `<span class="al-logo al-logo-fallback">✈</span>` +
    `<span class="flight-row-info"><strong>Custom departure</strong><span>Not listed / private flight</span></span>`;
  const time = document.createElement('input');
  time.type = 'time';
  time.value = '12:00';
  time.className = 'mono custom-time-input';
  time.setAttribute('aria-label', 'Custom departure time');
  const go = document.createElement('a');
  go.className = 'btn accent small';
  go.textContent = 'Forecast';
  go.target = '_blank';
  go.rel = 'noopener';
  go.href = '#';
  go.addEventListener('click', (e) => {
    const depMs = new Date(`${searchDateStr()}T${time.value || '12:00'}`).getTime();
    if (!Number.isFinite(depMs)) { e.preventDefault(); return; }
    go.href = forecastUrl(depMs);
  });
  div.append(time, go);
  listEl.append(div);
}

// ---------------- Saved forecasts (offline shelf) ----------------

function renderSaved() {
  const box = $('saved-list');
  const section = $('saved-section');
  box.textContent = '';
  let idx = [];
  try { idx = JSON.parse(localStorage.getItem('ss_fc_index') || '[]'); } catch { /* ignore */ }
  const items = [];
  for (const key of idx) {
    try {
      const p = JSON.parse(localStorage.getItem(key) || 'null');
      if (p?.meta) items.push({ key, ...p });
    } catch { /* ignore */ }
  }
  section.hidden = !items.length;
  for (const it of items.slice(0, 6)) {
    const a = document.createElement('a');
    a.className = 'flight-row';
    const m = it.meta;
    a.href = `forecast.html?from=${m.originIata}&to=${m.destIata}&dep=${m.departureMs}` +
      (it.flight ? `&flight=${encodeURIComponent(it.flight)}&airline=${encodeURIComponent(it.airline || '')}` : '');
    a.innerHTML = `<span class="al-logo al-logo-fallback">💾</span>` +
      `<span class="flight-row-info"><strong>${escapeHtml(it.flight || `${m.originIata} → ${m.destIata}`)}</strong>` +
      `<span>${m.originIata} → ${m.destIata} · departs ${new Date(m.departureMs).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span></span>` +
      `<span class="flight-row-time mono">saved</span>`;
    box.append(a);
  }
}

// ---------------- Init ----------------

async function init() {
  // One-tap key install via #avkey= (hash never reaches servers/logs).
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('avkey');
  if (hashKey) {
    setApiKey(hashKey);
    history.replaceState(null, '', location.pathname + location.search);
    $('search-message').textContent = getApiKey()
      ? 'Flight-list key saved on this device ✓ — search a route and pick your flight.'
      : 'This browser is blocking storage (private mode?) — the key could not be saved.';
  }

  const today = new Date();
  $('dep-date').value = localDateStr(today);
  $('dep-date').min = localDateStr(today);
  $('dep-date').max = localDateStr(new Date(Date.now() + 7 * 86400000));

  wireAutocomplete('origin-input', 'origin-list', a => { S.origin = a; });
  wireAutocomplete('dest-input', 'dest-list', a => { S.dest = a; });

  $('swap-btn').addEventListener('click', () => {
    const o = S.origin, oi = $('origin-input').value;
    S.origin = S.dest; S.dest = o;
    $('origin-input').value = $('dest-input').value;
    $('dest-input').value = oi;
  });

  $('search-btn').addEventListener('click', () => { runSearch().catch(() => {}); });
  for (const id of ['origin-input', 'dest-input']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') runSearch().catch(() => {}); });
  }

  const dialog = $('settings-dialog');
  $('settings-btn').addEventListener('click', () => {
    $('api-key-input').value = getApiKey();
    dialog.showModal();
  });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'save') setApiKey($('api-key-input').value);
  });

  if (!navigator.onLine) {
    $('search-message').textContent = 'You appear to be offline — saved forecasts below still work.';
  }
  renderSaved();
  window.addEventListener('pageshow', renderSaved); // refresh shelf when returning

  await loadAirports();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      if (!S.searching) location.reload();
    });
  }
}

init().catch(e => window.__ssError?.(`Startup failed: ${e.message}`));
