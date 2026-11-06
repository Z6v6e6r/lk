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

The preview:

- finds the transitive downstream FPR cohort through validated canonical aliases;
- reconstructs each start strictly before the frozen `leagueSnapshotAt`, without
  substituting today's level or an unrecorded historical baseline;
- recalculates every participant over original closed matches with the installed
  ordinary formula, preserving seeds, pairings, scores and sporting standings;
- retains later ordinary/manual absolute targets and additive game deltas;
- blocks missing baselines, conflicting identities, ambiguous active awards,
  exclusions on the protocol or linked legacy event, and unresolved same-time FPR
  targets, rather than emitting an invented zero or ID-based causal order;
- reads semantic source/current-state/event preimages twice and rejects changes;
- exports player aliases only, with allowlisted error codes and no contacts,
  administrative reasons, or raw driver errors.

`candidateAfter` is a counterfactual, never an applied correction. `applyReady` is
always false: this preview is not a write packet. Missing historical CUP baselines
need evidence or an explicit historical-baseline policy before a repair can be
prepared. Such a policy is not inferred from a stale Viva value, even for an old
unrated appearance. Blocked predecessors also block dependent downstream results.

Check `summary`, per-protocol statuses, `blockedPlayer`, `blockedFrozenStart`,
and player-level statuses together. A blocked row is unknown, not unchanged.

## Verification and stop signal

Run `npm run test:fpr-canonical-start`, `npm run test:community-rating`, TypeScript,
lint and both build modes. The regression DB double throws on non-read methods.
Any canonical read/auth failure, source drift, or unresolved historical ambiguity
stops that operation. Stopping this dry-run requires no rollback: it never writes
ratings, events, fences, snapshots, indexes, or provider queues.
