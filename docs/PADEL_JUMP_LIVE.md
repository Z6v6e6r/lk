# PadlHub Jump: timed community campaign and live wall

Status: source candidate, not activated. The existing immutable standalone game remains at https://padlhub.su/lk/padel-jump-test-834d51f8/padel-jump.html. No community has been created. No service, ingress, database or permissions have been changed on lk-primary-147 for this candidate.

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

Finish persistence uses private per-run UUID JSON files, exclusive creation and file/directory fsync. Same-sequence identical retries receive the same acknowledgement. A failed finish can resend its identical envelope; heartbeat and blur/pause commands cannot overtake a pending finish. Completed receipts survive restart. A missing/unwritable result directory fails closed, without showing a saved result. Expired current-community/version files are pruned; mismatched versions/communities remain quarantined for operator review, not loaded into rankings.

Replay validates legal input and sequence, not human control. Bots and deliberation during excluded pauses remain possible. Do not present this as prize-grade anti-cheat.

## Local checks and operation

```sh
npm run test:jump-live
npm run build:jump-live
npx vite build --config games/padel-jump/vite.config.ts
```

The backend build produces `dist/padel-jump-live/server.mjs` and a manifest with source, dirty-state and bundle hashes. `games/padel-jump/vite.config.ts` builds the three HTML entries and proxies local `/jump-live-api/` to loopback port 5193. Runtime requires Node 22 or later supported by the locked build target. There are no new dependencies.

A local service may be started only with its own private results directory:

```sh
JUMP_PUBLIC_ORIGIN=http://127.0.0.1:5192 \
JUMP_RESULTS_DIR=/absolute/private/jump-results \
JUMP_COMMUNITY_ID=ACTUAL_COMMUNITY_ID \
JUMP_PORT=5193 node dist/padel-jump-live/server.mjs
```

No production credential belongs in this command, Git, browser URLs or a fixture. A real ID and authorized authenticated profile are required for membership acceptance. Explicit local test fixtures inject authentication outside the repository and are not production bypasses.

## Pending activation plan — lk-primary-147

`liveMutationAuthorized=false`: this is a reviewable proposal, not an execution script. Previous immutable static publication excluded new services, routing and shared state. Obtain exact approval for the following topology after the community exists.

1. Freeze and push the reviewed source commit; require exact-head CI, clean frontend/backend builds, security review, local/remote/public manifests and bundle hashes. Select a new immutable static directory without overwriting earlier releases.
2. Confirm the future community ID, profile endpoint response and active/banned/removed membership behavior using a legitimate session. Check that the existing LK session is available when opening the standalone race page; do not introduce a token in a link or loosen auth. Confirm display-name consent and retention with the organizer.
3. Inspect current host topology, Node runtime, free port and disk capacity. Proposed backend directory `/opt/padlhub-jump-live/releases/<sha>/`, private results `/var/lib/padlhub-jump-live/<community-id>/`, dedicated unprivileged system account, and loopback `127.0.0.1:5193`. Verify all paths/port are unused before activation. No Node-RED flow or existing community rating write is needed.
4. Prepare a reviewed systemd unit using absolute Node/bundle paths, `User=padlhub-jump-live`, `Restart=on-failure`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=` only the private results directory. Configure `JUMP_PUBLIC_ORIGIN=https://padlhub.su`, exact community ID and private results path via a root-owned environment file. The service stores profile IDs privately; keep directory mode 0700 and receipts 0600. Back up receipts according to the agreed 48-hour retention; do not restore foreign-community receipts into an active directory.
5. Prepare only a new same-origin `/jump-live-api/` location proxying to that loopback listener, preserving the path and exact browser Origin. SSE needs buffering off, an appropriate read timeout and an idle keepalive strategy. Retain existing LK/Tilda/Node-RED routes. Run `nginx -t`; inspect remote preimage and rollback diff before any approved reload. Headers and logs must not capture Authorization, run capability or request bodies.
6. With explicit topology activation approval, install immutable artifacts, start only this unit, apply the reviewed new location and reload nginx. Verify local health and exact public hashes, then authenticated real-member entry, wrong-member rejection, real phone permission/tilt/pause/retry/full finish, durable result after restart, and one shared live screen. Synthetic 12-player layout checks do not substitute for this acceptance.
7. Retain old static URL unchanged. Recovery: remove/disable only the newly introduced proxy location and stop the dedicated service after taking required receipts; validate/reload nginx with the preserved preimage. Do not delete results, alter existing LK pointers or roll back unrelated services. Mid-run clients must receive an explicit unavailable state and start a new run after recovery.

Until these prerequisites are complete, use the existing standalone URL for phone gameplay, and label the timed race/live wall as a local candidate.
