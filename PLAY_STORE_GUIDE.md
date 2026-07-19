# SkyShear — Beta Testing & Google Play Publishing Guide

Two delivery stages, exactly as requested:

1. **Beta on your phone** — via the deployed website (no store, no wait).
2. **Google Play release** — the same site packaged as an Android app
   (Trusted Web Activity). One codebase, two channels.

---

## Stage 1 — Beta test on your phone (today)

The site itself is the beta. Phone sensors only work over HTTPS, which GitHub
Pages provides for free.

1. Deploy to GitHub Pages (steps in [README.md](README.md) — create repo, push,
   enable Pages).
2. On your phone, open `https://drogov4122-del.github.io/Skyshear/` in
   **Safari** (iPhone) or **Chrome** (Android).
3. Optional but recommended: add it to your home screen —
   - iPhone: Share button → *Add to Home Screen*
   - Android: Chrome menu ⋮ → *Add to Home screen* (Chrome will offer "Install
     app" because SkyShear is a PWA — that installed version already looks and
     feels like the final Play Store app)

### Beta test checklist (run through once on each phone)

- [ ] Tap **Enable sensors** → allow Motion and Location → badge turns LIVE
- [ ] Point at the sky, sweep around — bearing/elevation update smoothly
- [ ] Compare bearing with a compass app; correct any offset with the calibration slider
- [ ] Tap **HOLD** — aim freezes, ladder updates
- [ ] Deny motion permission (fresh tab) → app falls back to manual mode with a clear message, no hang
- [ ] Turn on airplane mode, tap Refresh → error message + retry, no endless spinner
- [ ] Background the app 30 s, return → badge shows STALE, recovers on movement or re-enable
- [ ] Rotate to landscape → readings stay sane (portrait is recommended)
- [ ] Try the Camera toggle → AR reticle; deny it → graceful gradient fallback
- [ ] Switch aircraft type → severity labels change without refetch

---

## Stage 2 — Publish to Google Play

A static web app ships to Play as a **Trusted Web Activity (TWA)**: a thin
Android package that opens your HTTPS site full-screen in Chrome's engine.
Google explicitly supports this route for PWAs. SkyShear already meets the PWA
requirements (manifest, service worker, icons, HTTPS on Pages).

### What you need (accounts & costs)

| Item | Where | Cost |
|---|---|---|
| Google Play Console developer account | https://play.google.com/console/signup | **$25 one-time** |
| The deployed site | GitHub Pages (Stage 1) | free |
| PWABuilder (packaging tool) | https://www.pwabuilder.com | free |

**Play Console signup instructions:**
1. Go to https://play.google.com/console/signup and sign in with the Google
   account you want to own the app (drogov4122@gmail.com or a dedicated one).
2. Choose **"Yourself"** (personal account) unless you want it under EdgePoint
   LLC — an organization account additionally requires a D-U-N-S number and
   company verification (takes days; personal is fine for this app).
3. Pay the $25 registration fee (card), verify your identity (Google asks for a
   government ID photo — normal, takes minutes to ~2 days to approve).
4. Note: new personal accounts must run a **closed test with at least 12
   testers for 14 days** before they can publish to production (Google policy
   since late 2023). Plan for this — it's the longest step in the whole
   process. You (plus family/colleagues) can be the testers; I can help set up
   the closed-testing track and email list when we get there.

### Step-by-step: package the site with PWABuilder

1. Open https://www.pwabuilder.com, paste your live URL
   (`https://drogov4122-del.github.io/Skyshear/`), press **Start**.
2. PWABuilder scores the PWA (manifest/service worker/HTTPS should all pass —
   they're built in). Press **Package for Stores → Android**.
3. In the Android options:
   - **Package ID**: `com.edgepoint.skyshear` (or similar reverse-DNS — permanent, choose once)
   - **App name**: SkyShear · **Version**: 1.0.0
   - **Signing key**: let PWABuilder **create a new signing key** — download the
     `.keystore` file and the passwords it shows and store them safely (e.g.,
     your password manager + a backup). Losing them means you can never update
     the app.
4. Download the ZIP. It contains:
   - `app-release-signed.aab` — the Android App Bundle you upload to Play
   - `assetlinks.json` — proof that the app and website belong together
   - `signing.keystore` + `signing-key-info.txt` — SAVE THESE

### Step-by-step: digital asset links (removes the browser bar)

1. Put `assetlinks.json` in the site at `.well-known/assetlinks.json`:
   ```
   site/.well-known/assetlinks.json
   ```
   commit and push (I can do this — just give me the file from the PWABuilder ZIP).
2. Verify it loads at
   `https://drogov4122-del.github.io/Skyshear/.well-known/assetlinks.json`.
   Without this, the app still works but shows a browser address bar on top.

### Step-by-step: Play Console listing

1. Play Console → **Create app** → name *SkyShear*, App (not game), Free.
2. **App content** section (all required, ~20 min):
   - Privacy policy URL — required. Already done: `https://drogov4122-del.github.io/Skyshear/privacy.html`
     (no accounts, no analytics; location/motion processed on-device; weather
     coordinates go to Open-Meteo; optional flight lists send the user's own
     AviationStack key + searched route to AviationStack).
   - Data safety form (Play counts data sent to ANY third party as "shared"):
     - **Location (approximate + precise)** — collected AND **shared** (with
       Open-Meteo), purpose App functionality, processed ephemerally, not
       stored, optional (manual mode exists).
     - **App activity (app interactions)** — collected AND **shared** (route
       searches sent to AviationStack), optional, user-initiated only.
     - The AviationStack API key is user-provided, stored only on-device, and
       transmitted only to AviationStack for authentication — declare under
       "User IDs/auth info: shared with AviationStack, optional" if the form
       flags it.
     - Keep privacy.html and this form consistent — mismatches are a common
       Play rejection trigger.
   - Content rating questionnaire: Utility, no user content → Everyone.
   - Ads: No. Target audience: 18+ (avoids child-policy overhead).
3. **Release → Testing → Closed testing** → create track, upload
   `app-release-signed.aab`, add tester emails, start the 14-day/12-tester clock.
4. Store listing needs:
   - App icon 512×512 (already have: `icons/icon-512.png`)
   - Feature graphic 1024×500 (I can generate one)
   - At least 2 phone screenshots (take them during your beta)
   - Short (80 chars) + full (4000 chars) descriptions (I can draft)
5. After the closed-test period: **Promote to Production**, Google reviews
   (usually 1–3 days for new apps), then SkyShear is live on Google Play.

### Updating the app later

The beauty of TWA: **the app content IS the website.** `git push` to Pages
updates every installed app instantly — no Play review, no version bump.
You only re-upload an `.aab` if the manifest/icons/package itself changes.

### What about the Apple App Store?

Not included here: Apple requires a Mac, an Apple Developer account ($99/year),
and is hostile to thin web wrappers (App Review Guideline 4.2). The PWA
"Add to Home Screen" route on iPhone gives ~90% of the experience for $0. If
you later want a real App Store listing, that becomes a Capacitor wrap project.
