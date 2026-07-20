// icons.js — tiny inline-SVG glyph set (no external assets, works offline).
// Each returns an SVG string sized 1em, colored via currentColor.

const svg = (inner, vb = '0 0 24 24') =>
  `<svg class="ss-icon" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  // Fasten-seatbelt sign: person torso + lap belt
  seatbelt: svg(
    '<circle cx="12" cy="5.5" r="2.6"/>' +
    '<path d="M7.5 21v-5.5a4.5 4.5 0 0 1 9 0V21"/>' +
    '<path d="M5.5 15.5 L18.5 18.5" stroke-width="2.6"/>'
  ),
  // Storm: cloud with lightning bolt
  storm: svg(
    '<path d="M6.5 14a4 4 0 1 1 .6-7.96A5 5 0 0 1 16.8 7.2 3.5 3.5 0 0 1 17 14z"/>' +
    '<path d="M12.5 14.5 10 18.5h3l-2 4" fill="currentColor" stroke-width="1.4"/>'
  ),
  // Jet stream: three flowing wind lines
  jet: svg(
    '<path d="M3 8h11a2.4 2.4 0 1 0-2.2-3.4"/>' +
    '<path d="M3 13h15a2.4 2.4 0 1 1-2.2 3.4"/>' +
    '<path d="M3 18h8"/>'
  ),
  // Layer shear: two offset layers sliding
  shear: svg(
    '<path d="M4 9h12"/><path d="M8 15h12"/>' +
    '<path d="M13 6.5 16 9l-3 2.5" fill="none"/><path d="M11 12.5 8 15l3 2.5" fill="none"/>'
  ),
  // Low-level / thermals: rising wavy air
  thermal: svg(
    '<path d="M7 20c0-3 3-3 3-6s-3-3-3-6"/><path d="M13 20c0-3 3-3 3-6s-3-3-3-6"/>'
  ),
  // Smooth: gentle horizon sun
  smooth: svg(
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5"/>'
  ),
  cloud: svg('<path d="M6.5 17a4 4 0 1 1 .6-7.96A5 5 0 0 1 16.8 10.2 3.5 3.5 0 0 1 17 17z"/>'),
};

/** Icon for a turbulence cause key ('storm'|'jet'|'shear'|'lowlevel'|'thermal') or severity fallback. */
export function causeIcon(causeKey, feltRank = 0) {
  if (causeKey === 'storm') return ICONS.storm;
  if (causeKey === 'jet') return ICONS.jet;
  if (causeKey === 'shear') return ICONS.shear;
  if (causeKey === 'lowlevel' || causeKey === 'thermal') return ICONS.thermal;
  return feltRank >= 3 ? ICONS.seatbelt : ICONS.smooth;
}

/** Severity badge icon: seatbelt sign from Light–Moderate up (airlines light it for chop). */
export function severityIcon(feltRank) {
  return feltRank >= 2 ? ICONS.seatbelt : feltRank >= 1 ? ICONS.cloud : ICONS.smooth;
}
