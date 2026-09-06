# Piter: update of installed atomic topology

## Guarded-start source increment, 2026-09-06

Direct user authorization covered exactly this runbook, the existing deferred
manager/test and the existing private activation proposal. Source-only work;
NO actual PM2/start, deployment, activation, provider/DB writes, push or merge.
This section supersedes earlier statements that guarded-start was not implemented.

The existing manager now accepts optional `--guarded-start` only with
`--apply --action activate`, an exact future start-action phrase and a separately
issued fixed root-private grant. Default behavior never starts a process.
Read-only actions, seed, deactivate and ALREADY_APPLIED cannot enter start.
The unchanged strict tools and separate exact-two DEFERRED contract are retained.
Piter stays 50 available / 100 displayed; this is not +50 or fake payment. HUB
new-sale closure and the expanded graph are not modified by this increment.

### Fixed inputs and process boundary

The future release owner must produce, not this operator:

- `/root/.node-red/.padlhub-piter-only-start-grant.json`: exact 23-field grant
  defined in `assertDeferredStartGrant`, including preimage/mutation/full-C,
  contract/host/Mongo/flow/publication/lease/PM2-definition/fresh-four digests,
  revision transition, quiescence proof digest and expiry.
- `/root/.node-red/.padlhub-piter-only-quiescence.json`: separate protected
  release-owner attestation, exact `assertDeferredQuiescenceProof` schema.
  Digest, real target/preimage/lease/process binding and short expiry are verified
  repeatedly. It records the owner's external-writer exclusion and reviewed
  writer-inventory digest; it is NOT independent proof from holding flock.

No CLI/env path overrides or automatic grant/proof generation are provided.
`activationAt` is an authorized logical mutation timestamp, not measured CAS
completion time: grant.createdAt <= activationAt <= real clock, age <=60s,
activationAt >= packet.createdAt. It is used only for the two mutation timestamp
fields so a grant can pin exact full C before execution. All custody, deadline
and freshness checks use the real clock. No provider/history timestamp is changed.

Full C and all custody/fresh four-bundle evidence are reread after CAS, under the
same process-owned flock. A fixed consumed intent is published by exclusive temp
0600/file-fsync/readback/link-no-replace/directory-fsync before dispatch, followed
by another complete check. Intent/result and their `.pending` siblings block
reuse; they are retained on failure, never automatically removed or overwritten.

The future command adapter pins root-owned Node/PM2 paths and uses a minimal
environment (`HOME`, `PM2_HOME`, `PATH`, `LANG` only); operator Mongo credentials
are not forwarded. Process configuration digest includes executable/interpreter,
cwd/args/environment and lifecycle options. Two seconds is the fixed command
timeout; at least nine seconds must remain in all evidence/grant/lease windows
at the final dispatch boundary, rechecked after executable custody. This is not
a guarantee that a PM2 daemon cannot finish an ambiguous request later.

Success requires acknowledged command, exactly one online process with expected
definition and exactly one counter increment, then successful custody checks,
then a final identical online observation before deadline. A nonzero/timeout,
even followed by one stopped observation, is UNKNOWN after dispatch. There is
no automatic retry, restart, stop, deactivation or rollback.

### Durable results and recovery

Fixed files: `.padlhub-piter-only-start-consumed.json` and
`.padlhub-piter-only-start-result.json` under `/root/.node-red`.
Result is STARTED (observed process only), UNKNOWN, or START_NOT_DISPATCHED for
a failure before the adapter call after intent consumption. Every result keeps
`salesOpeningVerified:false` and `retryAuthorized:false`. A crash/partial intent,
failed result fsync, UNKNOWN, or a CAS completed before intent publication needs
read-only evidence preservation and a NEW separately reviewed recovery operation.
Normal activate replay cannot start an already-active ledger.

### Evidence and outstanding gates

31/31 local tests passed, including purely synthetic guard/process/filesystem
tests and the existing opt-in private historical contract fixture with in-memory
Mongo/process adapters. No physical DB or PM2 was started. Scoped lint passed.
Full application build/gate was not run in the reserved heavy-resource slot.

NOT_BOUND_CURRENT_ENV: installed PM2 script/dependency provenance, effective
userDir/flow mapping, actual start counter behavior, genuine current provider
and binding snapshots, external-writer exclusion, root-private grant/proof and
publication custody remain future read-only/release-owner gates. Full upstream
and dependency release checks remain necessary. This packet is not execution-ready
and source permission does not authorize any of those live transitions.

## Current local DEFERRED operator amendment

This section supersedes the strict-only activation requirement below for the
separately approved LOCAL implementation; older tuples and results remain
historical and do not authorize execution.

The separate `piterDeferredActivationContract` / `piterDeferredLedgerOperations`
and prepare/manage deferred entrypoints preserve exactly two pinned historical
refund exceptions as DEFERRED. They do not alter provider or legacy records,
normalize timestamps, or fabricate a strict PASS receipt. All five existing
strict activation/reconciliation files remain byte-identical. Cash-paid P and
provider-only free issues remain distinct; target adjustment is 50-P, P<=50.

The new contract pins expanded Piter-only candidate
`5b098143325f249eb466f76ad76776a97f54b3c90e51b6c11eac3e8a62d29be8`
and forward graph contract
`ed9c5904ed27348a63b6a680835af261a072bb136c19ae3e130481ca5bcf9d43`.
This is NOT the historical standalone two-function candidate below.

Prepare consumes seven private input envelopes/claims and emits a new private
packet with current clock only. Manage defaults to dry-run. Its future apply
path requires already-stopped Node-RED, root custody and the held shared flock,
exact lease/flow/publication, whole canonical BSON A/B/C comparison and a durable
backup before one majority+journal/no-upsert write. It never stops, starts or
restarts Node-RED and returns `startAuthorized:false`.

Activation additionally requires `--activation-recheck-file`: an exact bundle of
providerEvidence, subscriptionEvidence, productEvidence and bindingEvidence,
each genuinely captured after packet creation and no more than 15 seconds old.
Do not retimestamp old context data. Canonical raw Mongo evidence must be
captured with BSON types preserved; JSON-only snapshots cannot establish that
custody. Fixed `/root/.node-red/.padlhub-piter-only-release.json` must be a
root-private descriptor matching the packet's canonical stable-JSON SHA256 and
all nine installed transitive script hashes. A packet claim alone is insufficient.

Local evidence: 21/21 opt-in historical-fixture tests passed, including installed
dependency-publication drift, freshness measured after prewrite custody reads,
and a successful exact postread delayed beyond external snapshot expiry. After C,
stopped-runtime/publication/flow/lease custody and exact postimage still apply;
external snapshot expiry alone does not turn a successful mutation into failure.
Scoped ESLint passed. These are local adapter
and contract checks, not physical Mongo/provider or production UI proof.

Launch remains BLOCK / NOT_BOUND_CURRENT_ENV: safe start must hold the same lock and recheck exact
flow/sentinel, live lease, publication and fresh external bundle immediately
before start. The prior seed/CAS scope does not include that new process-control
entrypoint. Subsequent coordinator assignment passed read-only feasibility
review, but the system rejected implementation without direct authorization
in this task: WAITING_SYSTEM_APPROVAL. No start code was added or rejection
bypassed. The safe design additionally needs a bound PM2 process-definition
digest, exclusive durable consumed intent and outcome, sanitized command env,
exact single counter transition and no replay/automatic recovery. Quiescence ownership, fresh collectors,
operator publication and packaged Mongo/BSON compatibility also remain required.
Do not seed/activate and then manually start Node-RED using stale evidence.

## Piter-only source admission

The user's scope is Piter only, with 50 available out of the first batch of 100.
The subsequent local variant preserves the current e38 live baseline's closed
HUB new-sales admission. It restores network_friendship to the existing purchase
prepare/limit blocked sets, uses that set before either emitting/accepting status
readiness, and denies only exact new-purchase continuation steps in the purchase
and atomic routers. No configurable bypass or generic flag framework is added.

Late provider results, confirm/reconciliation, paid-pending instance binding,
projection readbacks and durable dispatch-fence repair remain available. The
runtime suite covers HUB scheduled repair and late provider results as well as
Piter schema1/schema2 recovery. A stale purchase reserve may leave CLAIMED data
when admission closes; no automatic release/cleanup is introduced. Fresh custody
and quiescence still precede any deploy or rollback.

Previously open-HUB status/new-checkout tests now assert release closure. Historical
paid settlement tests use explicit durable record fixtures instead of creating a
new HUB sale as setup. Existing recovery/confirm/binding assertions remain active.
Source fingerprints are updated as local topology/UNBOUND metadata only. Earlier
1c396/f925 artifacts and all frozen deployment/activation pins remain historical;
the Piter-only source must receive its own reviewed candidate, not repurpose them.

## Integrated-source hold

The tuple and successful candidate checks below describe the standalone Piter
checkpoint `7fa16cd39e9c8027943fde5174e5c5587e247bcd`, not the merged source.
After combining it with main `00f9db4135f26664019fa718b833d71698f24241`, the
regional HUB/CUP graph, dispatch generation fencing and Piter quota logic are
preserved together. This merged source is NOT a deployable two-function update.

The frozen updater intentionally rejects the integrated replacements with
`replacement digest drift`. Do not advance its pins merely to make it pass.
The source-only topology fingerprint and unbound status amendment are not a
runtime binding. The main runtime composition additionally requires purchase,
limit, confirm and reconciliation functions, status/confirm wiring and a CUP
readiness request node. That broader shared graph needs its own owned release
scope, exact fresh-source contract, reviews and publication authority.

Local integrated checks before the status HTTP fix: 213 PASS, one Linux-only lock
test SKIP; lint has zero
errors and 387 warnings; inert prod/dev build including TypeScript passes.
The plain artifact has no Git release provenance and is not production configured.
No integration ref, publication, lease, provider or database mutation follows
from these checks. Skipping historical reconciliation is not a successful
reconciliation receipt and does not satisfy the activation guard.
`nodered:modular:validate` cannot run without the required `--workspace` and its
prepared private graph build; no integrated graph validation is claimed here.

The first expanded local graph candidate (`aedd146...`) was retained as blocked:
review reproduced false HUB status readiness for HTTP 500 with a valid ready body.
The subsequent narrow local correction requires an integer numeric HTTP 2xx,
no transport error and the existing exact body/binding checks. It also uses
`msg.requestTimeout` on this CUP status request only, matching the installed
Node-RED 4.0.9 core HTTP node and its upstream contract. Existing timeout arithmetic
is preserved (missing configuration resolves to the 3000 ms lower bound).
The affected runtime suite passes 115 tests, including error/status and timeout
field regressions. Real elapsed-time/transport behavior remains NOT_RUN.
The status source amendment is updated only as UNBOUND metadata; frozen
deployment/activation pins are not changed. Shared HUB scope and rollback data
quiescence remain publication gates regardless of this status fix.

## Scope and state

Local preparation only. No publication, restart, lease mutation, reconciliation
write, seed or activation is performed by this builder. Managed usage stays off.

- Exact source: `e38f844343ef290aa49f2583861dfc4488031b97d303ccbe36b3a5e12c292ec3`.
- Exact candidate: `650a76ba68b196808663102423c83cbe6ae9db1c69eca6669fc25b0f969e8841`.
- Exact graph contract: `b92fb84d6f95472d3ac07c688a4bf8528a8584aa7021b48145a4593ff05131a8`.
- Node count stays 4768; all 215 HTTP inputs are unchanged.
- Only `func` changes for `c165e43eba668c25` (subscription status) and
  `piter_atomic_router_20260903` (atomic purchase router).
- All other nodes, order, topology, credentials/config and unrelated fixes stay
  identical to the fresh source. No nodes are added or removed.

The fixed tuple is a reviewed local input/output contract, not evidence that the
server still has those bytes. Any source drift requires renewed inspection and
review; the CLI has no hash/target override. Do not use the old initial installer
over the existing atomic graph.

This supersedes the unpublished 7775475... -> 8cc76ed... candidate. The fresh
source includes the completed `subscription-create-preflight` deployment, whose
three function changes (`8f7bd5b482fe9763`, `lk_subscription_booking_router_20260804`,
`lk_subscription_booking_finalize_20260804`) were independently compared and are
preserved exactly. Its historical terminal receipt is not a fresh lease check.

## Local preparation

Use the existing read-only pull into a NEW private directory outside Git, then:

```text
node scripts/prepare_piter_atomic_quota_update.mjs --workspace /absolute/fresh-private-workspace
```

The builder requires verified live-147 origin, exact SHA and freshness <=30 min.
It writes `build-piter-quota-update/{candidate.flow.json,reviewed-flow.contract.json,report.json}`
with directory 0700/files 0600. Existing output is rejected, including partial
output after an interrupted write. Do not overwrite it; retain and use a fresh
workspace. The full flow contains private configuration and must stay outside Git.

Function preimages/replacements and whole-flow hashes are pinned. The existing
exact-graph validator proves two `func` changes only and the structural reverse
back to the exact fresh source. This is not a physical rollback or Mongo test.
The activation report supports equal node counts only for this exact update tuple,
with explicit `--initial-batch-remaining 50` and packet V2. Other equal-count or
drifted update identities fail closed. Legacy V1 initial-install packets retain
their existing contract.

## Required gates before any later live operation

1. Preserve single source ownership and obtain one coordinated publication window
   with the ab_leto/shared-subscription owner. Never mix a stale initial installer
   or all-bundle frontend deployment into this focused backend update.
2. Follow repository integration/push/CI/deploy approvals. Produce the release
   package from the confirmed clean pushed revision, not this local preview.
3. Re-read exact live flow, deployment lease/runtime state and scoped database:
   sentinel must still be absent and atomic attempts absent before this launch
   preparation is used. An already-active schema1 sentinel remains runtime-compatible
   and invalidates that assumption. Stop on any conflicting write or drift.
4. Install only the exact reviewed flow under the normal shared lock/lease helper
   after explicit deploy authority. The deployment family remains
   `piter-atomic-sales-20260903`; exact SHA pairs, timestamped backups and fresh lease
   distinguish this update from the earlier installation. Never reuse old backup
   paths or expire/remove somebody else's lease to make progress.
5. Fresh reconciliation is still mandatory. Two historical refunds currently fail
   the strict cross-record timestamp equality check even on canonical provider GETs.
   The provider timezone/precision contract is unresolved. Do not guess timezone,
   rewrite evidence timestamps or reuse an old candidate's reconciliation receipt.
6. Only after that blocker is resolved may a fresh packet and explicitly approved
   reconciliation/seed/activation run under their own guards. Seed is inactive;
   activation is a separate DB transition. A flow update alone does not open sales.

## Operator dependency packaging

The new `scripts/lib/piterAtomicQuotaUpdateContract.mjs` is a runtime dependency
of `piterAtomicActivationContract.mjs`. Include it with all transitive dependencies
for the packet builder, ledger operator AND legacy reconciliation operator.
Verify the packaged operator dependency closure and hashes before any live stage;
this local candidate does not provide or authorize a server operator installation.

## Recovery boundary

The only structural restore source is the exact e38f844... snapshot, not the
older pre-atomic source. `structuralReverseCheckPassed=true` and
`rollbackAuthorized=false` are intentional. Before restoring code, use the
existing data-aware rollback precheck and approved recovery procedure. Once a
schema2 sentinel or attempts exist, do not assume the old schema1 runtime can
continue them; deactivation/quiescence/data custody must be proven separately.
This builder neither clears data nor rewrites the sentinel.

## Checks

- New updater, activation/reconciliation, topology, reviewed-flow deploy and
  purchase runtime suite: 174 PASS, 1 Linux-only SKIP.
- Full inert prod/dev build including TypeScript: PASS; not production configured.
- Lint: 0 errors, 387 existing warnings; exact diff check PASS.
- Independent release/custody and payment-compatibility reviews: PASS.
- Actual local candidate from fresh live snapshot reproduced the tuple above;
  production publication/DB activation/browser purchase remain NOT DONE.
