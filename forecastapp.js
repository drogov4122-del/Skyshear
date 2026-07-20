// forecastapp.js — dedicated big-format forecast page.
// Opened from the flight chooser with ?from=ORD&to=EWR&dep=<ms>&flight=UA485&airline=...
// Computes, renders large, and SAVES the result locally so it can be reopened
// in airplane mode mid-flight (?from..&dep.. matches a saved copy, or via the
// saved-forecast links on the search page).

import { buildFlightPath, formatDuration } from './route.js';
import { fetchRouteWeather, evaluateRoute, reFeel, worstSegments } from './flightcast.js';
import { renderProfileChart } from './profilechart.js';
import { createGlobe } from './globe.js';
import { AIRCRAFT_CLASSES } from './turbulence.js';
import { causeIcon, severityIcon, ICONS } from './icons.js';
import { loadRadarWorld } from './radar.js';

const $ = id => document.getElementById(id);
const SAVE_INDEX = 'ss_fc_index';
const SAVE_PREFIX = 'ss_fc_';
const SAVE_MAX = 6;

const S = { rows: null, meta: null, globe: null, aircraftClass: 'heavy', fromSaved: false };

const q = new URLSearchParams(location.search);
const P = {
  from: (q.get('from') || '').toUpperCase(),
  to: (q.get('to') || '').toUpperCase(),
  dep: parseInt(q.get('dep'), 10),
  flight: q.get('flight') || '',
  airline: q.get('airline') || '',
};

function saveKey() { return `${SAVE_PREFIX}${P.from}_${P.to}_${P.dep}`; }

function persist() {
  try {
    const payload = { rows: S.rows, meta: S.meta, flight: P.flight, airline: P.airline, savedAtMs: Date.now() };
    localStorage.setItem(saveKey(), JSON.stringify(payload));
    const idx = JSON.parse(localStorage.getItem(SAVE_INDEX) || '[]').filter(k => k !== saveKey());
    idx.unshift(saveKey());
    for (const stale of idx.slice(SAVE_MAX)) localStorage.removeItem(stale);
    localStorage.setItem(SAVE_INDEX, JSON.stringify(idx.slice(0, SAVE_MAX)));
  } catch { /* storage full/private — forecast still shows, just not saved */ }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(saveKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function fmtHM(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function render() {
  const worst = worstSegments(S.rows);
  renderProfileChart($('profile-chart'), S.rows, S.meta, worst);
  renderHero(worst);
  renderCauses(worst);
  renderSegments();
  if (S.globe) {
    S.globe.setRoute(S.rows, S.meta.originIata, S.meta.destIata);
    S.globe.setTimes?.(S.meta.departureMs, S.rows);
    S.globe.start();
  }
}

// What it feels like + why it's normal — written for nervous flyers.
const REASSURE = {
  smooth: 'Expect a calm ride. Tiny wiggles can still happen — that\'s just the plane riding ordinary air, like a boat on gentle water.',
  light: 'You may feel light rocking or a few soft bumps, like a car on a slightly rough road. Completely routine — crews usually keep serving drinks right through it.',
  lightmod: 'Occasional noticeable bumps; the seatbelt sign may come on. That\'s standard procedure, not a sign of trouble — the plane is simply crossing choppier air, the way a boat crosses a wake.',
  moderate: 'Firmer jolts — drinks may slosh and walking gets awkward. Uncomfortable, but routine for the aircraft: airliners are certified for forces far beyond this, and pilots routinely change altitude to find smoother air.',
  severe: 'Strong jolts are possible in this air — which is exactly why pilots plan around it and will reroute or change altitude. Even at this level, the aircraft stays well within its structural limits; buckle up and let the crew do their job.',
};

function renderHero(worst) {
  const m = S.meta;
  $('hero-flight').textContent = P.flight ? `${P.flight} · ${P.airline}` : `${m.originIata} → ${m.destIata}`;
  $('hero-route').textContent = `${m.originIata} → ${m.destIata} · ${Math.round(m.totalKm).toLocaleString()} km · ` +
    `${formatDuration(m.durationMin)} · cruise FL${Math.round(m.cruiseFt / 100)} (${m.cruiseFt.toLocaleString()} ft) · ` +
    `departs ${new Date(m.departureMs).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (your local time)`;
  const heroV = $('hero-verdict');
  if (!worst.length) {
    heroV.innerHTML = `${ICONS.smooth} <span>Mostly smooth conditions forecast.</span>`;
    heroV.dataset.cat = 'smooth';
  } else {
    const w = worst[0];
    const range = (w.toMin - w.fromMin) < 5 ? `around ${fmtHM(w.fromMin)}` : `${fmtHM(w.fromMin)}–${fmtHM(w.toMin)}`;
    // Seatbelt sign from Light–Mod up, plus the cause glyph (storm/jet/shear).
    const cause = nearestRow((w.fromMin + w.toMin) / 2)?.cause;
    const icons = (w.rank >= 2 ? ICONS.seatbelt : '') + (cause ? causeIcon(cause.key, w.rank) : (w.rank >= 2 ? '' : ICONS.cloud));
    const phaseTxt = w.phase === 'climb' ? ` during climb (${range})`
      : w.phase === 'descent' ? ` during descent (${range})`
      : ` ${range} into the flight`;
    heroV.innerHTML = `${icons} <span>${w.label.replace(' potential', '')} turbulence possible${phaseTxt}` +
      (cause ? ` — ${cause.label.toLowerCase()}` : '') + `.</span>`;
    heroV.dataset.cat = w.key;
  }
  $('saved-note').hidden = !S.fromSaved;
  const worstKey = worst.length ? worst[0].key : 'smooth';
  $('hero-soothe').textContent = REASSURE[worstKey] || REASSURE.smooth;
}

function renderCauses(worst) {
  const box = $('cause-strip');
  box.textContent = '';
  // Name the cause for each annotated worst segment (deduped by cause key).
  const seen = new Set();
  for (const w of worst) {
    const mid = (w.fromMin + w.toMin) / 2;
    const row = nearestRow(mid);
    const cause = row?.cause;
    if (!cause || seen.has(cause.key)) continue;
    seen.add(cause.key);
    const div = document.createElement('div');
    div.className = 'cause-item';
    div.style.color = w.color;
    const phaseTag = w.phase === 'climb' ? ' · climb' : w.phase === 'descent' ? ' · descent' : '';
    div.innerHTML = `${causeIcon(cause.key, w.rank)}<div><strong>${cause.label}</strong>` +
      `<span>${fmtHM(w.fromMin)}–${fmtHM(w.toMin)} · ${w.label.replace(' potential', '')}${phaseTag}</span></div>`;
    box.appendChild(div);
  }
  box.parentElement.hidden = !box.children.length;
}

function nearestRow(tMin) {
  let best = null, bd = Infinity;
  for (const r of S.rows) {
    if (r.noData) continue;
    const d = Math.abs(r.point.tMin - tMin);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}

function renderSegments() {
  const list = $('segment-list');
  list.textContent = '';
  const OKTA_WORD = { FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast' };
  const step = Math.max(1, Math.floor(S.rows.length / 14));
  for (let i = 0; i < S.rows.length; i += step) {
    const r = S.rows[i];
    const div = document.createElement('div');
    div.className = 'segment-row';
    if (r.noData) {
      div.innerHTML = `<span class="seg-time mono">${fmtHM(r.point.tMin)}</span>` +
        `<span class="seg-phase">${r.point.phase}</span><span class="seg-cat dim">near airport</span>`;
    } else {
      const cloudTxt = !r.cloud ? '' : r.cloud.okta === 'CLR' ? '☀ Clear'
        : `☁ ${OKTA_WORD[r.cloud.okta] || r.cloud.okta} ${r.cloud.genus}`;
      div.dataset.cat = r.felt?.key || 'none';
      div.innerHTML =
        `<span class="seg-icon">${r.cause ? causeIcon(r.cause.key, r.felt?.rank || 0) : severityIcon(r.felt?.rank || 0)}</span>` +
        `<span class="seg-time mono">${fmtHM(r.point.tMin)}</span>` +
        `<span class="seg-fl mono">FL${String(Math.round(r.point.altFt / 100)).padStart(3, '0')}</span>` +
        `<span class="seg-cat">${r.felt ? r.felt.label.replace(' potential', '') : '—'}` +
        (r.cause ? `<em class="seg-cause">${r.cause.label}</em>` : '') + `</span>` +
        `<span class="seg-cloud">${cloudTxt}</span>`;
    }
    list.appendChild(div);
  }
}

function fail(msg) {
  $('page-message').textContent = msg;
  $('page-message').hidden = false;
}

async function init() {
  if (!P.from || !P.to || !Number.isFinite(P.dep)) {
    fail('Missing flight details — open a forecast from the Flight forecast search page.');
    return;
  }

  // Aircraft selector
  const group = $('aircraft-group');
  for (const cls of AIRCRAFT_CLASSES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'seg-btn'; b.textContent = cls.label; b.dataset.key = cls.key;
    b.setAttribute('aria-pressed', String(cls.key === S.aircraftClass));
    b.addEventListener('click', () => {
      S.aircraftClass = cls.key;
      for (const o of group.querySelectorAll('.seg-btn')) o.setAttribute('aria-pressed', String(o.dataset.key === cls.key));
      if (S.rows) { reFeel(S.rows, S.aircraftClass); render(); }
    });
    group.appendChild(b);
  }

  // Globe (optional)
  try {
    const landPolys = await (await fetch('./data/land.json')).json();
    S.globe = createGlobe($('globe-canvas'), { landPolys });
  } catch { $('globe-canvas').closest('.result-block').hidden = true; }

  // Live radar layer — strictly optional (offline/failed fetch = no layer).
  const radarBtn = $('radar-btn');
  if (S.globe && navigator.onLine) {
    loadRadarWorld().then(world => {
      S.globe.setRadar(world);
      if (radarBtn) {
        radarBtn.hidden = false;
        radarBtn.addEventListener('click', () => {
          const on = radarBtn.getAttribute('aria-pressed') !== 'true';
          radarBtn.setAttribute('aria-pressed', String(on));
          radarBtn.textContent = on ? 'Radar on' : 'Radar off';
          S.globe.toggleRadar(on);
        });
        radarBtn.setAttribute('aria-pressed', 'true');
        radarBtn.textContent = 'Radar on';
        S.globe.toggleRadar(true);
      }
      const hint = document.querySelector('.globe-hint');
      if (hint && world.timeMs) {
        const age = Math.max(0, Math.round((Date.now() - world.timeMs) / 60000));
        hint.textContent += ` · Radar © RainViewer (${age} min ago)`;
      }
    }).catch(() => { /* radar is a bonus, never a blocker */ });
  }

  // Saved copy first when offline; otherwise compute live and save.
  const saved = loadSaved();
  if (!navigator.onLine && saved) {
    S.rows = saved.rows; S.meta = saved.meta; S.fromSaved = true;
    render();
    return;
  }
  try {
    const airports = await (await fetch('./data/airports.json')).json();
    const byIata = new Map(airports.map(a => [a.i, a]));
    const o = byIata.get(P.from), d = byIata.get(P.to);
    if (!o || !d) { fail(`Unknown airport code (${!o ? P.from : P.to}).`); return; }
    const fp = buildFlightPath({ lat: o.la, lon: o.lo }, { lat: d.la, lon: d.lo });
    if (!fp) { fail('Could not build a route between those airports.'); return; }
    const weather = await fetchRouteWeather(fp.points, P.dep);
    S.rows = evaluateRoute(fp.points, weather, P.dep, S.aircraftClass);
    S.meta = {
      durationMin: fp.durationMin, cruiseFt: fp.cruiseFt, totalKm: fp.totalKm,
      departureMs: P.dep, originIata: P.from, destIata: P.to,
    };
    render();
    persist();
  } catch (e) {
    if (saved) {
      S.rows = saved.rows; S.meta = saved.meta; S.fromSaved = true;
      render();
      fail('No connection — showing your saved forecast for this flight.');
    } else {
      fail((e && e.message) || 'Forecast failed — check your connection and reload.');
    }
  }
}

init().catch(e => window.__ssError?.(`Startup failed: ${e.message}`));
