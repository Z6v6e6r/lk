# PadlHub Jump: timed community campaign and live wall

Status: team pilot activation package. Community «ПадлхАБ команда» now exists: `community_1793001495612_падлхаб-команда`, invite `падлхаб-команда-26gkvx`. The user authorized finishing its test release on lk-primary-147 on 26 October 2026. The previous immutable game remains at https://padlhub.su/lk/padel-jump-test-834d51f8/padel-jump.html. This document is a runbook, not deployment evidence; require the exact activation receipt and public checks for a live claim.

## Product contract

- `padel-jump-race.html` starts a fresh campaign: 11 stations, three consecutive parts each. Practice progress does not enter the competition.
- The server measures start-to-final-completion elapsed time, including failures, retries and transition screens. Confirmed pause/background intervals are excluded. The clock freezes when the server accepts the final part, before result persistence/identity revalidation. Network latency around pause/finish can affect the accepted time; this is not a precision sporting timer.
- Every input is quantized before both local simulation and ordered server replay. The server owns progress, attempts, completion and elapsed time; clients cannot submit an arbitrary score, actor or duration.
- A denied/unavailable sensor falls back to touch/keyboard. Sensor permission/calibration happens before the server starts the clock. Returning from a pause recalibrates an available sensor.
- Participants use the existing authenticated LK profile and must be active members of the configured community. There is no guest/nickname fallback. Missing community configuration closes entry with `COMMUNITY_NOT_CONFIGURED`.
- The live wall (`padel-jump-live.html`) defaults to actual game-field miniatures rendered with the original assets from server-accepted state. Up to three columns and four rows: 3 players = one row, 6 = two rows, 12 = four rows. The 13th participant receives an explicit capacity error. Updates are twice per second, not screen video.
- Explicit start consent covers displaying the verified profile name, game and result on the public wall. Public payloads omit profile IDs, community IDs, contacts and credentials. Treat the wall URL as public; do not project it without the agreed participant consent.
- Ranking retains the best completed time per profile in this community/rule/engine version, for 48 hours, with up to 500 retained results and 100 visible ranking entries. This dedicated game leaderboard does not alter the community's existing sporting rating.

## Boundaries and recovery

`games/padel-jump/live/identity.mjs` verifies the bearer token against the fixed Viva profile provider, then exact active membership against the fixed LK community endpoint. Neither a caller-provided name nor decoded JWT claims authorize a run. Ordinary identity cache: 30 seconds; finish rechecks the providers. Tokens remain in memory and are not written to results or URLs.

The simulation closure comprises `campaign.ts`, `level-layout.ts` and `engine.ts`, ordered and hash pinned by `live-contract.ts`. The existing endless EVENT contract is separate and remains unchanged. Updating the replay closure requires a new engine version and compatibility check.

Runs live in process memory. A service restart invalidates unfinished runs; it does not claim resumability. Normal disconnected runs expire after 10 seconds. A verified final run remains available for result confirmation for 10 minutes, while disappearing from the live wall after 10 seconds without updates. Reloading the participant page loses its in-memory run capability. State this limitation during the pilot.

Finish persistence uses private temporary files followed by atomic no-clobber hard-link publication to per-run UUID JSON files and file/directory fsync. Interrupted temporary files are ignored at startup; malformed legacy final files are preserved in a private quarantine so other durable results remain available. Same-sequence identical retries receive the same acknowledgement. A failed finish can resend its identical envelope; heartbeat and blur/pause commands cannot overtake a pending finish. Completed receipts survive restart. A missing/unwritable result directory fails closed, without showing a saved result. Expired current-community/version files are pruned; mismatched versions/communities remain quarantined for operator review, not loaded into rankings.

Replay validates legal input and sequence, not human control. Bots and deliberation during excluded pauses remain possible. Do not present this as prize-grade anti-cheat.

## Local checks and operation

```sh
npm run test:jump-live
npm run build:jump-live
npx vite build --config games/padel-jump/vite.config.ts
```

The packager `scripts/package_padel_jump_live_147.py` requires clean pushed source and exact-head successful CI, then builds both artifacts itself before writing provenance and the private payload. The backend build produces `dist/padel-jump-live/server.mjs` and a manifest with source, dirty-state and bundle hashes. `games/padel-jump/vite.config.ts` builds the three HTML entries and proxies local `/jump-live-api/` to loopback port 5193. Runtime requires Node 22 or later supported by the locked build target. There are no new dependencies.

A local service may be started only with its own private results directory:

```sh
JUMP_PUBLIC_ORIGIN=http://127.0.0.1:5192 \
JUMP_RESULTS_DIR=/absolute/private/jump-results \
JUMP_COMMUNITY_ID=ACTUAL_COMMUNITY_ID \
JUMP_PORT=5193 node dist/padel-jump-live/server.mjs
```

No production credential belongs in this command, Git, browser URLs or a fixture. A real ID and authorized authenticated profile are required for membership acceptance. Explicit local test fixtures inject authentication outside the repository and are not production bypasses.

## Scoped activation plan — lk-primary-147

The current request authorizes connecting this named community and delivering the isolated team test on lk-primary-147. Scope: one new dedicated service/private store, one new `/jump-live-api/` include, and one immutable static release. It does not authorize a main-LK deployment, Node-RED restart, unrelated routing changes, community migration or membership edits. Use `scripts/padel_jump_live_147.py` with an exact reviewed plan, source/script/payload hashes and fresh protected-path preimage; a changed preimage stops activation. Never blindly retry an ambiguous SSH apply; inspect the private receipt and phase journal first.

1. Freeze and push the reviewed source commit; require exact-head CI, clean frontend/backend builds, security review, local/remote/public manifests and bundle hashes. Select a new immutable static directory without overwriting earlier releases.
2. Verify the configured community ID, profile endpoint response and active/banned/removed membership behavior using a legitimate session. Check that the existing LK session is available when opening the standalone race page; do not introduce a token in a link or loosen auth. Confirm display-name consent and retention with the organizer.
3. Inspect current host topology, Node runtime, free port and disk capacity. Proposed backend directory `/opt/padlhub-jump-live/releases/<sha>/`, private results `/var/lib/padlhub-jump-live/<community-id>/`, dedicated unprivileged system account, and loopback `127.0.0.1:5193`. Verify all paths/port are unused before activation. No Node-RED flow or existing community rating write is needed.
4. Prepare a reviewed systemd unit using absolute Node/bundle paths, `User=padlhub-jump-live`, `Restart=on-failure`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=` only the private results directory. Configure `JUMP_PUBLIC_ORIGIN=https://padlhub.su`, exact community ID and private results path via a root-owned environment file. The service stores profile IDs privately; keep directory mode 0700 and receipts 0600. Back up receipts according to the agreed 48-hour retention; do not restore foreign-community receipts into an active directory.
5. Prepare only a new same-origin `/jump-live-api/` location proxying to that loopback listener, preserving the path and exact browser Origin. SSE needs buffering off, an appropriate read timeout and an idle keepalive strategy. Retain existing LK/Tilda/Node-RED routes. Run `nginx -t`; inspect remote preimage and rollback diff before any approved reload. Headers and logs must not capture Authorization, run capability or request bodies.
6. With explicit topology activation approval, install immutable artifacts, start only this unit, apply the reviewed new location and reload nginx. Verify local health and exact public hashes, then authenticated real-member entry, wrong-member rejection, real phone permission/tilt/pause/retry/full finish, durable result after restart, and one shared live screen. Synthetic 12-player layout checks do not substitute for this acceptance.
7. Retain old static URL unchanged. Recovery: remove/disable only the newly introduced proxy location and stop the dedicated service after taking required receipts; validate/reload nginx with the preserved preimage. Do not delete results, alter existing LK pointers or roll back unrelated services. Mid-run clients must receive an explicit unavailable state and start a new run after recovery.

Until these prerequisites are complete, use the existing standalone URL for phone gameplay, and label the timed race/live wall as a local candidate.

## Team entry and operational recovery

The race entry now reuses the existing VivaAuthProvider directly and the consent-preserving SMS form on the game origin. It does not transfer the .ru session through a URL or message. The game offers Yandex and SMS. Its OAuth callback is the current game page on the same origin; PKCE/state stay in sessionStorage, tokens never travel in a return link, and the existing client/callback contract requires no provider-setting change. Other LK entries keep the default cabinet callback and provider list. Users already authenticated on the game origin reuse their session; others confirm their existing profile number. Community admission now uses the explicit in-game questionnaire and the existing invite API described below.

## Community admission and private questionnaire

The new entry sequence is authentication → fresh verified profile/community inspection → registration when positively not a member → explicit **Save questionnaire and join** → fresh ACTIVE membership confirmation → **Open game**. Existing members skip the form. Loading, upstream failure, incomplete roster, pending and blocked membership have separate states. Authentication through Yandex or SMS and the existing phone-completion step are unchanged.

`GET /jump-live-api/entry` exposes only the current authenticated participant's status and own form prefill. `POST /jump-live-api/enrollment` accepts only firstName, lastName, email, companyWebsite and explicit consent. Identity, target community, invitation and MEMBER role come from verified server inputs. Company URLs are validated as HTTP(S) text and are never fetched. There is no Viva profile PATCH: the user chose a separate questionnaire for the organizers.

Questionnaires are private mode-0600 records under the existing isolated store's mode-0700 `enrollments/` subdirectory; no wider service write permission is added. A durable private intent is required before membership mutation. These questionnaire records are separate from the 48-hour game-result retention and are retained for organizer handling; no automatic questionnaire deletion or export is included. Email and company website never enter community member payloads, run state, ranking, public board, telemetry or logs. No HTTP questionnaire-list/export endpoint exists: legacy community roles are not sufficient authority for exposing the collected PII.

The configured community's existing invite-join API is reused. Calls from this service serialize across participants; external LK roster writers are outside that mutex. An upstream 200 or ACTIVE response alone is insufficient: a new authenticated detail read must confirm membership. If a join outcome is ambiguous, the form remains durably saved and later requests only check membership; they do not blindly repeat the write. Operator investigation can be needed if confirmation never arrives. Hidden pending/banned lists with unknown/nonzero aggregate counts cannot establish a particular person's eligibility and fail closed; aggregate counts are never interpreted as that person's status.

Ordinary identity GET deadlines remain three seconds each, within the existing eight-second replay transport budget. Only enrollment's join POST has an eight-second deadline; queued enrollment work expires after twenty seconds before execution. Rate-limited service diagnostics contain only an allowlisted error code and profile/community stage, never credentials or profile fields.

`scripts/update_padel_jump_live_147.py` packages clean pushed source with both exact-head CI checks, immutable backend/frontend files and the current service preimage. It changes only the two source paths in the existing unit, keeps nginx/env/security settings untouched, checks old files/data, and has guarded recovery to the prior backend while preserving newly collected forms. Empty visible board is a best-effort maintenance check, not a drain guarantee: restarting invalidates unfinished in-memory runs, including a hidden pending finish. Durable completed results and questionnaires stay on disk. This is a pilot maintenance update, not a zero-downtime migration. Never retry an ambiguous SSH apply; inspect its private phases/receipt first.

The fixed community detail upstream is `https://padlhub.su/lk/communities/<encoded-id>`, not `/seliger/lk/communities`. Cyrillic letters/digits, underscore and hyphen are accepted within the bounded configured ID; separators/query/control characters are rejected. The private results directory uses a hash of that ID.

Source templates are in `games/padel-jump/live/deploy/`. The publisher verifies the unchanged original static release, existing LK bundles/pointer and all other nginx snippets/vhosts before and after installation. Runtime proof includes systemd MainPID/command line and backend bundle SHA. `recover --upload <exact-upload-directory>` disconnects only this pilot's matching nginx include and dedicated service, checks installed artifact hashes, and retains immutable releases, account and private result receipts. If the nginx candidate drifted, recovery stops instead of overwriting concurrent edits. Inspect the phase journal/receipt after any transport interruption.

The standalone race does not install the cabinet-wide five-minute idle-data reload guard: tilt-only gameplay may have no DOM input events for longer than that. Its own pause/background clock and authenticated session refresh remain active.

## Yandex frontend update

`RaceEntry` explicitly opts into `oauthCallbackMode="current-page"` and the Yandex-only provider list. SMS, consent gates and mandatory phone binding remain. Callback initialization blocks an older stored identity before the first render; unresolved/failed callbacks cannot silently refresh that older identity into the game. Legacy community invitation `?code=` is distinguished from an OAuth response. Stored callback/return targets must remain same-origin, and missing PKCE storage fails before leaving the page. An explicit profile-switch action is available before starting a race.

## Authoritative checkpoint and lifecycle boundary

The participant transport admits simulation inputs only while the last server acknowledgement says `playing` with a running game. Terminal/paused acknowledgements atomically discard only unsent prediction buffers; already sent envelopes, sequence numbers and finish retries are unchanged. Empty heartbeats continue while waiting at checkpoints or on pause so the existing ten-second run lease remains alive. A synchronous control-command barrier prevents prediction and automatic flush from overtaking pause/resume/retry/advance.

`race-control.ts` coordinates local modes with that server boundary. A terminal acknowledgement received during local pause updates the mode to restore on resume. Blur/hidden events during a transition defer the pause until the new game exists, before admitting simulation input. Resume rechecks foreground after sensor calibration; a run created after the page was hidden is explicitly paused. Only a matching section's terminal/paused acknowledgement affects the displayed game; it never replaces the simulation with the public wall's filtered snapshot. Errors retain an allowlisted machine code for diagnosis.

The controlled regression with a withheld first-checkpoint acknowledgement and an injected speculative tail fails with the old transport (`INPUTS_NOT_RUNNING`) and passes with this boundary. It establishes that defect and recovery prevention, not the cause of every device-specific 409. The reported no-click 190m incident requires a fresh phone test; its exact historical error code was not retained. No server replay rule, engine version, scoring, membership or existing backend changes are needed for this frontend update.

Publish this change with `scripts/publish_padel_jump_frontend_147.py`: a new immutable frontend directory, compatible pinned engine and unchanged running backend/PID/unit/env/nginx/results. The package step requires clean pushed source and exact-head successful CI and builds fresh frontend bytes. Full old-release/backend/nginx preimages and no-clobber publication preserve active races and the previous URL. If interrupted after publication, read back files/runtime before retrying; the previous URL remains the recovery option without deleting or modifying any release.
