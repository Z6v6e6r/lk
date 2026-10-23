# PadlHub Jump — exhibition prototype

Campaign update (20 October): see [the implementation, balance, tests and human-test protocol](PADEL_JUMP_CAMPAIGN.md). Rackets now give one bounce and fall; the default route is the 11-station campaign.

Target event: 13 November 2026. This branch provides a playable local prototype, not a published exhibition release.

## Implemented

- A shared TypeScript simulation and Canvas renderer for web and Capacitor WebViews.
- Auto-jumping ball, racket/court platforms, spring nets, moving platforms later in the course, an endless generated route, height and game over/retry.
- Left/right touch or pointer hold on the field or buttons; desktop arrows or A/D. P or Escape pauses. The ball wraps horizontally at the field edges in endless mode; the campaign has side walls.
- Explicit pause/resume, automatic pause on blur, hidden document and pagehide, bounded fixed-step simulation, resize and animation cleanup on unmount.
- Device-local personal best with a storage-denied fallback. This record is not authoritative for prizes and is not linked to a player account.
- Cabinet entry card, guest entry above the home sign-in form, and `?padelJump=1` guest route. Android's existing tournament-only home also has a guest entry card before sign-in and an entry above tournaments after sign-in. Return removes only the game query parameter.
- A standalone guest page without LK auth/API dependencies. Graphics use local Canvas/CSS, original SVG sprites and the prepared Yasenevo painting; no external fonts, asset services, SDKs or new dependencies are needed.

## Local preview and checks

```sh
npm run dev -- --host 127.0.0.1 --port 5178
# Open http://127.0.0.1:5178/padel-jump.html
# LK integration: http://127.0.0.1:5178/?padelJump=1

node --experimental-strip-types --test scripts/tests/padelJump.test.ts
npx tsc -b
npx eslint src/components/padel-jump src/padel-jump.tsx games/padel-jump/vite.config.ts scripts/tests/padelJump.test.ts
npx vite build --config games/padel-jump/vite.config.ts
```

The standalone output is `dist/padel-jump/padel-jump.html` plus relative assets. Uploading that directory requires a separately authorized publication. It is built separately from LK and is not included in LK release manifests. `npm run build` cleans `dist`, so build the standalone page after the full LK build if both outputs are needed.

The game integrated in LK is included automatically by the existing production and dev main bundle builds. CSS is prefixed `pj-`; it does not reset the host page or lock document scrolling. The standalone HTML owns its own body margin reset. Canvas uses a fixed logical 420×640 field with uniform scaling to preserve proportions on rotation. No global game keyboard handlers are installed.

## Mobile verification

Use the existing build/sync commands and existing application identity. No permissions, auth, provider calls, signing configuration or distribution settings were changed. `npm run build` and `npm run cap:sync:android` prepare the Android wrapper; Gradle/JDK/SDK are still required for an APK. `npm run cap:sync:ios` and the existing Xcode project prepare iOS; a physical-device release needs the existing signing/provisioning and distribution setup.

A browser in a phone-sized viewport is not a physical Android/iPhone test. Before exhibition acceptance, verify touch hold/release/cancel, safe areas, rotation, background/resume, native Back, return to LK and a complete run on both platforms. The game does not install native Back/deep-link handlers or change the existing wrapper lifecycle.

## Remaining exhibition delivery

1. Agree on the final artwork, difficulty and sound; replace/expand the current vector prototype artwork as needed.
2. Verify actual Android/iOS packages and choose installation channels. App Store/TestFlight availability is a separate acceptance item.
3. Publish a stable HTTPS landing page, installation links and platform/app-link fallbacks, then generate and physically test the printed QR. No final QR or installation URLs are fabricated in this prototype.
4. If prizes/rankings are wanted, implement reviewed server-owned sessions, score verification/replay, abuse limits and player linkage. Do not award prizes from localStorage scores.
5. Rehearse the event flow over the exhibition network, including slow/offline behaviour. Offline cold-start/PWA installation is not implemented in the standalone prototype.

No deployment, live data changes, store upload, prize award or external user messages are part of this branch.

## Verification on 19 October 2026

- Engine tests: 11/11 passed; scoped ESLint and TypeScript passed. Full-source ESLint (excluding generated native web assets and local browser evidence) completed with 0 errors and 398 existing warnings.
- Full LK prod/dev bundle build passed. The affected main prod/dev bundles were rebuilt after entry-card changes; standalone web production build passed.
- Chromium checks covered a complete run/retry, pause/resume, touch hold/move/release, keyboard control, best-score persistence, 320px/390px portrait, landscape and desktop, guest LK entry and external-focus preservation. Simulating missing Canvas roundRect did not break rendering. Remote requests were blocked during the integrated LK route check.
- Android Capacitor sync and Gradle assembleDebug passed with JDK 21 / SDK 36. The APK signature verified (v2); identity remains the repository default com.cabinet.app, version 1.0/code 1, label «Турниры ПхАБ». This is a debug prototype, not a store release. Existing Capacitor core/android version mismatch warning remains; dependencies were not upgraded.
- iOS Capacitor sync and Xcode Debug iphonesimulator build passed with CODE_SIGNING_ALLOWED=NO (arm64/x86_64). This is an unsigned simulator app, not an IPA or TestFlight release. No already-booted simulator or attached Android device was available; native runtime and physical-device checks were not performed.
- Builds reused the checkout's installed node_modules through a local symlink. Generated native package-path changes were excluded from the source diff. No signing material or runtime outputs are committed.

## Web tilt controls

On touch-capable devices, the first «Полетели» click requests tilt access automatically. Hold the phone comfortably and allow the browser prompt: the round starts after the first valid calibration sample, or in manual mode if access is denied/unavailable or no signal arrives within four seconds. Desktop starts immediately with keyboard/touch. Repeated attempts do not repeat a denied automatic request. Pending starts are cancelled on exit, backgrounding or unmount; a late sensor grant cannot start a cancelled round. Steering uses the browser's DeviceOrientation API (orientation derived from the phone sensors), with a neutral baseline, a 3-degree dead zone, proportional speed and smoothing. Pause/resume recalibrates to the new comfortable phone position. Rotation also pauses and recalibrates in screen coordinates. Touch/keyboard input overrides tilt while held. The separate input-mode strip is removed; connection guidance appears inside the start overlay only while connecting.

Sensor access is requested only from a start/control button click, including Safari's requestPermission path. Permission denial, unsupported sensors, restricted embedding or no valid samples for four seconds leave touch/keyboard available. Samples older than 750 ms do not steer. Permission grants arriving after cancellation/unmount are ignored. No sensor samples are saved or transmitted. The implementation owner is the LK frontend; the audience is players choosing optional tilt controls; the stop signal is absent/stale input or a permission failure, and the stop method is zero sensor steering plus manual fallback/pause.

For a physical phone use a top-level **trusted HTTPS** URL. The Mac's `http://127.0.0.1:5179` preview works on the Mac; it is not a phone-accessible link. An ordinary LAN HTTP address is not sufficient for sensor permissions. An embedded page may additionally require the host's accelerometer/gyroscope Permissions Policy; no host policies or server settings are changed here. Phone sensor direction/sensitivity and the real iOS permission sheet still need physical-device acceptance.

Tilt verification: 19 combined engine/controller tests passed, including screen-axis mapping, smoothing, dead zone, denial, insecure/unsupported context, stale/no-signal input, late grants and listener/timer cleanup. Chromium checks use emulated orientation events and permission responses, not a physical accelerometer. Web/main prod/dev bundles are rebuilt; the earlier APK and iOS simulator artifacts do not include this subsequent web iteration.

First-start verification: eight coordinator tests additionally cover gesture-synchronous automatic permission, calibration, manual preselection/fallback, duplicate requests, cancellation/late grants and resume calibration (27 combined tests). Chromium with emulated permission responses and sensor samples verifies the actual first-start flow and both non-reflected Cyrillic court banners. Real Safari permission-sheet focus return and physical sensors remain device acceptance items.

The input-mode buttons and their always-visible status strip are removed from the game header. Automatic first-play tilt, permission/no-signal manual fallback, manual input override and pause/resume calibration remain available.
