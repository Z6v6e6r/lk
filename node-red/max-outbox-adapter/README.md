# Fenced MAX outbox sender

Source-only companion to ph-admin MAX receipt protocol v1. No installed flow,
public bundle, SDK dependency, provider account or production state is changed.
This local Node-RED package uses Node18+ builtin fetch and the existing maxbot-config
credential at runtime; no new npm dependency or token in exported flow. It avoids
the old SDK attachment.not.ready recursion and logs only fixed diagnostic codes.
The fixed provider origin is `https://platform-api2.max.ru`, following the current
[official API overview](https://dev.max.ru/docs-api) and
[POST /messages contract](https://dev.max.ru/docs-api/methods/POST/messages), read on
2026-10-26. They require the v2 domain, an Authorization header and distinct user_id
or chat_id; the result contains a message object. The credential-store interface
was verified against actual `node-red-contrib-maxbot`0.6.1 with SDK0.2.2. Those are
distinct packages; the old installed SDK still uses the retired v1 domain and does
not establish the current provider endpoint. No real MAX message was sent.

The official overview also requires an appropriate trusted TLS certificate chain.
This adapter keeps Node's normal certificate validation and never uses an insecure
agent or disables TLS checks. Verify trust from the actual Node-RED runtime before
enabling consumers; any trust-store change requires its own reviewed target action.
Do not learn TLS readiness by sending or replaying a real outbox command.
The official send contract limits a dialog/chat/channel to two messages per second.
Verify queueing/delay and per-dialog serialization before activation; reactive 429
backoff alone does not establish compliance with that limit.

One input contains supportOutbox with id,leaseToken,leasedUntil,text and either
externalChatId or externalUserId (targetExternal* fields). The sender uses chat_id
when chat exists, otherwise user_id. It sends text/allowed format only. Attachments
are explicitly rejected with INVALID_INPUT, including text+attachment messages;
no silent loss or media upload/download. This matches the narrow text-outbox scope
and needs separate media acceptance before attachment support.

One fetch per invocation; duplicate same-lease inputs on a node share the in-flight
promise/cached receipt (bounded1000 entries/10min). There is no global provider
idempotency guarantee across processes or manually duplicated inputs to distinct
nodes. Graph and rollout must prevent parallel legacy senders. Aborting a timeout
or close cannot prove the provider did not accept the request. Such outcomes emit
DELIVERY_UNKNOWN failure, never an automatic resend or a late ACK.

Output is only maxOutboxReceipt:{id,leaseToken,kind,failure?,retryAfterSeconds?}.
No text, recipient, provider mid/description/body/headers/stack or bot token is
copied into it. Body read is bounded64KiB; redirect is rejected. The backend applies
its own allowlist and policy. Failure/ACK receipts are fenced and durable there.

## Candidate construction and rollout hold

scripts/prepare_max_outbox_receipts.mjs builds a12-node narrow patch for both known
MAX/academy outbox dispatch/pull ID pairs. It checks unique IDs, allowlisted
function preimages, exact single sender wire, shared flow and an existing bot reference
whose node type is `maxbot-config`. Missing or wrong-type config references fail closed.
It reroutes only outbox traffic to new max-outbox-send nodes and separate receipt
HTTP nodes. Interactive/service legacy senders and inbound flows remain untouched.
It never executes or deploys a patch. Existing broad patch_nodered_max_flow.mjs is
not a release route for this change and must not be run.

The constructor accepts both pinned legacy dispatch code and the exact diagnostic
dispatch from current main. It rejects any other observer or wiring drift. The
replacement retains optional no-throw diagnostic correlation, records only safe
classification fields and never treats a send attempt as observed execution.

Future authorized operator invocation (not executed by this PR):
node scripts/prepare_max_outbox_receipts.mjs /absolute/external/source.json /absolute/external/new-patch.json

The constructor's preimage check is not a fresh-origin/whole-topology acceptance
receipt. Output must remain outside the repository and cannot be deployed until
fresh origin custody, complete expected wiring/config readback, real Node-RED
module-loading/close/abort smoke and paired backend acceptance are verified.
No full live flow was copied/generated for this source PR.

Coordinate with ph-admin docs/support/MAX_OUTBOX_RECEIPTS.md. Pause/drain all old
pollers and reconcile ambiguous existing leases first. Backend rejects legacy pulls
without receiptProtocol=max-lease-v1 before claiming; old backend commands lack
leaseToken and this sender must not send them. No permissive token fallback.

Receipt HTTP makes one attempt with a fixed seven-second request timeout and
redirects disabled. Failures warn MAX_OUTBOX_RECEIPT_UNCONFIRMED and can
leave a provider-accepted send in DELIVERY_UNKNOWN after lease expiry. Recovery may
retry only the same receipt/token, never the provider message. This conservative
availability tradeoff prevents implicit replay. An expired/near-expiry input makes
no provider call. A process/node restart loses local cache; backend atomic claims
and the no-reclaim policy remain the persistent boundary. Do not restart old
pollers as rollback or strip lease fields to bypass fencing.

## Runtime/editor packaging

The package explicitly declares `type: commonjs` and maps `max-outbox-send` to
`max-outbox-send.js`. Its sibling `max-outbox-send.html` is the editor definition.
Node-RED4.0.9 derives the template with a `.js` suffix replacement: `.cjs` registers
at runtime but incorrectly exposes the JavaScript file as the editor template.
The package boundary preserves CommonJS despite the parent repository's ESM type.

## Tests

node --test scripts/tests/maxOutboxReceipts.test.mjs scripts/tests/maxSupportBridge.nodered.test.ts

Transport is fully mocked: success,403/429/5xx/network,privacy,oversized/broken body,
invalid input,user fallback,abort/late completion,node close,duplicate inputs,output
failure,receipt fencing,graph drift and the package mapping/CommonJS boundary.

The dedicated editor regression uses actual Node-RED4.0.9 with the editor enabled:

NODE_RED_TEST_PACKAGE=/absolute/isolated/node_modules/node-red node --test scripts/tests/maxOutboxEditorLoader.test.mjs

CI installs that pinned test runtime outside this repository with lifecycle scripts
disabled; the adapter has no new runtime dependency. The test asserts runtime
registration plus editor HTML/help presence and absence of runtime-source leakage.
It uses a temporary user directory, no listening server/installed flow/credentials,
and blocks provider fetches. Local paired Node-RED/Nest/disposable Mongo acceptance
is separate from external installed-staging and future authorized rollout checks.

On 2026-10-26 the updated constructor/adapter passed an isolated paired rehearsal
against ph-admin commit `171f89a06ff4ef4497afc16736f851896d4d98ef` (tree
`0d7b15c012ffe7d10e94fd15d115ac2264dd4225`) with Node22.13.1, Node-RED4.0.9 and
Mongo7.0.16. Both connector graphs used the exact diagnostic dispatch fixture.
That rehearsal used the earlier v1 origin with fully mocked transport. The provider
origin was subsequently updated to the documented v2 domain; request/receipt state
logic did not change. Final unit/config/editor checks validate the new origin;
the physical paired rehearsal must be repeated at installed-staging acceptance.
Eleven scenarios covered protocol/auth denial, durable ACK and duplicate/stale
receipts, 403 privacy, 429 backoff/cap, uncertain transport, lost receipt and node
close with a late 200. Twelve provider fetches were synthetic; no real provider or
shared-state writes occurred. This does not close the backend's documented durable
enqueue, per-dialog ordering, partial-batch reconciliation or installed-target
acceptance gaps. Keep the rollout hold until those gates have explicit evidence.


The sender enforces a process-wide addressed-dialog scheduler shared by both MAX
node instances: one in-flight provider attempt per dialog and at least 500 ms
between starts. Different dialogs remain independent. The scheduler holds at
most 1,000 pending attempts/keys, remembers cooldown after completion, and
rechecks the remaining lease after waiting before any POST. It is an in-process
limit: admission still requires one Node-RED process and no parallel legacy
sender. Queue-full/expired/aborted work never starts provider transport; a fenced `local_deferred` receipt preserves the unsent command as PENDING
without consuming a provider attempt. This requires the matching CUP backend
before this adapter is enabled. Once transport starts, ambiguous outcomes keep
the existing terminal/reconciliation behavior and never become local deferrals.
