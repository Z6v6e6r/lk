# One-window MAX ingress custody for a CUP restart

Owner: LK release owner. Audience: release operator and independent security/reliability reviewer.
This is source preparation, not activation. CUP, direct MAX senders, outbox polling/ACK and LK1
REST support remain unchanged. No provider call, Mongo write, flow import or restart is performed
by `prepare_max_restart_ingress_hold.mjs`.

## Admission and candidate

Use a newly verified private external Node-RED workspace under the existing modular workflow.
The actual flow supplies **both** MAX_BOT and MAX_ACADEMY_BOT IDs; there are no production IDs in
this package. The constructor requires every selected node's SHA256 of `JSON.stringify(node)`,
the SHA256 of the exact raw flow, its capture time (at most 30 minutes old), a single 32-character
lowercase hex `windowId`, and an `acceptUntil` no more than four hours ahead.

Admission schema: `PHUB_MAX_RESTART_HOLD_ADMISSION_V1`. `branches` contains one entry for each
connector with `tabId`, `botConfigId`, `normalizerId`, `lookupPrepareId`, `lookupHttpId`, `routerId`,
`eventHttpId`, `responseId`, `ingressIds` and `nodeSha256`. The map must contain exactly those IDs.
The graph must have isolated, authenticated HTTP POST ingress; unexpected edges, duplicate IDs,
shared lookup/event paths, wrong bot sender, unrecognized source contracts and enabled polling
for either bot are refused. **Polling cursor advancement is not a durable ACK contract.** If an
actual bot uses polling, this candidate cannot make the CUP restart safe; do not silently disable
polling or substitute synthetic webhook IDs.

A separate private `PHUB_MAX_HOLD_MONGO_ADMISSION_V1` evidence file must be produced from actual
runtime verification, at most 15 minutes old, and bound by `mongoEvidenceSha256`. Required facts:

- `status: VERIFIED`, `observedAt`, matching `windowId` and `sourceSha256`;
- exact `clientNodeId` and `clientNodeSha256`, `database: games`,
  `collection: support_cup_restart_ingress_hold`, `connected: true`;
- `majorityJournaledWriteAcknowledged: true`, `writeConcern: {w: majority, j: true}`;
- `driverContract: MONGODB4_FLAT_UPDATE_DOCUMENT_AFTER_V1`: the installed mongodb4 node accepts
  the argument arrays and preserves message metadata, returns flat acknowledged update counts,
  and returns the post-update document for `findOneAndUpdate` with `includeResultMetadata: false`;
- `cryptoModuleVerified: true`, `urlModuleVerified: true`: the Function node can load those built-in
  modules, and the runtime has the webhook's existing secret configured (never export its value).

The constructor checks these pinned facts; it does **not** obtain or independently create runtime
proof. The synthetic test fixture is not acceptable runtime evidence. Any write probe needed to
establish durability is a separately authorized live operation. Missing/unknown evidence is NO-GO.
Confirm the facts and candidate identity again immediately before the separately guarded import.

Local candidate preparation only:

```sh
node scripts/prepare_max_restart_ingress_hold.mjs /absolute/private/workspace \
  /absolute/private/admission.json /absolute/private/mongo-evidence.json \
  /absolute/private/new-candidate-directory
```

The command writes private candidate bytes, exact graph contract and a redacted report. It never
uses the broad `patch_nodered_max_flow.mjs`. Deployment must use the existing reviewed-flow guard,
fresh preimage/lease and separately authorized operation; this document introduces no deploy route.

## Custody and recovery semantics

The wrapper suppresses the old early ACK and normalizer debug output. Missing authentication secret
fails closed. Only normalized business fields are retained; raw provider payload, HTTP transport,
headers, tokens and contact.raw are excluded. Attachments are bounded and reject sensitive fields
and credential-bearing URLs; rejected input returns non-2xx. The total normalized payload ceiling
is 256 KiB. Invalid input and failed/unconfirmed storage never reach CUP.

A Mongo `updateOne` uses `$setOnInsert`, majority+journaled write concern and a five-second write
concern timeout. Only exact acknowledged inserted/matched results permit HTTP 200. The unique `_id`
is SHA256 of window, connector and external message ID. Missing IDs get independent random receipts;
no deduplication is claimed. A duplicate ID with changed business content is rejected, not replaced.
Synthesized timestamps are excluded from the duplicate-content comparison.

After CUP readiness is independently confirmed, the release operator can invoke **one** manual
`drain-one` inject per desired record. There is no startup action, interval or retry scheduler.
Within each connector, the atomic claim sorts by `receivedAt`, then `_id`, selecting only HELD with
attempts 0 and setting DELIVERING, attempts 1 and a unique claim token. It rejoins the existing client
lookup, router and CUP HTTP POST with a bounded request timeout. A failed lookup does not reach the
router. HTTP results are classified as follows:

| Result | Durable hold state |
| --- | --- |
| Valid 2xx object with `ok: true` | DELIVERED: **HTTP acceptance only**, never CUP durable completion |
| Definitive 400/401/403/404/405/410/413/415/422 object response | REFUSED |
| 408/409/429, 5xx, redirect, malformed response, connection loss or timeout | UNKNOWN |
| Process crash after claim, ambiguous claim/final write | DELIVERING retained; terminal outcome unconfirmed |

A crash cannot be automatically distinguished from a delivered request. The manual `mark-unknown`
inject requires the exact receipt ID and claim token plus the pinned window/connector confirmation;
it changes only matching DELIVERING/attempts 1 to UNKNOWN and has no dispatch output. Never reset
UNKNOWN or DELIVERING to HELD, automatically replay them, or infer success from an HTTP ACK. All
held/unknown records stay in the collection; there is no TTL or automatic deletion. Any manual
reconciliation or later successor window needs its own reviewed scope. When the window expires,
new ingress returns 503 and new drain claims stop; existing records remain intact.

## Stop and rollback

Stop on wrong graph/source, missing durability proof, polling, unexpected database result, failed
custody, or uncertain CUP result. Do not start the CUP restart before the temporary ingress candidate
is independently accepted. Stop manual drain immediately on UNKNOWN; inspect canonical records
through a separately authorized read and retain uncertain records without replay.

Before restoring ingress, account for this window's HELD/DELIVERING/UNKNOWN records and preserve
custody. `restoreMaxRestartHoldPreimage` requires exact original and candidate hashes and the reviewed
graph contract, then returns the exact original flow bytes. The existing guarded rollback owns the
actual import. It does not delete, mutate or migrate hold records; disabling the candidate is not
proof that queued messages were delivered. Fresh graph drift blocks automatic rollback.

## Evidence scope

`node --test scripts/tests/maxRestartIngressHold.test.mjs` exercises synthetic normalized events,
Mongo argument/result contracts, one-claim and ambiguous outcomes, exact candidate graph and rollback.
It performs no live connection or provider write. Full applicable PR CI and independent security /
reliability review remain required. Real Mongo durability, installed Node-RED driver behavior, both
actual ingress branches, provider retry behavior and CUP/runtime acceptance require separate evidence.
