// profilechart.js — SVG turbulence profile: hours-into-flight on x, the flight's
// altitude silhouette filled per-segment with the felt-severity color.
// One chart, one message: "when in my flight do I get bounced, and how much."

const NS = 'http://www.w3.org/2000/svg';
const W = 860, H = 280;
const M = { top: 34, right: 16, bottom: 44, left: 46 };
const SMOOTH_COLOR = '#3FE0C5';

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Render the chart into `container` (replaces previous).
 * rows: evaluateRoute() output. meta: { durationMin, cruiseFt, departureMs, originIata, destIata }.
 * worst: worstSegments() output for annotations.
 */
export function renderProfileChart(container, rows, meta, worst = []) {
  container.textContent = '';
  const valid = rows.filter(r => !r.noData);
  if (!valid.length) {
    container.textContent = 'No forecast data for this route.';
    return;
  }

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Turbulence profile ${meta.originIata} to ${meta.destIata}: ` +
      (worst.length ? worst.map(s => `${s.label} around ${Math.round(s.fromMin)} minutes in`).join('; ')
                    : 'mostly smooth conditions forecast'),
  });
  svg.classList.add('profile-svg');

  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = t => M.left + (t / meta.durationMin) * plotW;
  const maxAlt = meta.cruiseFt * 1.08;
  const y = altFt => M.top + plotH - (altFt / maxAlt) * plotH;
  const y0 = M.top + plotH;

  // Altitude grid: 10k-ft lines
  for (let a = 10000; a < maxAlt; a += 10000) {
    el('line', { x1: M.left, x2: W - M.right, y1: y(a), y2: y(a), class: 'pc-grid' }, svg);
    el('text', { x: M.left - 6, y: y(a) + 3, class: 'pc-ylabel', 'text-anchor': 'end' }, svg)
      .textContent = `${a / 1000}k`;
  }
  el('text', { x: M.left - 6, y: M.top - 12, class: 'pc-ylabel', 'text-anchor': 'end' }, svg).textContent = 'ft';

  // Severity-filled altitude silhouette: one trapezoid per adjacent pair.
  for (let i = 0; i < valid.length - 1; i++) {
    const a = valid[i], b = valid[i + 1];
    const color = (a.felt && a.felt.rank > 0) ? a.felt.color : SMOOTH_COLOR;
    const opacity = (a.felt && a.felt.rank > 0) ? 0.85 : 0.35;
    el('polygon', {
      points: `${x(a.point.tMin)},${y(a.point.altFt)} ${x(b.point.tMin)},${y(b.point.altFt)} ` +
              `${x(b.point.tMin)},${y0} ${x(a.point.tMin)},${y0}`,
      fill: color, 'fill-opacity': opacity, stroke: 'none',
    }, svg);
  }
  // Silhouette top line
  el('polyline', {
    points: valid.map(r => `${x(r.point.tMin)},${y(r.point.altFt)}`).join(' '),
    class: 'pc-altline',
  }, svg);

  // No-data (ground-roll) hatch at the very ends is implicit — silhouette starts at first valid row.

  // X axis: hour ticks with clock times
  const stepMin = meta.durationMin <= 90 ? 15 : meta.durationMin <= 240 ? 30 : 60;
  for (let t = 0; t <= meta.durationMin + 0.01; t += stepMin) {
    const tx = x(Math.min(t, meta.durationMin));
    el('line', { x1: tx, x2: tx, y1: y0, y2: y0 + 5, class: 'pc-tick' }, svg);
    // Skip the text labels on a final tick that would collide with the
    // destination IATA label drawn at the right edge.
    if (t > 0 && meta.durationMin - t < stepMin / 4) continue;
    const label = el('text', { x: tx, y: y0 + 18, class: 'pc-xlabel', 'text-anchor': 'middle' }, svg);
    label.textContent = t === 0 ? meta.originIata : `+${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    if (meta.departureMs) {
      el('text', { x: tx, y: y0 + 32, class: 'pc-xclock', 'text-anchor': 'middle' }, svg)
        .textContent = fmtClock(meta.departureMs + t * 60000);
    }
  }
  const endX = x(meta.durationMin);
  el('text', { x: endX, y: y0 + 18, class: 'pc-xlabel pc-dest', 'text-anchor': 'middle' }, svg)
    .textContent = meta.destIata;

  // Worst-segment annotations above the band
  for (const s of worst) {
    const cx = x((s.fromMin + s.toMin) / 2);
    el('line', { x1: x(s.fromMin), x2: x(s.toMin), y1: M.top - 14, y2: M.top - 14, stroke: s.color, 'stroke-width': 3, 'stroke-linecap': 'round' }, svg);
    const t = el('text', { x: cx, y: M.top - 20, class: 'pc-annot', 'text-anchor': 'middle', fill: s.color }, svg);
    t.textContent = `${s.label.replace(' potential', '')} ${fmtHM(s.fromMin)}–${fmtHM(s.toMin)}`;
  }

  container.appendChild(svg);
}

function fmtHM(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
