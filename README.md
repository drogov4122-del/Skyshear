# SkyShear — point-at-the-sky turbulence finder

Point your phone at the sky. Using your GPS position and the phone's orientation
sensors, SkyShear projects your line of sight through the atmosphere and shows
**forecast turbulence potential** at nine flight levels (FL050–FL450) along that
direction — vertical wind shear, Richardson number, and an aircraft-adjusted
severity for light aircraft, regional jets, and commercial jets.

**Plain-English disclaimer:** SkyShear is not an aviation weather product and
must never be used for flight decisions. It looks up *model forecast* data
(NOAA GFS via Open-Meteo, grid ~13–25 km, hourly) and derives turbulence
*potential* along your pointing direction. It does not — and physically cannot —
measure the actual air you are looking at. All EDR values are estimates, not
measurements.

Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0, free for
non-commercial use, no API key).

## Run it locally (one command)

```
cd site
python -m http.server 8080
```

Open http://localhost:8080 — the app is fully usable on desktop in **manual
mode** (enter coordinates, set bearing/elevation sliders, press *Update
forecast*). Phone sensors require HTTPS, so sensor mode only works on the
deployed site.

Run the unit tests (Node 18+, zero dependencies):

```
node --test test/geometry.test.js test/turbulence.test.js
```

## Deploy to GitHub Pages

1. Create a **public** repo at https://github.com/new (e.g. `skyshear`), no README.
2. In `site/`:
   ```
   git init -b main
   git add -A
   git commit -m "SkyShear v1"
   git remote add origin https://github.com/drogov4122-del/Skyshear.git
   git push -u origin main
   ```
3. Repo → **Settings → Pages → Source: Deploy from a branch → `main` / root → Save**.
4. Site is live at `https://drogov4122-del.github.io/Skyshear/` in ~1–2 minutes.
   Every later `git push` redeploys automatically.

## Using the app on a phone

1. Open the GitHub Pages URL in **Safari (iOS)** or **Chrome (Android)** — not
   inside Instagram/Facebook in-app browsers (they block motion sensors; the
   app will tell you and fall back to manual mode).
2. Tap **Enable sensors**, allow *Motion & Orientation* and *Location*.
3. Point the back of the phone at the sky. The ladder fills with turbulence
   potential per flight level; the level your aim passes through (at a 30 km
   reference range) is highlighted.
4. **HOLD** freezes the aim so you can read the ladder; it also triggers a
   fresh forecast fetch.
5. Compare against a compass app once, and use the **Compass calibration**
   slider to zero out any azimuth offset (Android absolute orientation is
   magnetic-north referenced; the slider also covers magnetic declination).
6. **Camera** overlays the live camera with a reticle for an AR feel (optional).
7. **High detail** adds the Ellrod TI clear-air-turbulence index (fetches 5×
   the data points — still free, but slower).
8. Aircraft buttons switch the severity thresholds: the same air that is
   *Moderate* for a light aircraft can be *Light* for a commercial jet
   (ICAO-style EDR bands per weight class).

Troubleshooting: add `?debug=1` to the URL for a live readout of raw sensor
values, compass source, and fetch state.

## Architecture

```
index.html   shell + inline error banner (any JS failure is shown, never a blank page)
styles.css   design tokens — atmosphere gradient, turbulence color ramp, PFD ladder
geometry.js  PURE: orientation → aim vector, geodesic ray projection onto FL ladder
turbulence.js PURE: profiles, wind shear, Richardson number, categories, Ellrod TI
weather.js   Open-Meteo fetch: 10 s timeout, response normalization, backoff, last-good cache
sensors.js   permission gating, iOS/Android orientation paths, smoothing, watchdogs
app.js       state store + render loop + fetch policy (HOLD / >5° / >2° / 60 s)
sw.js        PWA service worker (app shell cache; weather is never cached here)
test/        node --test known-answer suites for the pure modules
```

The pure modules run identically in the browser and in Node — no build step,
no dependencies, no API keys.

## Publishing to Google Play

See [PLAY_STORE_GUIDE.md](PLAY_STORE_GUIDE.md) for the full step-by-step
(TWA packaging with PWABuilder, Play Console setup, assetlinks, store listing).
