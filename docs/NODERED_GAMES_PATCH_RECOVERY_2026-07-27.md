# Games PATCH source recovery — 2026-07-27

## Scope

This cohort brings the tracked source for active Node-RED function
`Prepare game patch` (`e0d7883bc1a9fa8c`) into byte-identical alignment with
the current live function. It does not change production behavior.

The only proven HTTP inputs are:

- `PATCH /lk/games/:gameId`
- `PATCH /lk/games/records/:gameId`

Both terminate in the same four-output function. Its complete reachable graph
has 19 nodes, including the Mongo update, HTTP response/debug outputs, and
autojoin probe chain.

## Fixed preimage and guard

- Live flow SHA256: `d9f84e4fd6b087752dc810b9fc247e3d532cc6580c19a4a822f2111ddebeca4c`
- Node count / HTTP route count: `4617 / 203`
- Target function SHA256: `cd19171a18ec18a553418d5b1725bab50ee1df2788e5160143430aaeb758c8ad`
- Tracked source: `scripts/nodered_games_nodes/fn_patch.js`
- Guarded constructor: `scripts/patch_live_games_patch.mjs`

The constructor requires a fresh private live workspace, validates the full
preimage, route and reachable-node hashes, then permits only exact source
normalization. It rejects topology/configuration drift and writes an atomic,
private external candidate plus redacted report. It never imports, deploys, or
restarts Node-RED.

```bash
npm run nodered:modular:pull-147 -- /private/tmp/lk-games-patch-live-YYYYMMDD
node scripts/patch_live_games_patch.mjs \
  --workspace /private/tmp/lk-games-patch-live-YYYYMMDD \
  --output /private/tmp/lk-games-patch-publication/candidate.json \
  --report /private/tmp/lk-games-patch-publication/report.json
npm run test:games-patch-recovery
```

## Explicit holds

The dirty checkout contains extra PATCH behavior which must not be folded into
the source-alignment cohort:

1. suppression of client-provided cancellation state;
2. rebuilding `resultRosterSnapshot` during PATCH;
3. bounded `$push` writes to `audit.events`.

These alter persistence and API behavior. In particular, the existing live
PATCH contract currently accepts cancellation fields and uses only `$set`.
Each requires separate caller authorization, result-session compatibility, and
Mongo-write review before it can become a production candidate.
