# Prospective durable MAX queue consumer

Paired with ph-admin's opt-in durable receipt-v1 backend. This change prepares
source only: no module install, native Deploy, environment switch, queue import,
archive mutation or provider request runs from the builder or tests.

`prepareDurableQueue(rawBytes, trustedPins)` in
`scripts/prepare_max_durable_queue.mjs` requires a reviewed exact raw whole-flow
SHA and the closed exported required-node SHA set. It accepts the current
outgoing-only topology with dedicated legacy senders, rejects drift, extra MAX
send/receive/custom nodes, channel swaps, ID collisions and pre-existing future
references in wires/links/scopes. The old channel-specific function preimage
checks remain closed; source pins do not override semantic safety checks.

The candidate changes exactly eight existing nodes (two dispatch functions,
two pull functions, two poller timings and two dedicated legacy sender disabled
flags), adds two fenced senders and two receipt persisters, and preserves all
other nodes/fields/order. Both shared legacy senders, receivers and callback
functions remain disabled. Pollers request one command every 500ms per channel
with a 120-second lease and max-lease-v1 negotiation. The backend also caps one
atomic claim per response, avoiding a hidden prefix after a batch failure.

The package `node-red-contrib-padlhub-max-outbox` 1.1.0 registers both runtime
types and sibling editor templates. The sender never uses SDK recursive retries:
one bounded MAX POST per lease, safe outcome only from a verified provider ID.
Protocol-tagged commands with either permanent custody/archive marker are
rejected before provider admission. Sender dedup entries live through the lease;
finished expired entries are removed. Capacity refusal before transport emits a
proven local_deferred receipt rather than silently stranding the claim. A fixed-size
expiry watermark also refuses unremembered leases at or below a capacity refusal,
so cache cleanup cannot later admit an already-released token. Fresh leases with
a later expiry can resume after capacity is available.

The receipt runtime reads fixed SUPPORT_API_BASE_URL and
SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN (falling back to the previous
SUPPORT_INTEGRATION_TOKEN when the scoped API returns no value) keys through Node-RED's scoped env API. Incoming
message URL/headers/token overrides are ignored. It retries the same immutable
CUP receipt for network/5xx/429 only, at most twenty bounded HTTP attempts within
the original wall and monotonic lease budget. It never retries a MAX send.
Success requires exact returned ID/token/kind and durable status, not just HTTP
200. Auth/conflict/malformed responses stop. Queue/cache sizes, body size,
requests and close cleanup are bounded. Outputs/warnings contain fixed status
codes only; no target/token/provider body is forwarded.

The sender remains the existing text-only fenced transport. Unsupported media
is retained as an explicit backend failure; no fabricated delivery confirmation.
Validate required message formats before activation. MAX's official transport,
authorization and two-per-second per-dialog limit are documented at
https://dev.max.ru/docs-api/methods/POST/messages . No real provider calls are
needed for the local tests.

## Activation is a separate guarded paired operation

Follow ph-admin `docs/support/MAX_DURABLE_QUEUE.md`. Requirements include fresh
runtime/disk/editor pins, unchanged archive/custody membership, explicit custody
of any still-pending new legacy commands, exact NEW-module installation and
registry/package/lock inventory, a modified-nodes graph guard for this exact
8-edit/4-add delta, matching unpaid-worker generation and both directions of
recovery. Existing outgoing-only 4-edit/2-add native seals do not authorize this
different candidate. Never cold-restart Node-RED to discover whether the new
module loads. Rehearse native installation/addModule first; a pre-installed
older version is a separate upgrade boundary.

Before the switch, stop admitting new legacy claims and preserve/drain intake.
Untagged legacy rows are not silently replayed or auto-tagged. Once v1 data
exists, rollback keeps a compatible v1 backend and can pause consumers; never
clear fencing fields or restore archived rows. Long outages/unknown provider
outcomes require review rather than automatic duplicate sends. The backend
counts-only health endpoint makes pending/due/expired/review work observable.

## Tests

```sh
node --test scripts/tests/maxDurableQueueBuilder.test.mjs scripts/tests/maxDurableReceipts.test.mjs
node --test scripts/tests/maxOutboxReceipts.test.mjs scripts/tests/maxOutboxRateLimit.test.mjs
NODE_RED_TEST_PACKAGE=/absolute/isolated/node-red node --test scripts/tests/maxOutboxEditorLoader.test.mjs
```

Fixtures are synthetic, with fake MAX/CUP transport. They cover ACK loss/backend
restart, retry exhaustion, stale tokens, closed runtime, invalid/oversized
responses, scoped env and context stripping, same-lease dedup, sender saturation
and lease cleanup, archive refusal, exact graph delta and preservation. Local
rehearsal is not evidence of deployed message delivery.


## Paired native operation and server-only credential

`nodered_max_durable_release.mjs` closes the live transition into two native
modified-nodes operations: pause changes only two poller disabled flags; activate
accepts that exact paused source and changes eight nodes/adds four. The matching
root/browser custodians are `max_durable_*` under `nodered_reviewed_flow_deploy`.
They preserve native snapshot fields/order, one original authenticated POST,
whole-source/revision/code/process pins and the shared release lease. Activation
hands off only its proven pause lease; abort before attempt returns that exact
protected predecessor. Lost ACK is reconciled read-only and explicitly adopted,
never replayed. Final activation and recovery require a fresh 900-second soak.
The paired inverse restores the paused graph, never resumes legacy consumption.
`nodered_max_durable_worker_rebind.mjs` emits separate forward and paused-recovery
13-file bindings; only the exact 64-byte flow guard constant changes.

The adapter loads only SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN from the fixed
server path `/etc/phab-traffic/max-outbox-integration.env` while registering a new
module. The file contains one 64-lowercase-hex key, owner-only mode0600, one hard
link and a protected canonical parent. No message/flow selects the path; a trusted
runtime setting is available only for isolated rehearsal. Missing file preserves
existing installations; malformed/unsafe/conflicting configuration fails closed.
The value never appears in flow JSON, editor responses, outputs or warnings.
Existing process functions inherit the environment dynamically without restart.
CUP reads the same dedicated EnvironmentFile; legacy ingress retains its previous
SUPPORT_INTEGRATION_TOKEN policy. Native module upload must be rehearsed and its
npm hooks/dependency closure checked before installing on a shared runtime.

Actual4.0.9 hot-upload rehearsal starts without the package, preserves an existing
function/config/http/unrelated instance, proves runtime key inheritance, verifies
editor metadata does not expose the key, applies pause/8+4/paused inverse, checks
exact native4-space disk encoding and confirms both synthetic connector receipts.
No live provider or database is contacted by that rehearsal.
