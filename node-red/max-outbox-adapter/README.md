# Fenced MAX outbox sender

Source-only companion to ph-admin MAX receipt protocol v1. No installed flow,
public bundle, SDK dependency, provider account or production state is changed.
This local Node-RED package uses Node18+ builtin fetch and the existing maxbot-config
credential at runtime; no new npm dependency or token in exported flow. It avoids
the old SDK attachment.not.ready recursion and logs only fixed diagnostic codes.
The POST/messages, Authorization header and message.body.mid acceptance shape were
checked against installed SDK0.2.2's public package source; no MAX request was made.

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
function preimages, exact single sender wire, shared flow and existing bot reference.
It reroutes only outbox traffic to new max-outbox-send nodes and separate receipt
HTTP nodes. Interactive/service legacy senders and inbound flows remain untouched.
It never executes or deploys a patch. Existing broad patch_nodered_max_flow.mjs is
not a release route for this change and must not be run.

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

Receipt HTTP has one attempt; failures warn MAX_OUTBOX_RECEIPT_UNCONFIRMED and can
leave a provider-accepted send in DELIVERY_UNKNOWN after lease expiry. Recovery may
retry only the same receipt/token, never the provider message. This conservative
availability tradeoff prevents implicit replay. An expired/near-expiry input makes
no provider call. A process/node restart loses local cache; backend atomic claims
and the no-reclaim policy remain the persistent boundary. Do not restart old
pollers as rollback or strip lease fields to bypass fencing.

## Tests

node --test scripts/tests/maxOutboxReceipts.test.mjs scripts/tests/maxSupportBridge.nodered.test.ts

Transport is fully mocked: success,403/429/5xx/network,privacy,oversized/broken body,
invalid input,user fallback,abort/late completion,node close,duplicate inputs,output
failure,receipt fencing,graph drift. Tests load the runtime CJS registration with a
fake RED; actual target Node-RED loading is a staging acceptance gap, not claimed PASS.
