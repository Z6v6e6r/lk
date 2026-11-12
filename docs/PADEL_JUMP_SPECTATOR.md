# Jump spectator scoreboard

Owner: PadlHub Jump. Audience: the existing public event/community wall.
Outcome: confirmed game states and existing best-per-profile results displayed with
local read-only presentation smoothing, never a second outcome-deciding simulation or
a video stream (owner request 2026-11-12: on a TV over a weak network, motion may be
approximate as long as stage, start/failure/finish and time roughly match).
Stop signal: mismatched engine/rule/schema, missing scene/event baseline, persistent
playout budget overflow, or unexpected change to authoritative race behaviour.
Stop method: retain the old immutable frontend; do not activate the new page until
its matching backend is verified. Existing release/recovery runbooks still govern
publication; this document grants no live-write authority.

## Source and UI

The supplied `padlhub-spectator-hermes.zip` has SHA-256
`ca6ef8c141ef5e870a5a066d12285754561db3dd2e2b7ea0770082f79d1a6705`.
Its UI, timeline and network helpers are adapted under
`src/components/padel-jump/spectator/`; the supplied 30 logic tests are retained as
`padelJumpSpectatorNetwork.test.mjs` and `padelJumpSpectatorTimeline.test.mjs`, so
`npm run test:jump-live` includes them. No preview players or demo controls are
included in the application.

`LiveScreen.tsx` owns mount/unmount. The original logo, system font, original game
renderer and station art remain in use, including the blue Yasenevo court. The
accent matches the existing race action colour `#8744f5`. All new styles are scoped
to `.ph-jump-spectator`; race/cabinet CSS and gameplay are not changed. The score
label becomes “Мячи” without renaming API `stars` or changing scoring. Initial lives
come from `LIVE_LIVES`. The existing relative race-page navigation is preserved;
there is no invented QR or invitation.

The wall shows one field below 560px, up to two below 1200px, and up to four above.
Existing run order is stable; selection/rating-only mode disposes hidden renderers
and reduces their canvas stores to 1×1. A single 30Hz-target rAF schedules visible
fields. Canvas size/DPR changes only on resize. Texture loads use existing caches;
disposed renderer generations cannot paint into replacement fields. Confirmed HUD
values are discrete and independent of coordinate updates. Reduced motion uses
static frames with discrete segment/final updates. Fullscreen requires a user action.

## Additive public read protocol

Legacy `GET /jump-live-api/board` and SSE `/stream`, authenticated race commands,
identity checks, permanent result storage, rule/engine hashes and ranking order
remain intact. The new wall negotiates only:

```
GET /jump-live-api/board?spectator=1&profile=constrained&runs=<up-to-four-public-run-UUIDs>
  &catalog=<known-version>&scenes=<JSON-run-to-segment-map>&acks=<JSON-event-cursors>
  &fresh=1
```

`fresh` is sent for an explicit initial/full-state handshake, selection, resume or
recovery, not on every normal packet. Response schema is `jump-spectator-v1`:

- `engine`, `rule`, `epoch`, `sourceNow`: the existing compatibility identity, a
  process-clock epoch and current
  **server monotonic** clock, not epoch `board.now` or a client timestamp;
- `catalogVersion` and optional `catalog`: public names/slots/initial lives and the
  existing server-ordered results, omitted when unchanged;
- `poses`: accepted command sequence/time, pose, confirmed score/lives/elapsed,
  phase, station/section, segment ID and a structural delta against a cached scene;
- `scenes`: immutable full presentation baselines, sent only for unknown segments;
- `events`: reliable transitions with run-scoped `eventId`, `eventSeq`, timestamped
  snapshot and its exact scene, retransmitted until the receiver includes its ack;
- `gaps`: a cursor fell outside the bounded journal; the consumer holds and requests
  a fresh baseline rather than silently acknowledging missing transitions;
- `baselines`: explicit full-state reconciliation cursors. The receiver acknowledges
  a cursor only after accepting its corresponding current snapshot. Background
  history is not accelerated or replayed as a burst of effects.

Each accepted registry command captures presentation state. Failure, retry, level,
pause/resume and durable finish change the segment and bypass disposable pose
coalescing. Exact command retries do not create another event. A pending eliminated
attempt says “Сохраняем результат”; only a durable server finish locks the terminal
presentation. Results still come from the permanent server ranking, never from the
renderer. The journal holds at most 128 transitions per retained run. Registry
expiry/self-replacement releases its spectator data even with no spectator traffic.
This is a bounded in-memory presentation journal, not a durable result/event archive.
After service restart, unfinished runs retain the existing non-resumable limitation.
Confirmed finals survive registry removal/self-rejoin for 30 seconds in at most 24
spectator tombstones. A self-rejoin that durably recovers a pending result also emits
its final presentation before retiring the old run. The wall retains up to four
received final cards for at most ten seconds, so catalog replacement cannot remove
the result before delayed presentation. Duplicate snapshots never extend that hold.
Array overlays include absolute immutable-scene indices plus changed values, so
removed platforms do not force retransmission of every remaining platform's geometry.
They never depend on receipt of the preceding disposable pose.

The player's ACK/ticket is constructed and cached before optional spectator capture.
Projection clone/serialization failures cannot lose a join capability or corrupt an
identical command retry. A failed projection is exposed as an explicit gap, then the
next accepted command starts a new scene generation and requires full rebaseline.
The legacy SSE timer avoids building a board when it has no viewers; an attached
legacy viewer retains its original initial snapshot and 500ms cadence.

`LatestPosePublisher` coalesces **only** intermediate states into one pending slot
per source/profile and a single cached payload. It does not queue HTTP writes.
Critical/finished offers explicitly take the reliable path; oversized pose errors
make that spectator projection unavailable rather than enqueueing arbitrary data.
HTTP reception is single-flight with an eight-second deadline, bounded response
size, retry backoff and no old-coordinate request queue. There is no new push socket,
new authentication route, credential transfer, provider call or identity field.

## Clocks, presentation and weak networks

Profiles are explicit via `?network=normal|constrained|fallback`; default constrained:

| Profile | Read / pose target | Minimum extra playout reserve |
| --- | ---: | ---: |
| normal | 5/s | 400ms |
| constrained | 2/s | 1200ms |
| fallback | 1/s | 2200ms |

A single HTTP handshake maps server monotonic `sourceNow` to the midpoint of local
monotonic send/receive times. This is a symmetric-transit estimate, **not** precise
one-way latency. The same `sourceTimeAt` function feeds timeline and adaptive policy.
Normal arrivals never reanchor clocks. Explicit recovery reanchors both and starts
only a new policy measurement epoch, preserving the same timeline sequence and final
lock. `skipToLatest()` snaps to a verified fresh snapshot without resetting a run.
A changed server clock epoch is anchored before ingesting new attempts, preventing
the previous service uptime from permanently putting new playback in the future.

Adaptive delay includes source cadence, positive arrival jitter and state age. Delay
is changed through `setDelayMs` with monotonic presentation; the cap is 4000ms on a
phone and 10000ms on the TV stage (a late picture is acceptable there). Exceeding it
requests fresh state with deduplication. It never manufactures a defeat or a result.

Ball, camera, platforms and moving objects use the same delayed pair of scenes;
score/lives/level/result stay on the confirmed left state. Segment changes (start,
failure, retry, level, finish) are shown as confirmed and never blended.

`smooth-motion.mjs` is presentation only:

- between two confirmed samples the ball follows a ballistic arc from the left
  sample's velocity (gravity + platform-top bounces), corrected to land exactly on
  the right sample; a mismatch over 160 units falls back to an eased curve;
- with no fresh confirmed motion (holding/buffering/stale) the ball *coasts* on an
  autopilot for up to 12s on TV (6s elsewhere): it bounces on the scene's platforms,
  never leaves the screen and never shows a local failure; after the budget the
  picture holds with “Ждём связь с игроком”;
- recovery eases from the coasted picture to the confirmed one over ~650ms;
- the running clock ticks locally between confirmations, monotonic and at most 2.5s
  ahead; the final time is always the confirmed one.

None of this feeds the HUD score/lives, the ranking or any server.

These are measurement starting points, not bandwidth/FPS guarantees. Requests for
current snapshots and event scenes still have real payload cost. If sustained transit
exceeds the configured presentation budget the wall truthfully holds rather than
claiming smooth playback. Use a smaller visible group/fallback profile where needed.
Real asymmetric networks and the exhibition TV still need separate acceptance.

## TV stage and offline fallback

`LiveScreen` enables the 16:9 TV stage with `?tv=1` or automatically on a landscape
(≥1.55, ≥900px) exhibition wall; `?tv=0` disables it. `spectator-tv.css` lays out a
fixed 1920×1080 stage in `--u` units (identical on 960×540 boxes and 4K panels):
up to four large fields with name/balls/time/lives, a top-10 sidebar, and when nobody
plays a full-screen rating (podium + places 4–13, pages rotate every 15s, CTA band).
Players beyond four and long ratings rotate automatically; Enter/F on a remote
requests fullscreen. Buttons and view switches are hidden on the stage.

The last confirmed rating is cached in `localStorage` and shown, with its time, when
the board cannot be read. After 15s without any successful read (45s after a previous
success) and with nobody playing, the TV shows labelled demonstration games
(`demo-runs.mjs`: real engine and art, autopilot, “Демонстрация” badge and “Демо”
tags). They never enter the rating and disappear on the next successful read.
`?jumpDemo=1..5|loop` runs a fully offline wall (no network reads, sample rating) —
used to record the stand's fallback videos.

## Checks

```
npm run test:jump-live
npx tsc -b
npx eslint src/components/padel-jump/LiveScreen.tsx src/components/padel-jump/spectator games/padel-jump/live/{registry,server,spectator}.mjs
npm run build:jump-live
npx vite build --config games/padel-jump/vite.config.ts
```

Tests cover package timing/publisher contracts, additive/legacy HTTP negotiation,
private-data exclusion, reliable cursor replay, source-clock mapping, camera/pose
agreement, terminal reconnect protection, explicit gap recovery, incompatible
engine/rule rejection, a virtual 15-minute jitter/buffer run and expiry without any
spectator reader. Browser evidence must separately identify synthetic data, real
renderer use, dimensions, offline/recovery, keyboard, reduced motion, fullscreen,
resource disposal and actual device limitations. LOCAL is not CI or PRODUCTION.

## Publication boundary

Publish a compatible backend before the new wall; old pages continue using their
unchanged board/SSE contract. The new page fails explicitly against an old backend
rather than substituting mock data. Use the existing guarded Jump backend/frontend
updater with a clean pushed reviewed source, exact-head CI and fresh host/data/static
preimages. Do not overwrite the existing immutable URL or deploy from this worktree.
Do not update the main LK bundle as part of this isolated scoreboard change. Retain
permanent receipts, questionnaires, identity settings and all existing routing.
