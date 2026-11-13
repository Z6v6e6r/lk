# Prepare MAX delivery for new outbox messages only

`scripts/nodered_max_outbox_resume.mjs` is a pure offline source patcher. It has
no deployment CLI, file writes, network access, credentials access or queue mutation.
It prepares both existing MAX bot channels together from an independently reviewed,
fresh private full-flow snapshot. Never commit the snapshot, candidate or private pins.

## Prerequisites for live use

The source patcher cannot distinguish old and new queue rows. Before activating the
candidate, the release owner must durably hold **every pre-cutover nonterminal row**
for both MAX connectors, preserve its original fields for later review, and verify
that the pull API cannot lease those held rows. Old pending, retryable failed and
leased rows need explicit handling. A queue count or timestamp filter alone does
not prove complete membership. Keep old messages unsent; this module does not
approve replaying them. Cutover requires a reviewed race/lease strategy and durable
membership evidence; producing this candidate does not satisfy that prerequisite.

Also confirm active runtime/disk parity, the exact candidate contract, matching
rollback preimage, sender/ACK behavior and MAX module initialization behavior in
an isolated rehearsal before an authorized apply. Receiver nodes remain disabled;
this source change does not enable incoming provider polling or callbacks. Config
initialization side effects must be assessed separately from graph enablement.

## Pin contract and output

Import `buildMaxOutboxOnlyResume`, `MAX_OUTBOX_RESUME_REQUIRED_IDS`, `sha256` and
`nodeSha256`. The first argument accepts the raw UTF-8 flow string/Buffer, or a
JSON-compatible array. Operational preparation should use the original raw bytes.
For a string/Buffer, `flowSha256` is SHA256 of those exact bytes, including whitespace.
For an array it is SHA256 of `JSON.stringify(flow)`. Each `nodeSha256[id]` is SHA256
of `JSON.stringify(node)`, preserving parsed object property order.

The second argument is an independently approved object:

```js
{ flowSha256: '<64 lowercase hex>', nodeSha256: { '<required ID>': '<64 lowercase hex>' } }
```

The node pin map must contain exactly the exported required IDs. Derive and review
these fingerprints in a private workspace; do not automatically trust changed
source by regenerating pins inside an apply operation. Fixed channel/node IDs and
connector relationships are also checked independently of the supplied hashes.

The return value is `{ flow, candidateJson, sourceSha256, candidateSha256,
changedIds, addedIds }`. `candidateJson` is the full candidate array serialized
with two-space indentation and one trailing newline; its digest is
`candidateSha256`. The input and trusted pins are never modified. Writing the
candidate, building a deploy contract and applying it belong to the release owner.

## Bounded topology change

Exactly four existing nodes change: the two `Poll MAX outbox` inject nodes receive
`d:false`, and the two `Prepare MAX dispatch` functions route their successful first
output to their channel's new dedicated sender. Their error outputs stay identical.
The new IDs are `max_new_outbox_send_academy` and `max_new_outbox_send_main`.

Each new `maxbot-send` node copies its corresponding old shared sender, changing
only ID, name and `d:false`. Bot config, ACK/debug output wires and all other
fields stay identical. Both old shared senders, both receivers and both callback
functions retain `d:true`; direct-response branches remain attached to disabled
shared senders. All function bodies, config nodes, environment and credentials
remain unchanged. The endpoints remain the existing connector-specific
`GET /support/outbox/pull` paths and existing outbox ACK paths.

Preparation rejects full-flow/node fingerprint drift, duplicate or missing IDs,
unknown MAX send/receive nodes, occupied or already-referenced new IDs, unexpected types/disabled states,
tab changes, connector swaps and unexpected dispatch or sender wires. It is not
idempotent: an already-prepared candidate is rejected rather than reused silently.
No tracked import/export or modular full-flow artifact is generated.

## Offline verification

```bash
node --test scripts/tests/maxOutboxResume.test.mjs
```

Synthetic tests cover the exact four-edit/two-add delta, preservation of old direct
branches and function bytes, immutable inputs, exact fingerprints, missing/duplicate
IDs, extra MAX nodes, new-ID collisions, config/wire drift, connector swaps and
disabled-state failures. They do not perform real sends or prove live queue holds,
provider delivery, active graph parity or rollback execution.

## Prepare the coupled unpaid-cancellation worker

The active unpaid-cancellation worker pins the entire Node-RED disk flow, its
business gateway function and its runtime binding. Even this bounded MAX change
requires a new compatible worker generation. Its service entrypoint has no flow
hash override or live rebind endpoint. Never edit installed constants or bless an
observed flow automatically.

`scripts/nodered_max_outbox_worker_rebind.mjs` provides the pure in-memory
`buildMaxOutboxWorkerRebind(options)` preparation function. It reads no files or
tokens, makes no network requests, and performs no installation or process action.
The options are:

```js
{
  beforeFlow,                 // original raw Buffer or UTF-8 string
  trustedNrPins,              // independently reviewed MAX patcher pins above
  baselineManifestBytes,     // exact installed schema-1 manifest as a Buffer
  baselineFiles,             // Map: the exact 13 bundle paths -> Buffer bytes
  trustedBaseline: { manifestSha256, sourceCommit, guardSha256 },
  publishingSourceCommit,    // distinct 40-character lowercase Git SHA
}
```

Obtain only the non-secret installed manifest and reconstruct the 13 public
payload files from that exact Git source commit. Each reconstructed byte sequence
must match its installed manifest digest; current checkout business sources are
not substitutes. The complete fixed closure comes from the standard bundle
builder/verifier and includes package/lockfile, unit, entrypoints, auth module,
cursor and business modules. Missing/extra paths, unsafe paths, foreign source
identity, file digest mismatches and untrusted manifest/guard bytes fail closed.
For the observed baseline, the generation is commit
`74f59966d32556ee8645cd352923124eeca69ac3`; actual baseline pins must still be
independently supplied and freshly checked by the release owner.

The builder invokes `buildMaxOutboxOnlyResume` and verifies the exact four-edit,
two-add delta again. It requires the old guard's single named whole-flow constant
to equal the raw before-flow digest, and its single named gateway constant to
equal the unchanged `lk_subscription_booking_router_20260804` function digest.
It derives the new disk digest using Node-RED 4.0.9 pretty storage encoding:
`JSON.stringify(candidateFlow, null, 4)`, **no trailing newline**. It changes only
the 64 ASCII digest bytes in `LK1_UNPAID_FLOW_SHA256`. Gateway, binding checks,
mtime checks and every other byte of that file stay equal; the other 12 payload
files stay byte-identical.

The result contains `candidateFiles` (a new Map of independent Buffers),
`candidateManifest`, `candidateManifestBytes`, `candidateManifestSha256`, and
separate `provenance`. The manifest retains standard schema 1 with only
`schema`, `sourceCommit` and `files`. Provenance records the baseline commit and
manifest/guard hashes, publishing commit, raw before-flow digest, native candidate
disk digest, unchanged gateway, four changed/two added flow IDs and the sole
changed payload path `lib/lk1LiveGatewayGuard.mjs`. Keep provenance separately;
do not add it to the runtime manifest or the strict payload file closure.

This is preparation, not activation. Verify pushed source and CI, actual native
disk encoding, active graph equality, unchanged gateway/credential binding and
the complete immutable bundle. Live handling must preserve mode, tenant, cohort,
cursor, permanent flow-read auth and all pending intent/job/lock records. Hold
the reviewed-flow custody while stopping/draining the worker, applying the exact
hot graph change and rebinding a fresh worker to its exact mtime and PM2 identity.
An inverse requires stopping the worker and restoring matching flow/worker
generations, with a fresh binding to the restored mtime. Never reset cursor or
replay an ambiguous cancellation. Observe a full 120-second worker cycle and the
required 15-minute soak before declaring the coupled release healthy.

```bash
node --test scripts/tests/maxOutboxWorkerRebind.test.mjs
```

Synthetic checks prove the one-file digest substitution, native disk encoding,
standard manifest shape, exact baseline closure and rejection of manifest/file/
source/gateway/flow drift, duplicate constants, unsafe paths and invalid publisher
identities. They do not prove live idle state, drain completion, provider outcomes,
current-pointer custody, active graph equality or actual Node-RED serialization.

The source check rejects dangling wire/link references to a future sender ID, so
adding that sender cannot revive an unrelated pre-existing route. The release
owner still verifies catch/status scopes against the complete pinned graph.
Existing legacy FAILED rows remain terminal; no reset or retry is part of the
new-only cutover.

## Scoped native operation and inverse

The `max_outbox_*` modules under `scripts/nodered_reviewed_flow_deploy/` prepare
root custody and a source-preserving, one-attempt browser guard. They never call
`/flows`, write the live flow, read a token, restart a process or send a message.
They reuse the global reviewed-flow OS lock and protected v4 lease. Do not reuse
the specialized function98/subscription/pause guards for this different delta.

The reader uses the editor's existing authenticated AJAX GET and retains its raw
snapshot in a private browser closure. Only graph/order/revision fingerprints and
timestamps leave the closure. The guard forwards the editor's one native POST in
modified-nodes mode, rebuilding the exact four edits and two clones from the full
GET snapshot. Lossy editor serialization cannot replace opaque node/config fields.
A stale revision, changed editor serialization, deadline, extra write or repeat
attempt refuses the request. Lost ACK retains custody for fresh read-only
reconciliation; no Deploy replay or automatic adoption is permitted. Finish needs
a fresh GET beginning after the full 15-minute soak and the same PM2 identity.

`nodered_max_outbox_inverse.mjs` and the `max_outbox_inverse_*` modules restore
only the exact forward postimage to its protected original backup. The inverse
rejects foreign nodes, config changes and node reordering, reverts the four fields
and removes only the two dedicated sender IDs. It accepts only its matching
forward lease, checking full source/candidate, attempt and phase-specific ACK
bindings. A fresh dedicated/reloaded editor context is required. If the inverse
is abandoned before its native attempt after taking forward custody, abort writes
its receipt but retains the lease for explicit guarded handback; it must not
silently discard an unfinished forward soak. It never replays delivery or resets
any queue marker, lease, intent, cancellation job or scan cursor.

These modules are not a complete paired live operator. Before issuing or using a
seal, the outer operator under the same custody must prove the exact installed
CUP and worker generations, worker PID0/drain and preserved jobs/cursor, complete
old MAX queue retention, native active/disk/editor parity and the reviewed module
hashes. Prepare both directions, immutable worker and preimages before stopping
services. A changed source or unknown provider outcome stops the affected path.

The new-only boundary is the successful final queue seal before starting the new
process of the same CUP runtime. Keep MAX paused during CUP stop/drain, raw BSON
snapshot, marker-only full-preimage CAS and both complete zero-unheld scans. Start
CUP with the unchanged legacy mode and sync=0; commands durably accepted afterward
form the new queue, including those accepted before the NR pollers are activated.
Do not weaken the stopped-backend helper to attempt an online timestamp cutoff.

Verification adds browser preservation/one-attempt cases, protected inverse lease
cases and a real Node-RED 4.0.9 modified-nodes rehearsal using the public contrib
constructors and synthetic transport. The runtime fixture waits for bootstrap
`flows:started`: Node-RED's `start()` resolves before its credential load. It
checks config credentials and unrelated instances across both directions, zero
incoming/startup sends and two explicit synthetic new-message sends. No copied
production graph or real provider is started.
