// app.js — the replaceable shell around the pure core.
// State in, DOM out. Sensor events and fetches never write the DOM directly;
// they update `S` and the render pipeline patches only what changed.

import { projectRay, FL_LADDER, flToMeters, horizontalDerivatives } from './geometry.js';
import {
  parseProfile, layerAt, categorize, pseudoEdr, feltCategory, interpolateUV,
  ellrod, categorizeTI, nearestHourIndex, AIRCRAFT_CLASSES,
  cloudCoverAt, cloudTypeFor, isoHourUTC,
} from './turbulence.js';
import { fetchWeather, getLastGood, WeatherError } from './weather.js';
import { createSensorController, SENSOR_STATES, isSecure, isLikelyWebview, orientationApiPresent } from './sensors.js';

const NEIGHBOR_SPACING_DEG = 0.25;
const REFETCH_BEARING_DEG = 5;
const REFETCH_ELEVATION_DEG = 2;
const REFETCH_AGE_MS = 60000;

// ---------------- State ----------------

const S = {
  observer: null,            // { lat, lon, altMeters, accuracy, assumedSeaLevel, source }
  aim: { bearingDeg: 0, elevationDeg: 45, azimuthSource: 'manual' },
  raw: null,                 // last raw sensor payload (debug)
  calibrationOffset: 0,
  hold: false,
  mode: 'manual',            // 'manual' | 'sensors'
  sensorState: SENSOR_STATES.OFF,
  sensorMessage: '',
  aircraftClass: 'heavy',
  highDetail: false,
  cameraOn: false,
  fetch: {
    inFlight: false,
    lastAim: null,           // { bearingDeg, elevationDeg } at last successful fetch
    lastKeyMs: 0,
    results: null,           // per-FL rows
    stale: false,
    modelTime: '',
    error: '',
  },
  locationMessage: '',
  debug: new URLSearchParams(location.search).has('debug'),
};

const $ = id => document.getElementById(id);
const els = {};

function effectiveBearing() {
  return ((S.aim.bearingDeg + S.calibrationOffset) % 360 + 360) % 360;
}

// ---------------- Fetch + compute ----------------

function angleDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function shouldFetch(nowMs) {
  if (!S.observer || S.fetch.inFlight) return false;
  if (!S.fetch.results) return true;
  if (nowMs - S.fetch.lastKeyMs > REFETCH_AGE_MS) return true;
  const la = S.fetch.lastAim;
  if (!la) return true;
  return angleDelta(effectiveBearing(), la.bearingDeg) > REFETCH_BEARING_DEG
    || Math.abs(S.aim.elevationDeg - la.elevationDeg) > REFETCH_ELEVATION_DEG;
}

async function runFetch(force = false) {
  // Nothing in here may reject unhandled — callers (interval tick, button
  // handlers) do not attach .catch.
  try {
    await runFetchInner(force);
  } catch (e) {
    S.fetch.error = e?.message || 'Unexpected error';
    S.fetch.inFlight = false;
    renderStatus();
  }
}

async function runFetchInner(force) {
  const nowMs = Date.now();
  if (!force && !shouldFetch(nowMs)) return;
  if (!S.observer || S.fetch.inFlight) return;

  const bearing = effectiveBearing();
  const elevation = S.aim.elevationDeg;
  const ray = projectRay(S.observer, bearing, Math.max(0, elevation));
  const active = ray.filter(p => !p.belowObserver);

  // Build the request point list; in high-detail mode add 4 neighbors per point.
  const points = [];
  const index = new Map(); // fl → { center, neighbors: {E,W,N,S} } indices into points
  for (const p of active) {
    const entry = { center: points.length };
    points.push({ lat: p.lat, lon: p.lon });
    if (S.highDetail) {
      entry.neighbors = {
        E: points.push({ lat: p.lat, lon: p.lon + NEIGHBOR_SPACING_DEG }) - 1,
        W: points.push({ lat: p.lat, lon: p.lon - NEIGHBOR_SPACING_DEG }) - 1,
        N: points.push({ lat: p.lat + NEIGHBOR_SPACING_DEG, lon: p.lon }) - 1,
        S: points.push({ lat: p.lat - NEIGHBOR_SPACING_DEG, lon: p.lon }) - 1,
      };
    }
    index.set(p.fl, entry);
  }
  if (!points.length) {
    S.fetch.results = ray.map(p => ({ ray: p, noData: true }));
    S.fetch.error = '';
    renderLadder();
    return;
  }

  S.fetch.inFlight = true;
  renderStatus();
  try {
    // Window the request to now→now+1h (~24× less data than a full day) and
    // give heavier high-detail payloads (45 points) more runway before aborting.
    const { data, atMs } = await fetchWeather(points, nowMs, {
      startHour: isoHourUTC(nowMs),
      endHour: isoHourUTC(nowMs + 3600000),
      ...(S.highDetail ? { timeoutMs: 20000 } : {}),
    });
    S.fetch.results = computeRows(ray, index, data);
    S.fetch.lastAim = { bearingDeg: bearing, elevationDeg: elevation };
    S.fetch.lastKeyMs = atMs;
    S.fetch.stale = false;
    S.fetch.error = '';
    const t = data[0].hourly.time[nearestHourIndex(data[0].hourly.time, nowMs)];
    if (t) S.fetch.modelTime = `GFS · ${t.slice(11)}Z`;
    // First results in sensor mode: bring the ladder into view — the user was
    // just down at the controls tapping Enable and would otherwise see nothing.
    if (S.mode === 'sensors' && !S.scrolledToResults) {
      S.scrolledToResults = true;
      els.ladder.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (e) {
    const cached = getLastGood();
    S.fetch.error = e instanceof WeatherError ? e.message : 'Weather fetch failed';
    if (cached && !S.fetch.results) {
      // Nothing rendered yet but we have an older answer for a previous aim — leave it.
    }
    S.fetch.stale = !!S.fetch.results;
  } finally {
    S.fetch.inFlight = false;
    renderStatus();
    renderLadder();
  }
}

function computeRows(ray, index, data) {
  const nowMs = Date.now();
  return ray.map(rp => {
    if (rp.belowObserver) return { ray: rp, belowObserver: true };
    const entry = index.get(rp.fl);
    const point = data[entry.center];
    if (!point?.hourly) return { ray: rp, noData: true };
    const idx = nearestHourIndex(point.hourly.time, nowMs);
    const profile = parseProfile(point.hourly, idx, S.observer.altMeters || 0);
    const layer = layerAt(profile, rp.targetAltM);
    if (!layer) return { ray: rp, noData: true };

    const cat = categorize(layer.Ri, layer.VWS_kt_kft);
    const edr = pseudoEdr(layer.Ri, layer.VWS_kt_kft);
    const felt = feltCategory(edr, S.aircraftClass);
    const cloud = cloudTypeFor(rp.targetAltM, cloudCoverAt(profile, rp.targetAltM));

    let ti = null, tiCat = null;
    if (S.highDetail && entry.neighbors) {
      const uv = {};
      for (const [k, i] of Object.entries(entry.neighbors)) {
        const np = data[i];
        if (!np?.hourly) { uv[k] = null; continue; }
        const nprof = parseProfile(np.hourly, nearestHourIndex(np.hourly.time, nowMs), S.observer.altMeters || 0);
        uv[k] = interpolateUV(nprof, rp.targetAltM);
      }
      if (uv.E && uv.W && uv.N && uv.S) {
        const derivs = horizontalDerivatives(rp.lat, NEIGHBOR_SPACING_DEG, {
          uE: uv.E.u, uW: uv.W.u, uN: uv.N.u, uS: uv.S.u,
          vE: uv.E.v, vW: uv.W.v, vN: uv.N.v, vS: uv.S.v,
        });
        const r = ellrod(layer.VWS, derivs);
        if (r) { ti = r.TI1; tiCat = categorizeTI(r.TI1); }
      }
    }
    return { ray: rp, layer, cat, edr, felt, ti, tiCat, cloud };
  });
}

// ---------------- Rendering ----------------

const fmt = {
  deg: v => `${v.toFixed(0)}°`,
  coord: v => v.toFixed(4),
  km: v => v >= 100 ? v.toFixed(0) : v.toFixed(1),
  ri: v => (v >= 100 ? '≥100' : v.toFixed(2)),
  kt: v => v.toFixed(1),
  edr: v => v.toFixed(2),
};

function buildLadder() {
  const frag = document.createDocumentFragment();
  for (const fl of [...FL_LADDER].reverse()) {
    const row = document.createElement('div');
    row.className = 'rung';
    row.id = `rung-${fl}`;
    row.innerHTML = `
      <div class="rung-tape"><span class="rung-fill"></span></div>
      <div class="rung-fl"><span class="rung-fl-label">FL${String(fl).padStart(3, '0')}</span>
        <span class="rung-alt">${Math.round(flToMeters(fl) * 3.28084 / 100) * 100} ft</span></div>
      <div class="rung-main">
        <span class="rung-cat">—</span>
        <span class="rung-cloud"></span>
        <span class="rung-detail"></span>
      </div>
      <div class="rung-data">
        <span class="rung-shear" title="Vertical wind shear"></span>
        <span class="rung-ri" title="Richardson number"></span>
      </div>
      <span class="rung-where"></span>`;
    frag.appendChild(row);
  }
  els.ladder.appendChild(frag);
}

function renderLadder() {
  const rows = S.fetch.results;
  const highlightFl = currentHighlightFl();
  for (const fl of FL_LADDER) {
    const row = $(`rung-${fl}`);
    const r = rows?.find(x => x.ray.fl === fl);
    const fill = row.querySelector('.rung-fill');
    const cat = row.querySelector('.rung-cat');
    const cloudEl = row.querySelector('.rung-cloud');
    const detail = row.querySelector('.rung-detail');
    const shear = row.querySelector('.rung-shear');
    const ri = row.querySelector('.rung-ri');
    const where = row.querySelector('.rung-where');

    row.classList.toggle('aimed', fl === highlightFl);

    if (!r) {
      cat.textContent = '—'; cloudEl.textContent = ''; detail.textContent = ''; shear.textContent = ''; ri.textContent = ''; where.textContent = '';
      row.dataset.cat = 'none'; fill.style.background = 'transparent';
      continue;
    }
    if (r.belowObserver) {
      cat.textContent = 'Below you'; cloudEl.textContent = ''; detail.textContent = ''; shear.textContent = ''; ri.textContent = ''; where.textContent = '';
      row.dataset.cat = 'none'; fill.style.background = 'transparent';
      continue;
    }
    if (r.noData || !r.layer) {
      cat.textContent = 'No data'; cloudEl.textContent = ''; detail.textContent = '';
      shear.textContent = ''; ri.textContent = '';
      where.textContent = r.ray.shallowFlag ? 'too shallow' : '';
      row.dataset.cat = 'none'; fill.style.background = 'transparent';
      continue;
    }
    const felt = r.felt || r.cat;
    row.dataset.cat = felt.key;
    fill.style.background = felt.color;
    cat.textContent = felt.label;
    cloudEl.textContent = !r.cloud ? ''
      : r.cloud.okta === 'CLR' ? '☀ Clear'
      : `☁ ${r.cloud.okta} ${r.cloud.genus} · ${Math.round(r.cloud.coverPct)}%`;
    detail.textContent = `${r.cat.label} · est. EDR ${fmt.edr(r.edr)}`
      + (r.ti != null && r.tiCat ? ` · TI ${(r.ti * 1e7).toFixed(1)}` : '');
    shear.textContent = `${fmt.kt(r.layer.VWS_kt_kft)} kt/1000ft`;
    ri.textContent = `Ri ${fmt.ri(r.layer.Ri)}`;
    where.textContent = r.ray.overheadFlag
      ? 'overhead'
      : `${fmt.km(r.ray.groundDistKm)} km @ ${fmt.deg(effectiveBearing())}`
        + (r.ray.shallowFlag
          ? (S.aim.elevationDeg < 3 ? ' · pointing at the horizon — tilt up ↑' : ' · low confidence')
          : '');
  }
  els.emptyState.hidden = !!rows;
}

function currentHighlightFl() {
  // The FL band the aim passes through at a 30 km reference slant range.
  if (!S.observer) return null;
  const alt = (S.observer.altMeters || 0) + 30000 * Math.sin(S.aim.elevationDeg * Math.PI / 180);
  let best = null, bestD = Infinity;
  for (const fl of FL_LADDER) {
    const d = Math.abs(flToMeters(fl) - alt);
    if (d < bestD) { bestD = d; best = fl; }
  }
  return best;
}

let lastReadout = 0;
function renderReadouts(ts) {
  if (ts - lastReadout < 100) return; // ~10 Hz is plenty for numbers
  lastReadout = ts;

  // The #1 field-use trap: reading the screen aims the BACK of the phone at the
  // ground. Surface it the moment it happens, clear it when they tilt up.
  const belowHorizon = S.mode === 'sensors' && S.sensorState === SENSOR_STATES.LIVE && S.aim.elevationDeg < 3;
  if (belowHorizon !== S._tiltHintShown) {
    S._tiltHintShown = belowHorizon;
    const isTiltMsg = els.sensorMessage.textContent.startsWith('Tilt the phone');
    if (belowHorizon && (els.sensorMessage.hidden || isTiltMsg)) {
      els.sensorMessage.textContent = 'Tilt the phone up ↑ — the BACK of the phone is the pointer (hold it like photographing the sky). Right now you\'re aiming at the ground, so results are for air far away.';
      els.sensorMessage.hidden = false;
    } else if (!belowHorizon && isTiltMsg) {
      els.sensorMessage.textContent = '';
      els.sensorMessage.hidden = true;
    }
  }
  els.bearing.textContent = fmt.deg(effectiveBearing());
  els.elevation.textContent = fmt.deg(S.aim.elevationDeg);
  if (S.cameraOn) {
    els.reticleHud.textContent = `${fmt.deg(effectiveBearing())} · ${fmt.deg(S.aim.elevationDeg)} up`;
  }
  if (S.observer) {
    els.coords.textContent = `${fmt.coord(S.observer.lat)}, ${fmt.coord(S.observer.lon)}`;
    els.accuracy.textContent = S.observer.accuracy != null ? `±${Math.round(S.observer.accuracy)} m` : '';
    els.altitude.textContent = S.observer.assumedSeaLevel ? 'alt: sea level (assumed)' : `alt: ${Math.round(S.observer.altMeters * 3.28084)} ft`;
  } else {
    els.coords.textContent = 'no location';
    els.accuracy.textContent = '';
    els.altitude.textContent = '';
  }
  if (S.debug) renderDebug();
}

function renderStatus() {
  const st = S.sensorState;
  const badge = els.liveBadge;
  if (S.mode === 'manual') {
    badge.textContent = 'MANUAL';
    badge.dataset.state = 'manual';
  } else if (S.hold) {
    badge.textContent = 'HOLD';
    badge.dataset.state = 'hold';
  } else if (st === SENSOR_STATES.LIVE) {
    badge.textContent = 'LIVE';
    badge.dataset.state = 'live';
  } else if (st === SENSOR_STATES.STALE || st === SENSOR_STATES.STARTING) {
    badge.textContent = 'STALE';
    badge.dataset.state = 'stale';
  } else {
    badge.textContent = 'OFF';
    badge.dataset.state = 'off';
  }
  els.modelTime.textContent = S.fetch.modelTime;
  els.fetchState.textContent = S.fetch.inFlight ? 'updating…'
    : S.fetch.error ? (S.fetch.stale ? `stale — ${S.fetch.error}` : S.fetch.error)
    : '';
  els.fetchState.classList.toggle('error', !!S.fetch.error);
  els.ladder.classList.toggle('loading', S.fetch.inFlight && !S.fetch.results);
  els.sensorMessage.textContent = S.sensorMessage;
  els.sensorMessage.hidden = !S.sensorMessage;
  els.holdBtn.setAttribute('aria-pressed', String(S.hold));
  els.holdBtn.disabled = S.mode === 'manual';
}

function renderDebug() {
  const r = S.raw || {};
  els.debugPre.textContent = [
    `state: ${S.sensorState}  mode: ${S.mode}  hold: ${S.hold}`,
    `alpha: ${r.alpha?.toFixed?.(1) ?? '—'}  beta: ${r.beta?.toFixed?.(1) ?? '—'}  gamma: ${r.gamma?.toFixed?.(1) ?? '—'}`,
    `compass: ${r.compass?.toFixed?.(1) ?? '—'}  absolute: ${r.absolute ?? '—'}  screenAngle: ${r.screenAngle ?? '—'}`,
    `azimuthSource: ${S.aim.azimuthSource}  offset: ${S.calibrationOffset}`,
    `sensorEventAge: ${sensors ? Math.round(sensors.lastEventAgeMs()) : '—'} ms`,
    `fetch: inFlight=${S.fetch.inFlight} err="${S.fetch.error}" model=${S.fetch.modelTime}`,
    `secure: ${isSecure()}  webview: ${isLikelyWebview()}  orientationApi: ${orientationApiPresent()}`,
  ].join('\n');
}

function tickLoop(ts) {
  renderReadouts(ts);
  requestAnimationFrame(tickLoop);
}

// ---------------- Sensors wiring ----------------

let sensors = null;

function initSensors() {
  sensors = createSensorController({
    onAim(aim) {
      S.raw = aim.raw;
      if (S.hold || S.mode !== 'sensors') return;
      S.aim = { bearingDeg: aim.bearingDeg, elevationDeg: aim.elevationDeg, azimuthSource: aim.azimuthSource };
    },
    onState(state, message) {
      S.sensorState = state;
      S.sensorMessage = message || '';
      if (state === SENSOR_STATES.DENIED || state === SENSOR_STATES.UNAVAILABLE) {
        setMode('manual');
        els.manualPanel.open = true;
      }
      renderStatus();
    },
    onLocation(obs) {
      S.observer = { ...obs, source: 'gps' };
      S.locationMessage = '';
      els.locationMessage.textContent = '';
      els.latInput.value = obs.lat.toFixed(4);
      els.lonInput.value = obs.lon.toFixed(4);
      els.altInput.value = Math.round(obs.altMeters * 3.28084); // field is in feet
      runFetch(true);
    },
    onLocationError(msg) {
      S.locationMessage = msg;
      els.locationMessage.textContent = msg;
      els.manualPanel.open = true;
    },
  });
}

function setMode(mode) {
  S.mode = mode;
  document.body.dataset.mode = mode;
  renderStatus();
}

// ---------------- Camera background ----------------

let cameraStream = null;

async function toggleCamera() {
  if (S.cameraOn) {
    stopCamera();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    els.sensorMessage.textContent = 'Camera not available — using gradient sky.';
    els.sensorMessage.hidden = false;
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const track = cameraStream.getVideoTracks()[0];
    if (!track) throw new Error('no video track');
    track.onended = stopCamera; // pulled by a call, permission revoke, etc.
    els.cameraVideo.srcObject = cameraStream;
    await els.cameraVideo.play();
    S.cameraOn = true;
    document.body.classList.add('camera-on');
    els.sensorMessage.textContent = 'Camera on — the crosshair marks your aim point.';
    els.sensorMessage.hidden = false;
    scheduleDarkFeedCheck();
  } catch {
    stopCamera(); // release any half-acquired stream and reset UI state
    els.sensorMessage.textContent = 'Camera unavailable or denied — using gradient sky.';
    els.sensorMessage.hidden = false;
  }
  els.cameraBtn.setAttribute('aria-pressed', String(S.cameraOn));
}

function stopCamera() {
  if (cameraStream) for (const t of cameraStream.getTracks()) t.stop();
  cameraStream = null;
  S.cameraOn = false;
  if (darkCheckTimer) { clearInterval(darkCheckTimer); darkCheckTimer = null; }
  document.body.classList.remove('camera-on', 'camera-dark');
  els.cameraBtn.setAttribute('aria-pressed', 'false');
  if (els.sensorMessage.textContent.startsWith('Camera on')) {
    els.sensorMessage.hidden = true;
    els.sensorMessage.textContent = '';
  }
}

// Night must be first-class: when the camera feed is essentially black (night
// sky), bring the animated gradient sky back so aiming stays visual. Checked
// every few seconds so walking indoors/outdoors adapts both ways.
let darkCheckTimer = null;
const darkCheckCanvas = document.createElement('canvas');

function scheduleDarkFeedCheck() {
  if (darkCheckTimer) clearInterval(darkCheckTimer);
  darkCheckTimer = setInterval(() => {
    if (!S.cameraOn || !els.cameraVideo.videoWidth) return;
    try {
      darkCheckCanvas.width = 32; darkCheckCanvas.height = 24;
      const ctx = darkCheckCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(els.cameraVideo, 0, 0, 32, 24);
      const px = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const avg = sum / (px.length / 4);
      document.body.classList.toggle('camera-dark', avg < 14);
    } catch { /* canvas blocked → leave visuals as-is; aiming is unaffected */ }
  }, 3000);
}

// ---------------- Manual inputs ----------------

function readManualObserver() {
  const lat = parseFloat(els.latInput.value);
  const lon = parseFloat(els.lonInput.value);
  const altFt = parseFloat(els.altInput.value);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    els.locationMessage.textContent = 'Enter a latitude (−90…90) and longitude (−180…180).';
    return false;
  }
  const altM = Number.isFinite(altFt) ? altFt * 0.3048 : 0;
  S.observer = {
    lat, lon,
    altMeters: Math.max(-430, Math.min(9000, altM)),
    accuracy: null,
    assumedSeaLevel: !Number.isFinite(altFt) || altFt === 0,
    source: 'manual',
  };
  els.locationMessage.textContent = '';
  return true;
}

function applyManualAim() {
  S.aim = {
    bearingDeg: parseFloat(els.bearingSlider.value) || 0,
    elevationDeg: parseFloat(els.elevationSlider.value) || 0,
    azimuthSource: 'manual',
  };
}

// ---------------- Init ----------------

function wire() {
  for (const id of [
    'ladder', 'empty-state', 'bearing', 'elevation', 'coords', 'accuracy', 'altitude',
    'live-badge', 'model-time', 'fetch-state', 'sensor-message', 'location-message',
    'enable-btn', 'hold-btn', 'refresh-btn', 'camera-btn', 'manual-panel',
    'lat-input', 'lon-input', 'alt-input', 'bearing-slider', 'elevation-slider',
    'bearing-out', 'elevation-out', 'update-btn', 'locate-btn', 'offset-slider', 'offset-out',
    'detail-toggle', 'aircraft-group', 'debug-panel', 'debug-pre', 'camera-video',
    'reticle-hud',
  ]) {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    els[key] = $(id);
    if (!els[key]) throw new Error(`Missing element #${id}`);
  }

  buildLadder();

  // Aircraft class selector
  for (const cls of AIRCRAFT_CLASSES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.textContent = cls.label;
    b.dataset.key = cls.key;
    b.setAttribute('aria-pressed', String(cls.key === S.aircraftClass));
    b.addEventListener('click', () => {
      S.aircraftClass = cls.key;
      for (const other of els.aircraftGroup.querySelectorAll('.seg-btn')) {
        other.setAttribute('aria-pressed', String(other.dataset.key === cls.key));
      }
      if (S.fetch.results) {
        // Re-derive felt categories without refetching.
        for (const r of S.fetch.results) {
          if (r.edr != null) r.felt = feltCategory(r.edr, S.aircraftClass);
        }
        renderLadder();
      }
    });
    els.aircraftGroup.appendChild(b);
  }

  els.enableBtn.addEventListener('click', () => {
    // Must stay synchronous into enable() for the iOS gesture requirement.
    setMode('sensors');
    sensors.enable();
    sensors.requestLocation();
  });

  els.holdBtn.addEventListener('click', () => {
    S.hold = !S.hold;
    renderStatus();
    if (S.hold) runFetch(true);
  });

  els.refreshBtn.addEventListener('click', () => {
    if (S.mode === 'sensors') sensors.requestLocation();
    runFetch(true);
  });

  els.cameraBtn.addEventListener('click', toggleCamera);

  els.offsetSlider.addEventListener('input', () => {
    S.calibrationOffset = parseFloat(els.offsetSlider.value) || 0;
    els.offsetOut.textContent = `${S.calibrationOffset > 0 ? '+' : ''}${S.calibrationOffset}°`;
  });

  els.detailToggle.addEventListener('change', () => {
    S.highDetail = els.detailToggle.checked;
    runFetch(true);
  });

  const syncSliderOuts = () => {
    els.bearingOut.textContent = `${els.bearingSlider.value}°`;
    els.elevationOut.textContent = `${els.elevationSlider.value}°`;
  };
  for (const slider of [els.bearingSlider, els.elevationSlider]) {
    slider.addEventListener('input', () => {
      syncSliderOuts();
      if (S.mode === 'manual') applyManualAim();
    });
  }
  syncSliderOuts();

  els.updateBtn.addEventListener('click', () => {
    setMode('manual');
    applyManualAim();
    if (readManualObserver()) runFetch(true);
  });

  els.locateBtn.addEventListener('click', () => sensors.requestLocation());

  els.debugPanel.hidden = !S.debug;

  // Capability-aware default: no sensors → manual mode, panel open.
  // (Enable stays clickable — enable() itself explains exactly what's missing.)
  if (!orientationApiPresent() || !isSecure()) {
    setMode('manual');
    els.manualPanel.open = true;
    if (!isSecure()) {
      S.sensorMessage = 'Sensors need HTTPS — manual mode only.';
    } else {
      S.sensorMessage = 'No motion sensors detected — manual mode.';
    }
    renderStatus();
  } else {
    setMode('manual'); // manual until the user taps Enable
    // The #1 first-run confusion: pointing the phone does nothing until sensors
    // are enabled. Say so up front; enable() clears this message on state change.
    S.sensorMessage = 'Pointing does nothing yet — tap "Enable sensors" to aim with your phone.';
    renderStatus();
  }
  if (isLikelyWebview()) {
    S.sensorMessage = 'In-app browser detected — if sensors fail, open this page in Safari or Chrome.';
    renderStatus();
  }

  // Hide the AR reticle when scrolled down to the controls (it marks screen
  // center for aiming and is meaningless over buttons).
  window.addEventListener('scroll', () => {
    document.body.classList.toggle('scrolled', window.scrollY > 120);
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Release the camera when backgrounded — iOS kills backgrounded streams
      // anyway, and holding one drains battery and keeps the in-use light on.
      if (S.cameraOn) stopCamera();
    } else if (S.mode === 'sensors' && sensors.locationAgeMs() > REFETCH_AGE_MS) {
      sensors.requestLocation();
    }
  });

  // Fetch policy tick: HOLD/manual changes fetch immediately elsewhere; this
  // catches aim drift (>5°/2°) and the 60 s refresh.
  setInterval(() => { runFetch(false); }, 1000);

  requestAnimationFrame(tickLoop);
  renderStatus();
  renderLadder();
}

function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* PWA is optional; app works without */ });
    // After a deploy, the new worker takes control (skipWaiting+claim) — reload
    // once so this long-lived tab actually runs the new modules.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || !navigator.serviceWorker.controller) return;
      reloaded = true;
      // Don't yank the page out from under an active aim session.
      if (document.visibilityState === 'visible' && S.mode === 'sensors') return;
      location.reload();
    });
  }
}

try {
  initSensors();
  wire();
  registerSW();
} catch (e) {
  window.__ssError?.(`Startup failed: ${e.message}`);
  throw e;
}
