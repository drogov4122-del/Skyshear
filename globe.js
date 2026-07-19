// globe.js — dependency-free orthographic 3D globe on <canvas>.
// Drag to spin (with inertia), gentle auto-rotation when idle, route arc
// colored per-segment by forecast severity, atmosphere rim glow.

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
    }

    // Idle auto-rotation + inertia
    const idle = ts - lastInteraction > 3500;
    if (!dragging) {
      if (Math.abs(vLon) > 0.005 || Math.abs(vLat) > 0.005) {
        targetLon += vLon; targetLat += vLat;
        vLon *= 0.95; vLat *= 0.95;
      } else if (idle && !prefersReducedMotion()) {
        targetLon += 0.03;
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

  return { start, stop, setRoute, resize };
}
