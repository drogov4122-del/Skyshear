// Validation harness: score SkyShear's forecast turbulence categories against
// REAL pilot reports (PIREPs) from NOAA aviationweather.gov.
// For each PIREP with a turbulence intensity: fetch Open-Meteo at that exact
// lat/lon, compute our category at the reported flight level and hour, and
// compare. Reports agreement stats. Run: node validate_pireps.mjs
import {
  buildForecastUrl, parseProfile, layerAt, categorize, pseudoEdr, feltCategory,
  nearestHourIndex, isoHourUTC,
} from './turbulence.js';

// PIREP intensity → comparable rank on our 0–4 scale.
// NEG=0 · LGT=1 · LGT-MOD=2 · MOD=3 · MOD-SEV/SEV=4  (CAT/CHOP types only)
const PIREP_RANK = { 'NEG': 0, 'SMTH-LGT': 1, 'LGT': 1, 'LGT-MOD': 2, 'MOD': 3, 'MOD-SEV': 4, 'SEV': 4, 'EXTRM': 4 };

// Three busy boxes: Midwest, East, West CONUS
const BBOXES = ['35,-105,45,-85', '30,-85,45,-70', '30,-125,49,-105'];

const pireps = [];
for (const bbox of BBOXES) {
  const res = await fetch(`https://aviationweather.gov/api/data/pirep?bbox=${bbox}&format=json&age=6`);
  const arr = await res.json();
  for (const p of arr) {
    const rank = PIREP_RANK[p.tbInt1];
    if (rank === undefined) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.fltLvl)) continue;
    if (p.fltLvl < 50 || p.fltLvl > 450) continue; // within our ladder
    pireps.push({ lat: p.lat, lon: p.lon, fl: p.fltLvl, rank, int: p.tbInt1, t: p.obsTime * 1000, ac: p.acType });
  }
}
console.log(`usable turbulence PIREPs: ${pireps.length}`);
const sample = pireps.slice(0, 45); // cap API load

// Batch per 15 points (same chunking as the app)
const results = [];
for (let i = 0; i < sample.length; i += 15) {
  const chunk = sample.slice(i, i + 15);
  const t0 = Math.min(...chunk.map(p => p.t));
  const t1 = Math.max(...chunk.map(p => p.t));
  const url = buildForecastUrl(chunk.map(p => ({ lat: p.lat, lon: p.lon })), {
    startHour: isoHourUTC(t0), endHour: isoHourUTC(t1 + 3600000),
  });
  const res = await fetch(url);
  const body = await res.json();
  if (body?.error) { console.log('open-meteo error:', body.reason); continue; }
  const arr = Array.isArray(body) ? body : [body];
  chunk.forEach((p, j) => {
    const hourly = arr[j]?.hourly;
    if (!hourly?.time?.length) return;
    const idx = nearestHourIndex(hourly.time, p.t);
    const profile = parseProfile(hourly, idx, 0);
    const layer = layerAt(profile, p.fl * 100 * 0.3048);
    if (!layer) return;
    const edr = pseudoEdr(layer.Ri, layer.VWS_kt_kft);
    const felt = feltCategory(edr, 'heavy'); // most PIREPs are airliners
    const cat = categorize(layer.Ri, layer.VWS_kt_kft);
    results.push({ ...p, ourFeltRank: felt?.rank ?? 0, ourCatRank: cat?.rank ?? 0, edr, ri: layer.Ri, vws: layer.VWS_kt_kft });
  });
}

console.log(`scored: ${results.length}`);
let exact = 0, within1 = 0, missedEvent = 0, falseAlarmHard = 0;
for (const r of results) {
  // Compare against the ATMOSPHERIC category (cat) — PIREP intensity is what
  // the atmosphere did; felt-per-aircraft is a display layer.
  const d = r.ourCatRank - r.rank;
  if (d === 0) exact++;
  if (Math.abs(d) <= 1) within1++;
  if (r.rank >= 3 && r.ourCatRank === 0) missedEvent++;      // pilot reported MOD+, we said smooth
  if (r.rank === 0 && r.ourCatRank >= 3) falseAlarmHard++;   // pilot reported smooth, we said moderate+
}
console.log(`exact class match:      ${exact}/${results.length} (${(100 * exact / results.length).toFixed(0)}%)`);
console.log(`within one class:       ${within1}/${results.length} (${(100 * within1 / results.length).toFixed(0)}%)`);
console.log(`missed MOD+ events:     ${missedEvent}`);
console.log(`hard false alarms:      ${falseAlarmHard}`);
console.log('\nsample rows (pirep vs ours):');
for (const r of results.slice(0, 12)) {
  console.log(`  FL${String(r.fl).padStart(3, '0')} ${String(r.int).padEnd(8)} vs ourRank ${r.ourCatRank} (Ri ${r.ri.toFixed(1)}, shear ${r.vws.toFixed(1)} kt/kft) ${r.ac || ''}`);
}