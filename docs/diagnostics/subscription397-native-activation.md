# Subscription397: two-router native activation on147

This adapter applies the merged #392/#397 pagination and date-reason edits to
exactly two existing `func` fields. It uses the original authenticated editor
Deploy modified nodes request. The root controller never calls an API, writes
flows.json, copies tokens, invokes injects or restarts PM2. Wire topology,
initialize/finalize, libs, all other fields and native node order are preserved.

Build assets from a clean pushed commit with successful matching CI:
`node scripts/build_subscription397_native_assets.mjs PRIVATE_EMPTY_0700_DIR SHA`.
Public snippets come from the merged source. No production source is in these
assets. Stage all manifest files except local `browser-guard.js` and
`editor-readback.js` under root-owned0700
`/root/.node-red/.padlhub-subscription397-stage-YYYYMMDDTHHMMSSZ-NUMBER`, with
0600 files. Compare all hashes; browser-guard.js is created exclusively by begin.

The fixed IDs are `lk_subscription_booking_router_20260804` and
`lk_subscription_price_preview_20260908_router`. `beforeFunctionSha256` and
`afterFunctionSha256` seal the ordered pair of ID/function hashes, rather than
one function. Every edit has an exact inverse. This deployment requires both
pagination edits still absent: partially installed or repeated source refuses.
Use the existing history composer separately to verify the actual candidate.

Read `inspect` metadata, independently review fresh source/delta, and freeze
explicit whole-source, runtime-identity, code, node-count and full-two-target
node hashes before prepare. Never automatically bless an observed hash. CLI:
`node STAGE/scripts/nodered_reviewed_flow_deploy/subscription397_native_operation.mjs ACTION STAGE`.
All actions share the established flock. The v6/subscription397-native-nodes
lease is intentionally incompatible with prior helpers. Foreign or unknown
leases remain untouched. An expired matching v2 soak handoff is backed up first.

In one dedicated authenticated editor tab through the verified existing18801
tunnel, install the generated reader and call `__subscription397Readback()`.
It uses the editor's existing AJAX auth, returns only seven safe metadata fields
and retains the full native snapshot privately. Clean editor, stable editor
revision and full GET required. Actual request acquisition may take120seconds;
completed-body metadata is fresh for30seconds. No cached/partial/disk substitute.

`prepare` accepts `{expectedSourceSha256,expectedTargetSha256,expectedCodeSha256,
expectedNodeCount,expectedTargetNodesSha256,sourceCommit,native}`. It backs up
source/candidate/plan durably. `reserve` accepts the resulting plan hash, fresh
PRE metadata and `RESERVE_SUBSCRIPTION397_NATIVE_NO_RESTART_147`. `begin` takes
fresh PRE metadata and creates an exclusive one-attempt record plus5minute seal.
Arm through `__subscription397Readback.install(seal)`, then make the editor dirty
without changing graph and use native Deploy modified nodes once. The guard
validates the independent editor serialization, but forwards the captured
native snapshot with only the two func substitutions; original auth is neither
read nor replaced. All other writes/fetch mutation are blocked.

After actual HTTP200 ACK, perform a fresh full native GET. `confirm` binds the
plan, attempt, audit, actual HTTP status/ACK time and readback, then starts a full
900second soak. Finish requires a new GET whose request starts after the soak
deadline, unchanged runtime identity/disk/revision and matching ACK. Successful
finish writes a durable receipt before releasing only its own lease. The
controller does not replace operator runtime/log checks: verify no router
exceptions/new errors and unchanged PM2/inject/provider/DB instances before finish.

Timeout/409/lost ACK never authorizes a repeated POST or lease deletion.
`reconcile` returns PRE/POST/UNKNOWN only. Exact POST can be adopted explicitly
with `ADOPT_OBSERVED_SUBSCRIPTION397_POST_NO_REPLAY_147` and its exact new revision;
this starts a new full soak without fabricating ACK or replaying Deploy.
Before begin, `abort` needs exact PRE and is receipt-first. After begin it refuses.

The inverse uses a fresh dedicated tab/reader, a separate rollback attempt and
the captured exact candidate. `rollbackReserve` requires
`ROLLBACK_SUBSCRIPTION397_NATIVE_SOURCE_NO_RESTART_147`; rollbackBegin returns an
inverse seal. rollbackConfirm records actual ACK and starts a full soak;
rollbackFinish requires fresh restored source, unchanged identity and full soak.
Lost inverse ACK uses explicit
`ADOPT_OBSERVED_SUBSCRIPTION397_SOURCE_NO_REPLAY_147`, never a retry. All unknown
graphs/foreign changes retain custody. Do not use the generic PM2-restarting
rollback. Worker must be stopped and its processing state handled before any
inverse backend operation; code rollback cannot undo a provider cancellation.

Pin the worker to actual post-deployment disk bytes, not the preparer's JSON
serialization. Exact graph/order match does not imply equal file-byte hash.
Keep MAX paused and all unrelated startup/external jobs unchanged.
