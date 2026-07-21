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
  ac: (q.get('ac') || '').toUpperCase(),
};

// Aircraft type → ride-comfort class. Regional types (E-Jets, CRJs, turboprops)
// feel a class rougher than mainline metal; everything airline-sized else = mainline.
const REGIONAL_PREFIXES = ['E13', 'E14', 'E17', 'E19', 'E70', 'E75', 'E90', 'E95',
  'CRJ', 'CR1', 'CR2', 'CR7', 'CR9', 'CRK', 'DH1', 'DH2', 'DH3', 'DH4', 'DH8',
  'AT4', 'AT5', 'AT7', 'ATR', 'SF3', 'S20', 'J32', 'J41', 'EM2', 'E45', 'ER3', 'ER4', 'ERJ'];
function classForAircraft(type) {
  if (!type) return 'heavy';
  return REGIONAL_PREFIXES.some(p => type.startsWith(p)) ? 'medium' : 'heavy';
}
S.aircraftClass = classForAircraft(P.ac);

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

// What the air is physically doing — horizontal vs vertical motion, per cause.
const CAUSE_EXPLAIN = {
  jet: 'The jet stream is a fast river of horizontal wind. Where its speed changes between altitudes, the plane crosses layers moving at different speeds — mostly horizontal turbulence: gentle sways and brief sinks, not drops.',
  shear: 'Two smooth air layers sliding over each other make rolling waves, like ripples where wind crosses water. Crossing the crests gives short vertical bobs — the plane rides over them the way a boat rides a wake.',
  storm: 'Warm air rises and cool air falls in and near storms — vertical turbulence, the classic "elevator" feeling. Pilots see these cells on radar long before you do and steer around the strong cores as standard practice.',
  thermal: 'Sun-heated ground sends up invisible columns of rising air. Flying through them gives quick vertical nudges — strongest on warm afternoons at lower altitude, fading as you climb.',
  lowlevel: 'Wind near the ground shifts speed and direction as it rubs over terrain and buildings — brief horizontal jostles during climb and descent that smooth out with altitude.',
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
  let soothe = REASSURE[worstKey] || REASSURE.smooth;
  if (worst.length) {
    const cause = nearestRow((worst[0].fromMin + worst[0].toMin) / 2)?.cause;
    if (cause && CAUSE_EXPLAIN[cause.key]) soothe += ' ' + CAUSE_EXPLAIN[cause.key];
  }
  $('hero-soothe').textContent = soothe;
}

function renderCauses(worst) {
  const box = $('cause-strip');
  box.textContent = '';
  const seen = new Set();
  const addCard = (causeKey, label, color, rank, fromMin, toMin, phase, causeLabel) => {
    if (seen.has(causeKey)) return;
    seen.add(causeKey);
    const div = document.createElement('div');
    div.className = 'cause-item';
    div.style.color = color;
    const phaseTag = phase === 'climb' ? ' · climb' : phase === 'descent' ? ' · descent' : '';
    div.innerHTML = `${causeIcon(causeKey, rank)}<div><strong>${causeLabel}</strong>` +
      `<span>${fmtHM(fromMin)}–${fmtHM(toMin)} · ${label}${phaseTag}</span>` +
      (CAUSE_EXPLAIN[causeKey] ? `<em class="cause-explain">${CAUSE_EXPLAIN[causeKey]}</em>` : '') + `</div>`;
    box.appendChild(div);
  };

  // Cards for the annotated worst segments (deduped by cause).
  for (const w of worst) {
    const row = nearestRow((w.fromMin + w.toMin) / 2);
    if (row?.cause) addCard(row.cause.key, w.label.replace(' potential', ''), w.color, w.rank, w.fromMin, w.toMin, w.phase, row.cause.label);
  }
  // Storm sweep: convection anywhere on the path ALWAYS gets a card, even when
  // a windier segment outranks it — nervous flyers care most about storms.
  const stormRows = S.rows.filter(r => !r.noData && r.cause?.key === 'storm');
  if (stormRows.length && !seen.has('storm')) {
    const from = stormRows[0].point.tMin, to = stormRows[stormRows.length - 1].point.tMin;
    const worstStorm = stormRows.reduce((a, b) => ((b.felt?.rank || 0) > (a.felt?.rank || 0) ? b : a));
    addCard('storm', (worstStorm.felt?.label || 'Light potential').replace(' potential', ''),
      worstStorm.felt?.color || '#F2C94C', worstStorm.felt?.rank || 1, from, to,
      worstStorm.point.phase, worstStorm.cause.label);
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

  // Tappable icon legend
  const legend = $('legend-items');
  if (legend) {
    const items = [
      [ICONS.seatbelt, 'Seatbelt sign', 'Buckle-up conditions — Light–Moderate turbulence or stronger expected.'],
      [ICONS.jet, 'Jet stream wind', 'Fast horizontal winds aloft changing speed between altitudes.'],
      [ICONS.shear, 'Layer shear', 'Two smooth air layers sliding over each other, making wave-like bumps.'],
      [ICONS.storm, 'Storm activity', 'Rising/falling air in or near convective storms — vertical bumps.'],
      [ICONS.thermal, 'Thermals / low-level wind', 'Rising warm air or gusty near-ground wind during climb and descent.'],
      [ICONS.smooth, 'Calm air', 'Stable, smooth conditions.'],
      [ICONS.cloud, 'Light chop', 'Minor bumpiness — below seatbelt-sign level.'],
    ];
    for (const [icon, name, desc] of items) {
      const row = document.createElement('div');
      row.className = 'legend-row';
      row.innerHTML = `<span class="legend-icon">${icon}</span><div><strong>${name}</strong><span>${desc}</span></div>`;
      legend.appendChild(row);
    }
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

  // Globe zoom buttons — gesture-proof zoom on any device.
  if (S.globe) {
    $('zoom-in')?.addEventListener('click', () => S.globe.zoomBy(1.45));
    $('zoom-out')?.addEventListener('click', () => S.globe.zoomBy(1 / 1.45));
    $('zoom-fit')?.addEventListener('click', () => S.globe.resetZoom());
  }

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

// Keep this page self-updating too — it's usually opened in a fresh tab and
// must never pin an old cached build (the flight/index pages already do this).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

init().catch(e => window.__ssError?.(`Startup failed: ${e.message}`));
