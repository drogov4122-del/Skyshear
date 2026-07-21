// globe.js — dependency-free orthographic 3D globe on <canvas>.
// Drag to spin (with inertia), gentle auto-rotation when idle, route arc
// colored per-segment by forecast severity, atmosphere rim glow.

import { latLonToWorldPx } from './radar.js';

const D2R = Math.PI / 180;

export function createGlobe(canvas, { landPolys }) {
  const ctx = canvas.getContext('2d');
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  let size = 0, cx = 0, cy = 0, R = 0;

  // View rotation: lon0/lat0 = center of view.
  let lon0 = -30, lat0 = 30;
  let targetLon = lon0, targetLat = lat0;
  let dragging = false, lastX = 0, lastY = 0, vLon = 0, vLat = 0;
  let lastInteraction = 0;
  let route = null; // { segs: [{a:{lat,lon}, b:{lat,lon}, color}], origin, dest, originLabel, destLabel }
  let rafId = null, running = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    size = Math.min(canvas.width, canvas.height);
    cx = canvas.width / 2;
    cy = canvas.height / 2;
    R = size * 0.44;
  }

  // Orthographic projection. Returns null when on the far hemisphere.
  function project(lat, lon) {
    const φ = lat * D2R, λ = (lon - lon0) * D2R, φ0 = lat0 * D2R;
    const cosc = Math.sin(φ0) * Math.sin(φ) + Math.cos(φ0) * Math.cos(φ) * Math.cos(λ);
    if (cosc < -0.02) return null; // slight tolerance avoids seam popping
    return {
      x: cx + R * Math.cos(φ) * Math.sin(λ),
      y: cy - R * (Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * Math.cos(φ) * Math.cos(λ)),
      front: cosc >= 0,
    };
  }

  function drawPolyline(points, close) {
    let started = false;
    ctx.beginPath();
    let prev = null;
    for (const [lon, lat] of points) {
      const p = project(lat, lon);
      if (!p) { prev = null; started = started && true; continue; }
      if (!prev) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
      prev = p;
    }
    if (close && started) ctx.closePath();
  }

  function draw(ts) {
    if (!size) resize();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Sphere: deep-atmosphere radial gradient + rim glow
    const grad = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    grad.addColorStop(0, '#1E3A5F');
    grad.addColorStop(0.65, '#132A4A');
    grad.addColorStop(1, '#0A0E1A');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Atmosphere glow
    const glow = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.12);
    glow.addColorStop(0, 'rgba(63, 224, 197, 0.16)');
    glow.addColorStop(1, 'rgba(63, 224, 197, 0)');
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    // Graticule
    ctx.lineWidth = Math.max(1, dpr * 0.5);
    ctx.strokeStyle = 'rgba(143, 163, 191, 0.14)';
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 4) pts.push([lon, lat]);
      drawPolyline(pts);
      ctx.stroke();
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -85; lat <= 85; lat += 4) pts.push([lon, lat]);
      drawPolyline(pts);
      ctx.stroke();
    }

    // Land
    ctx.fillStyle = 'rgba(63, 100, 150, 0.42)';
    ctx.strokeStyle = 'rgba(168, 194, 228, 0.35)';
    ctx.lineWidth = Math.max(1, dpr * 0.6);
    for (const poly of landPolys) {
      drawPolyline(poly, true);
      ctx.fill();
      ctx.stroke();
    }

    // Live precipitation radar over the land, under the night shading
    drawRadar();

    // Night side + dusk band (sun position at the flight's departure time)
    drawNight();

    // Route arc, per-segment severity colors with glow
    if (route) {
      ctx.lineCap = 'round';
      for (const seg of route.segs) {
        const pa = project(seg.a.lat, seg.a.lon);
        const pb = project(seg.b.lat, seg.b.lon);
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.strokeStyle = seg.color;
        ctx.lineWidth = dpr * 3.4;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.lineWidth = dpr * 1.8;
        ctx.globalAlpha = 1;
        ctx.stroke();
      }
      drawEndpoint(route.origin, route.originLabel);
      drawEndpoint(route.dest, route.destLabel);
      drawSunMarkers();
    }

    // Drag inertia only — no idle auto-rotation: the globe stays framed on the
    // route so the radar layer renders sharp and steady (drag-to-spin remains).
    if (!dragging) {
      if (Math.abs(vLon) > 0.005 || Math.abs(vLat) > 0.005) {
        targetLon += vLon; targetLat += vLat;
        vLon *= 0.95; vLat *= 0.95;
      }
    }
    lon0 += (targetLon - lon0) * 0.2;
    lat0 += (targetLat - lat0) * 0.2;
    lat0 = Math.max(-85, Math.min(85, lat0));
    targetLat = Math.max(-85, Math.min(85, targetLat));

    if (running) rafId = requestAnimationFrame(draw);
  }

  function drawEndpoint(pt, label) {
    const p = project(pt.lat, pt.lon);
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dpr * 4, 0, Math.PI * 2);
    ctx.fillStyle = '#E8EEF7';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, dpr * 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(232, 238, 247, 0.5)';
    ctx.lineWidth = dpr;
    ctx.stroke();
    if (label) {
      ctx.font = `600 ${11 * dpr}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = '#E8EEF7';
      ctx.textAlign = 'center';
      ctx.fillText(label, p.x, p.y - dpr * 12);
    }
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ---- Pointer interaction ----
  let activePointerId = null; // track one pointer; a second finger must not jitter the drag
  function onDown(e) {
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    vLon = 0; vLat = 0;
    lastInteraction = performance.now();
    canvas.setPointerCapture?.(e.pointerId);
  }
  function onMove(e) {
    if (!dragging || e.pointerId !== activePointerId) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    const degPerPx = 0.35;
    vLon = -dx * degPerPx;
    vLat = dy * degPerPx;
    targetLon += vLon;
    targetLat += vLat;
    lastInteraction = performance.now();
  }
  function onUp(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    dragging = false;
    lastInteraction = performance.now();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.style.touchAction = 'none';

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stop();
    else start();
  });

  function start() {
    if (running) return;
    running = true;
    resize();
    rafId = requestAnimationFrame(draw);
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /**
   * rows: evaluateRoute() output. Builds severity-colored segments and frames
   * the view on the route midpoint.
   */
  // ---- Live precipitation radar (RainViewer world mercator, reprojected) ----
  let radarWorld = null; // { data: ImageData, timeMs }
  let radarOn = true;
  const radarCanvas = document.createElement('canvas');
  let radarKey = '';

  function setRadar(world) { radarWorld = world; radarKey = ''; }
  function toggleRadar(on) { radarOn = !!on; }

  function drawRadar() {
    if (!radarWorld || !radarOn) return;
    const key = `${lon0.toFixed(1)}|${lat0.toFixed(1)}|${radarWorld.timeMs}|${canvas.width}`;
    if (key !== radarKey) {
      radarKey = key;
      const d2 = Math.PI / 180;
      const φ0 = lat0 * d2, λ0v = lon0 * d2;
      const sinφ0 = Math.sin(φ0), cosφ0 = Math.cos(φ0);
      const src = radarWorld.data.data;
      const SW = radarWorld.data.width;
      const scale = 2; // finer grid — affordable now the idle view is static
      const w = Math.max(2, Math.round(canvas.width / scale));
      const h = Math.max(2, Math.round(canvas.height / scale));
      radarCanvas.width = w; radarCanvas.height = h;
      const rctx = radarCanvas.getContext('2d');
      const img = rctx.createImageData(w, h);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const X = (px * scale - cx) / R, Y = (cy - py * scale) / R;
          const r2 = X * X + Y * Y;
          if (r2 > 1) continue;
          const Z = Math.sqrt(1 - r2);
          // Inverse orthographic → lat/lon
          const sinφ = Y * cosφ0 + Z * sinφ0;
          const φ = Math.asin(Math.max(-1, Math.min(1, sinφ)));
          const λ = λ0v + Math.atan2(X, Z * cosφ0 - Y * sinφ0);
          const lat = φ / d2;
          const lon = ((λ / d2 + 540) % 360) - 180;
          const wp = latLonToWorldPx(lat, lon, SW);
          // Bilinear sample of the 4 surrounding world pixels — smooth blobs.
          const x0 = wp.x | 0, y0 = wp.y | 0;
          const x1 = Math.min(SW - 1, x0 + 1), y1 = Math.min(SW - 1, y0 + 1);
          const fx = wp.x - x0, fy = wp.y - y0;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          const i00 = (y0 * SW + x0) * 4, i10 = (y0 * SW + x1) * 4, i01 = (y1 * SW + x0) * 4, i11 = (y1 * SW + x1) * 4;
          const a = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
          if (a < 8) continue;
          const i = (py * w + px) * 4;
          img.data[i] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
          img.data[i + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
          img.data[i + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
          img.data[i + 3] = Math.min(220, a * 0.95);
        }
      }
      rctx.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(radarCanvas, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // ---- Day/night terminator with dusk band ----
  let refTimeMs = null; // departure time when a route is set; else "now" at start()
  let sunMarkers = [];  // sunrise/sunset crossings along the route

  function subsolar(ms) {
    const d = new Date(ms);
    const N = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
    const decl = -23.44 * Math.cos(2 * Math.PI * (N + 10) / 365.24);
    const B = 2 * Math.PI * (N - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
    const hours = d.getUTCHours() + d.getUTCMinutes() / 60;
    let lon = -15 * (hours - 12 + eot / 60);
    lon = ((lon + 540) % 360) - 180;
    return { lat: decl, lon };
  }

  function sunElev(lat, lon, ms) {
    const s = subsolar(ms);
    const d2 = Math.PI / 180;
    return Math.sin(lat * d2) * Math.sin(s.lat * d2) +
      Math.cos(lat * d2) * Math.cos(s.lat * d2) * Math.cos((lon - s.lon) * d2);
  }

  const nightCanvas = document.createElement('canvas');
  let nightKey = '';

  function drawNight() {
    const ms = refTimeMs || Date.now();
    const key = `${lon0.toFixed(1)}|${lat0.toFixed(1)}|${Math.floor(ms / 60000)}|${canvas.width}`;
    if (key !== nightKey) {
      nightKey = key;
      const s = subsolar(ms);
      const d2 = Math.PI / 180;
      const φ0 = lat0 * d2, λ0v = lon0 * d2;
      const φs = s.lat * d2, λ = (s.lon * d2) - λ0v;
      const sx = Math.cos(φs) * Math.sin(λ);
      const sy = Math.cos(φ0) * Math.sin(φs) - Math.sin(φ0) * Math.cos(φs) * Math.cos(λ);
      const sz = Math.sin(φ0) * Math.sin(φs) + Math.cos(φ0) * Math.cos(φs) * Math.cos(λ);
      const scale = 4;
      const w = Math.max(2, Math.round(canvas.width / scale));
      const h = Math.max(2, Math.round(canvas.height / scale));
      nightCanvas.width = w; nightCanvas.height = h;
      const nctx = nightCanvas.getContext('2d');
      const img = nctx.createImageData(w, h);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const X = (px * scale - cx) / R, Y = (cy - py * scale) / R;
          const r2 = X * X + Y * Y;
          if (r2 > 1) continue;
          const Z = Math.sqrt(1 - r2);
          const dot = X * sx + Y * sy + Z * sz; // sun elevation sine at this pixel
          let a = 0, warm = 0;
          if (dot < -0.12) a = 0.52;
          else if (dot < 0.05) { a = 0.52 * (0.05 - dot) / 0.17; warm = Math.max(0, 1 - Math.abs(dot) / 0.06); }
          if (a <= 0 && warm <= 0) continue;
          const i = (py * w + px) * 4;
          img.data[i] = 6 + warm * 120; img.data[i + 1] = 9 + warm * 45; img.data[i + 2] = 22;
          img.data[i + 3] = Math.min(255, (a + warm * 0.10) * 255);
        }
      }
      nctx.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(nightCanvas, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function drawSunMarkers() {
    ctx.font = `${Math.round(dpr * 13)}px system-ui`;
    ctx.textAlign = 'center';
    for (const m of sunMarkers) {
      const p = project(m.lat, m.lon);
      if (!p || !p.front) continue;
      ctx.fillStyle = m.type === 'sunset' ? '#F2C94C' : '#FFE9A8';
      ctx.fillText(m.type === 'sunset' ? '☾' : '☀', p.x, p.y - dpr * 8);
    }
  }

  /** Sunrise/sunset crossings along the flight, from per-point times. */
  function setTimes(departureMs, rows) {
    refTimeMs = departureMs || null;
    sunMarkers = [];
    nightKey = '';
    if (!departureMs || !rows) return;
    let prev = null;
    for (const r of rows) {
      const pt = r.point;
      const e = sunElev(pt.lat, pt.lon, departureMs + pt.tMin * 60000);
      if (prev && (prev.e < 0) !== (e < 0)) {
        sunMarkers.push({ lat: pt.lat, lon: pt.lon, type: e < 0 ? 'sunset' : 'sunrise' });
      }
      prev = { e };
    }
  }

  function setRoute(rows, originLabel, destLabel) {
    const valid = rows.filter(r => !r.noData);
    const pts = rows.map(r => r.point);
    if (pts.length < 2) { route = null; return; }
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const row = rows[i];
      const color = (!row.noData && row.felt) ? row.felt.color : 'rgba(200, 214, 235, 0.8)';
      segs.push({ a: pts[i], b: pts[i + 1], color });
    }
    route = {
      segs,
      origin: pts[0],
      dest: pts[pts.length - 1],
      originLabel, destLabel,
    };
    const mid = valid[Math.floor(valid.length / 2)]?.point || pts[Math.floor(pts.length / 2)];
    targetLon = mid.lon;
    targetLat = Math.max(-60, Math.min(60, mid.lat));
    lastInteraction = performance.now();
  }

  return { start, stop, setRoute, setTimes, setRadar, toggleRadar, resize };
}
