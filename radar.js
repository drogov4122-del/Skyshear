// radar.js — live precipitation radar for the globe, from RainViewer
// (free, keyless, CORS-enabled; global composite updated ~every 10 minutes).
// The world is fetched as 4 web-mercator tiles (zoom 1, 512 px) into a single
// 1024×1024 image the globe reprojects per-pixel. Color scheme 4 = the
// classic green→yellow→red radar ramp (FlightRadar24-style).

const INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const WORLD_SIZE = 1024;
const COLOR_SCHEME = 4;   // TWC-style green/yellow/red
const OPTIONS = '1_1';    // smoothed, snow shown

/** Pure: lat/lon → pixel in the zoom-1 web-mercator world (0..size). */
export function latLonToWorldPx(latDeg, lonDeg, size = WORLD_SIZE) {
  const lat = Math.max(-85.05, Math.min(85.05, latDeg));
  const x = ((lonDeg + 180) / 360) * size;
  const rad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2 * size;
  return { x: Math.min(size - 1, Math.max(0, x)), y: Math.min(size - 1, Math.max(0, y)) };
}

function loadTile(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile failed'));
    img.src = url;
  });
}

/**
 * Fetch the latest radar frame as world ImageData.
 * Resolves { data: ImageData, timeMs, attribution } or throws (caller treats
 * radar as strictly optional — the globe renders fine without it).
 */
export async function loadRadarWorld() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let index;
  try {
    const res = await fetch(INDEX_URL, { signal: ctrl.signal });
    index = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const past = index?.radar?.past;
  if (!index?.host || !past?.length) throw new Error('no radar frames');
  const frame = past[past.length - 1];

  const canvas = document.createElement('canvas');
  canvas.width = WORLD_SIZE;
  canvas.height = WORLD_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      const url = `${index.host}${frame.path}/512/1/${x}/${y}/${COLOR_SCHEME}/${OPTIONS}.png`;
      jobs.push(loadTile(url).then(img => ctx.drawImage(img, x * 512, y * 512)));
    }
  }
  await Promise.all(jobs);
  return {
    data: ctx.getImageData(0, 0, WORLD_SIZE, WORLD_SIZE),
    timeMs: (frame.time || 0) * 1000,
    attribution: 'Radar © RainViewer',
  };
}
