# FPR canonical start levels and correction dry-run

Owner: LK tournament hosting; audience: staff running official/manual FPR events.
New protocols freeze personal levels from CUP, independently of community League
points and places. Existing protocols retain their original frozen settings.

## Loading and creating a new protocol

`POST /lk/tournaments/fpr/start-ratings` accepts `{ clientIds: string[] }` with
1–28 unique exact client IDs. It verifies the caller through the existing fixed
Viva profile endpoint and requires the global `проводит турниры` permission.
This is the same staff authority used by participant refresh; community membership
is not required for newcomers or manual rosters.

Levels come exclusively from `player_rating_state` with `CUP_CANONICAL` ownership.
There is no Viva rating fallback, community snapshot fallback, bootstrap, index
creation, or canonical write. Missing/ambiguous identities and invalid levels fail
the complete batch. Recorded aliases are used only as canonical identity evidence;
names and phones are never lookup input. The response contains requested IDs,
full-precision numeric levels, and opaque source versions. Ledger event IDs may
contain historical identity aliases and are therefore not returned verbatim.

The setup form retains League points/place editing; the personal start level is
read-only. Its complete source snapshot is included in `params.fprCanonicalStart`.
Immediately before insert, a staff-authenticated server guard re-reads the same
canonical states and verifies both level and source version. A stale snapshot
returns 409; the client refreshes the roster snapshot. Ordinary tournament create
keeps its existing path and request authentication behavior.

## Offline Node-RED candidate

`scripts/patch_fpr_canonical_start.mjs` only creates a local candidate and report:

```sh
node scripts/patch_fpr_canonical_start.mjs INPUT CONTRACT NEW_CANDIDATE NEW_REPORT
```

The contract binds the exact flow hash and full node preimages for the create
route, existing FPR prepare function, and Mongo client. The candidate adds a
staff-authenticated read and the FPR create guard, preserving the existing prepare
body and ordinary-create behavior. Input/outputs must be distinct, outputs new.
The patcher has no deploy/import/restart operation. Full production flows and
credentials must stay on the server or in an explicitly authorized private workspace.
The same patch function can be checked in memory on the server with embedded
source functions; export only the redacted report and hashes.

Activation needs a separately authorized coordinated backend/frontend release:
an old client cannot supply the required CUP source snapshot. Do not publish the
frontend while the new read endpoint is absent. Rollback must preserve the guard
or stop new FPR creation; never silently restore a Viva fallback.

## Historical read-only preview

```sh
node --experimental-strip-types scripts/dry_run_fpr_canonical_starts.mjs \
  --root PROTOCOL_ID --flow PRIVATE_FLOW_PATH --out NEW_PRIVATE_REPORT
```

The runner has **no apply mode** and rejects unknown flags, including `--apply`.
It uses a direct Mongo connection and only `find/limit/toArray`. It does not import
worker entrypoints, service initialization, provider delivery, or writer modules.
For an already installed Node-RED Mongo driver, `--mongo-module` can point to that
module. A bundled copy can run through SSH stdin without installing code remotely.

Without historical evidence, missing baselines and equal-time targets remain
blocked. An optional evidence mode reads the original private backfill packet,
archived runtime, original runner, and durable apply receipts on the server:

```sh
node --experimental-strip-types scripts/dry_run_fpr_canonical_starts.mjs \
  --root PROTOCOL_ID --flow PRIVATE_FLOW_PATH --out NEW_PRIVATE_REPORT \
  --backfill-operation PRIVATE_BACKFILL_OPERATION \
  --backfill-runtime ARCHIVED_IMMUTABLE_RUNTIME \
  --backfill-runner ORIGINAL_BACKFILL_RUNNER \
  --backfill-sha REVIEWED_PACKET_SHA256
```

All four evidence arguments are required together. The operation must be a
root-owned private `/root/.padlhub-fpr-level-backfill-*` directory; packet and
receipt files must be private regular files. The loader verifies the pinned
packet hash against both prepared and apply-intent records, all archived runtime
module hashes, the original runner hash, final applied counts, and every numbered
receipt's plan identity, event count and application time window. The packet and
its identities remain on the server. Both read passes recheck the evidence.

The preview:

- finds the transitive downstream FPR cohort through validated canonical aliases;
- reconstructs each start before the frozen `leagueSnapshotAt`, without
  substituting today's level or a stale Viva field;
- recalculates every participant over original closed matches with the installed
  ordinary formula, preserving seeds, pairings, scores and sporting standings;
- retains later ordinary/manual absolute targets and additive game deltas;
- blocks missing baselines, conflicting identities, ambiguous active awards,
  exclusions on the protocol or linked legacy event, and unresolved same-time FPR
  targets, rather than emitting an invented zero or ID-based causal order;
- reads semantic source/current-state/event preimages twice and rejects changes;
- exports player aliases only, with allowlisted error codes and no contacts,
  administrative reasons, or raw driver errors.

## Evidence-backed initial anchors and event order

The initial FPR backfill wrote a canonical
`RATING_BOOTSTRAPPED_FROM_TOURNAMENT` event at first-result time minus one
millisecond. This accepted initial baseline was therefore invisible to a strict
start-time cutoff. Evidence mode can reconstruct its initial anchor when the
original plan had null canonical state and empty history, the immutable bootstrap
and first award match the packet exactly, the first source/frozen input matches,
and there are no earlier applicable events or official appearances. A frozen zero
also requires the originally accepted unrated-start policy and its canonical1.0.
Duplicate, conflicting, orphan or later altered evidence remains blocked.

Only the simulation moves that initial anchor to just before the first frozen
snapshot. The report labels it `RECONSTRUCTED_CANONICAL_INITIAL_ANCHOR`, includes
the original recorded/created times and evidence hashes, and explicitly sets
`observedAtStart:false`. This is not a claim that the CUP state was observed at
that earlier moment. The stored immutable event remains byte-for-byte unchanged.

Restoring old match results can give distinct events the same technical completion
timestamp. Evidence mode resolves a pure group of active FPR absolute targets
using their exact sequence in the verified original `plan.events`, applied by
ordered bulk write and confirmed by the matching receipt. All group events must
match the current immutable ledger. Uncovered corrections, duplicate active
revisions, or another applicable event at the same time block the preview.
Compensated originals and compensation events remain in the installed replay.

The report records `RECORDED_ORDERED_BACKFILL_APPLICATION`; original award IDs,
`occurredAt` and `fprFinishedAt` are preserved. It sets
`actualPlayedAtKnown:false`: the accepted application order is known, while actual
seventh-round play times are not inferred from schedules or recovery-entry time.

`candidateAfter` is a counterfactual, never an applied correction. `applyReady` is
always false: this preview is not a write packet, even when all candidates are
calculated. Missing historical CUP baselines need the verified original evidence
above; the runner never infers them from a stale Viva value. Blocked predecessors
also block dependent downstream results.

Check `summary`, per-protocol statuses, `blockedPlayer`, `blockedFrozenStart`,
and player-level statuses together. A blocked row is unknown, not unchanged.
`reconstructedBaselines` and `temporalResolutions` distinguish verified
reconstruction from observed history; `temporalWarnings` contains unresolved cases.

## Verification and stop signal

Run `npm run test:fpr-canonical-start`, `npm run test:community-rating`, TypeScript,
lint and both build modes. The regression DB double throws on non-read methods.
Any canonical read/auth failure, source drift, or unresolved historical ambiguity
stops that operation. Stopping this dry-run requires no rollback: it never writes
ratings, events, fences, snapshots, indexes, or provider queues.

## Authorized correction application

The separate `apply_fpr_canonical_correction.mjs` runner supports prepare, rehearse,
apply and postcheck. Build it with `build_fpr_correction_runner.mjs`; the bundle pins
the exact nine installed worker formula/replay dependencies. A root-owned private
packet binds the runner, runtime manifest, flow, complete preimages, historical
proof and all 9/74 plans. Prepare does not change database records. It requires the
complete preview and checks every per-source start, match delta and target against
worker output. Multiple roster aliases for one canonical identity stop preparation.

The operation inherits FD9 for the real common worker lock. Both FPR automation
switches must be paused for rehearsal/apply. The installed compatible worker must
be active. Rehearsal executes the same full transaction and aborts; apply requires
its matching durable receipt. One bounded transaction writes all nine top-level
`fprCanonicalStartCorrection` records, immutable compensation/correction events,
reconciliation, 74 canonical/compatibility projections and provider outbox entries.
An error before commit aborts the whole cohort. No provider delivery runs here.

Correction metadata binds the original rating inputs and legacy exclusions. The
worker clones the original frozen protocol and substitutes starts only in memory.
Corrections use that approved start as their displayed before value. Receipt-backed
relative order resolves the pure equal-time target group without changing timestamps.
A stale correction becomes a protected ambiguous source; it never falls back to the
old frozen input. Host timestamps and broadcast metadata do not invalidate it.

Postcheck verifies original and appended immutable events, all current/compatibility
states, exact correction metadata, unchanged sports inputs and zero retry events,
then refreshes the nine display projections. Keep dispatch paused until it passes.
A lost commit acknowledgement is recovered by postcheck, never by blindly repeating
apply. Packet and receipts stay on the server. After commit, recovery must retain a
correction-aware runtime; an old module rollback would reintroduce the defect.
Data reversal requires reviewed compensating events, never deletion of the ledger.
