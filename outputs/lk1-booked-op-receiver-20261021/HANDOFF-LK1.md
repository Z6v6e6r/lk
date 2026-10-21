# HANDOFF — LK1 booked-operation receiver (LK2 commercial JOIN)

Branch: `codex/booked-operation-receiver-20261021` (based on LK1 `origin/main`).
Status: **LOCAL only**. No flow import, no deploy, no Node-RED restart, no live
Node-RED/Mongo/Viva provider access, no secrets in Git. The execution adapter is
**disabled by default** (`BOOKED_OPERATION_EXECUTION_ENABLED` unset): with the
current LK2 envelope the flow still stops at `PENDING` and sends no provider call.

## What was delivered

| Part | Path |
| --- | --- |
| Receiver function sources (single source of truth) | `scripts/nodered_booked_operation_receiver_nodes/` |
| Fail-closed execution adapter (disabled by default) | `fn_booked_operation_executor.js` |
| Shared Viva request contract factored from the booking gateway | `_booked_operation_viva_contract.js` |
| Focused flow patcher (preimage → candidate + report) | `scripts/patch_nodered_booked_operation_receiver_flow.mjs` |
| Function-node, execution, patcher and Node-RED 4.0.9 tests | `scripts/tests/bookedOperationReceiver*.test.mjs` |
| npm test entry | `package.json` → `test:booked-operation-receiver` |

Routes installed by the patch, in one isolated tab (`LK Booked Operation Receiver`):

- `POST /lk/integrations/v1/booked-operation-admissions`
- `GET /lk/integrations/v1/booked-operations/:operationId`

The patch adds the tab, two HTTP-in nodes, two verification function nodes, one
router (4 outputs), one executor (5 outputs), exactly one `http request` node,
four `mongodb4` nodes (`find`, guarded insert `updateOne`, dispatch-marker
`updateOne`, terminal-state `updateOne`), one response guard, one fault guard, a
catch node and one `http response` node. It reuses the existing
`lk_subscription_daily_booking_ops` Mongo client, edits no existing node, and
writes the candidate/report atomically with mode 0600 after a whole-flow preimage
check:

```bash
node scripts/patch_nodered_booked_operation_receiver_flow.mjs \
  --input <fresh-private-live-preimage.json> \
  --output <candidate.flow.json> --report <report.json> \
  --expected-flow-sha256 <sha256-of-the-preimage>
```

`report.mode = FAIL_CLOSED_EXECUTION_ADAPTER`, `executionEnabledByDefault=false`,
`providerRequestNodeCount=1`, and the graph check refuses any provider request node
that is not wired exclusively from the executor.

## Wire contract (verification, unchanged)

- RS256 `phub-subscription-runtime-actor-delegation+jwt` verification with `kid`,
  `alg=RS256`, `typ`, `iss`, `aud`, `exp/nbf/iat` (10–60 s window), `jti`, `sub`,
  exact claim set (plus the optional execution claims below), exact
  method/path/scope/caller/provider, and the exact `request_sha256` over the
  canonical body
  `booked-operation-admission:v1\0{"action":"JOIN_GAME","target":{"id":…,"expectedRevision":…},"paymentIntent":"USE_SUBSCRIPTION"}`.
  The public key comes only from env; nothing key-like is committed.
- One durable document per `operation_id` in `lk_subscription_daily_booking_ops`
  (`_id = operationId`, `kind = BOOKED_OPERATION_ADMISSION`, immutable binding hash,
  tenant/actor/provider mapping, first-seen delegation metadata, append-only
  `attempts`/`receipts`). First admission uses `updateOne` + `$setOnInsert` +
  `upsert:true`; a repeat/race only reads and returns the same state.

## Execution adapter — state machine (same operation document)

```
PENDING --(durable CAS marker, written BEFORE the provider POST)--> ATTEMPTING
ATTEMPTING --(provider 2xx + provider readback shows the booking)--> CONFIRMED
ATTEMPTING --(timeout / transport error / 5xx / 408 / 429)--------> UNKNOWN
ATTEMPTING --(definitive 4xx rejection, e.g. 409 full)-------------> REJECTED
```

- The marker CAS filter is `{_id, kind, state:"PENDING"}` with
  `$set.state="ATTEMPTING"` + `$push.attempts{kind:"DISPATCH_ATTEMPTING", attemptId}`.
  The provider POST is emitted only after the marker write is acknowledged.
  `attemptId = "sha256:"+sha256("booked-operation-attempt:v1\0"+operationId+"\0"+idempotencyKeySha256)`.
- A repeat or racing admission that finds `ATTEMPTING`/terminal state never
  dispatches again; the loser of the marker CAS reconciles by durable readback
  (`executionSuppressed` prevents a dispatch loop) and never sends a second POST.
- `CONFIRMED` requires a provider readback (`GET /end-user/api/v2/{tenant_key}/bookings?size=1000`)
  matching the operation's `provider_exercise_id` + `provider_client_subscription_id`
  with an active booking and a stable `bookingId`. The receipt written to the
  document is `{operationId, bookingId, confirmedAt, source:"PROVIDER_BOOKING_READBACK"}`.
  Provider acceptance alone (2xx create) is **not** confirmation.
- `UNKNOWN` is terminal: never auto-retried, never released, never reported as
  CONFIRMED. `CONFIRMED`/`REJECTED` are terminal.
- Attempt entries are append-only and redacted: kind, attemptId, timestamp,
  optional HTTP status/reason/rejection code (bounded upper-case token) and
  `correlationId`. No tokens, no Authorization headers, no full provider payloads.
- Pre-dispatch failures (profile read 4xx/5xx/timeout, profile identity mismatch,
  token rejected, unresolved marker write) persist **no** state change: the
  operation stays `PENDING` (202) or the request is rejected with a stable code
  (403/502/503). No terminal state is written before the dispatch marker.
- The executor is a closed state machine over Node-RED messages: `execute` →
  `profile` → `attempt_claim` → `booking_create` → `confirmation_bookings` →
  `finalize`. All steps are driven by the same single `http request` node
  (`method: "use"`, `senderr: true`).

## READ maps

| Durable state | READ response |
| --- | --- |
| `PENDING`, `ATTEMPTING` | `200 {contractVersion:1, operationId, status:"PENDING", reason:"OWNER_PENDING", asOf}` |
| `UNKNOWN` | `200 {…, status:"UNKNOWN", reason:"RECONCILIATION_REQUIRED", asOf}` |
| `CONFIRMED` | `200 {…, status:"CONFIRMED", reason:"OWNER_BOOKING_CONFIRMED", asOf}` |
| `REJECTED` | `409 {error:"BOOKED_OPERATION_REJECTED", code:"BOOKED_OPERATION_REJECTED", contractVersion:1, operationId, rejectionCode:"<stable code>", asOf}` |
| missing/foreign/malformed | `404 BOOKED_OPERATION_NOT_FOUND` |

Unknown/failed storage and invalid router context remain `503`. The admission
`POST` returns the same mapping (`202` PENDING/UNKNOWN, `200` CONFIRMED, `409`
REJECTED); a repeat admission of a terminal/`ATTEMPTING` operation never dispatches.

## Still required on the LK2 side (before turning the flag on)

1. Header `X-Subscription-Actor-Token` on the admission request: the raw,
   backend-issued, short-lived (≤60 s) **user-scoped Viva access token**.
2. Signed delegation claims (optional in the current exact-claim-set contract so
   the existing envelope keeps verifying unchanged):
   - `actor_token_sha256` — **required for execution**, `sha256:<64 lowercase hex>`
     of the raw header value. The header token is used only when its hash matches
     this claim (constant-time compare); a token with no claim is never used.
   - `actor_token_expires_at` — optional canonical UTC ISO (`new Date(...).toISOString()`),
     must still be in the future at verification and at dispatch.
   - `provider_client_subscription_id` — **required for execution**, the Viva
     `clientSubscriptionId` that pays for the booking, stored on the op document
     (and part of the immutable binding hash) and used in the POST payload.
3. LK2 must keep the attempt custodian behaviour and must not resend an admission
   for the same operation id after a terminal response.

Verification failures are stable: `403 BOOKED_OPERATION_ACTOR_TOKEN_REQUIRED`,
`403 BOOKED_OPERATION_ACTOR_TOKEN_MISMATCH`, `403 BOOKED_OPERATION_ACTOR_TOKEN_EXPIRED`
(no POST, no dispatch).

## Activation checklist (all required, no step may be skipped)

1. Receiver env provisioned (below) and `LK1_BOOKED_OPERATION_RECEIVER_ENABLED=true`.
2. LK2 wire header + claims implemented and tested on the LK2 side.
3. Candidate flow imported with a fresh private live preimage; Node-RED
   `settings.js` must **not** set `functionExternalModules: false` (builtin
   `crypto` is loaded through the function-node external-module entry).
4. Point `LK1_BOOKED_OPERATION_VIVA_API_BASE` at the intended Viva endpoint
   (production default `https://api.vivacrm.ru`); verify the three path envs.
5. Rehearse with `BOOKED_OPERATION_EXECUTION_ENABLED` **off**: admission returns
   `PENDING`, Mongo document has `state=PENDING`, exactly one insert, zero Viva
   requests.
6. Enable `BOOKED_OPERATION_EXECUTION_ENABLED=true` for one exact tenant/actor
   canary; verify exactly one Viva booking POST, a CONFIRMED read, and a receipt
   `{bookingId, confirmedAt, operationId}` in `lk_subscription_daily_booking_ops`.
7. Verify the repeat path (same delegation/operation id) returns the stored state
   with no second POST, and that a rejected/timeout scenario maps to
   `REJECTED`/`UNKNOWN` without retry.
8. Stop method: unset `BOOKED_OPERATION_EXECUTION_ENABLED` (new admissions stop at
   PENDING immediately; in-flight operations finish or remain `ATTEMPTING` for
   readback reconciliation). Disabling the flag never undoes a provider booking.

## Receiver + execution env (server env only, no key in Git)

Receiver (unchanged):

- `LK1_BOOKED_OPERATION_RECEIVER_ENABLED=true`
- `LK2_BOOKED_OPERATION_DELEGATION_ISSUER`
- `LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE`
- `LK2_BOOKED_OPERATION_DELEGATION_KEY_ID`
- `LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM` (SPKI `BEGIN PUBLIC KEY` PEM;
  `\n` escapes accepted)
- optional `LK2_BOOKED_OPERATION_DELEGATION_MAX_LIFETIME_SECONDS` (10–300, default 120)
- optional `LK2_BOOKED_OPERATION_DELEGATION_CLOCK_SKEW_SECONDS` (0–60, default 5)

Execution adapter (all default to the fail-closed behaviour):

- `BOOKED_OPERATION_EXECUTION_ENABLED` — **default off**; `1|true|yes|on` enables.
  Owner/purpose: LK1 booked-operation owner, real-live provider execution after the
  LK2 token contract exists. Activation criterion: checklist above. Review/removal:
  re-evaluate when LK2 makes the actor-token contract the default envelope.
- `LK1_BOOKED_OPERATION_VIVA_API_BASE` — optional, default `https://api.vivacrm.ru`;
  must be `https://`, no credentials, no trailing slash required.
- `LK1_BOOKED_OPERATION_VIVA_PROFILE_PATH` — optional, default
  `/end-user/api/v1/{tenant_key}/profile`
- `LK1_BOOKED_OPERATION_VIVA_BOOKING_PATH` — optional, default
  `/api/v2/exercises/{provider_exercise_id}/bookings`
- `LK1_BOOKED_OPERATION_VIVA_READBACK_PATH` — optional, default
  `/end-user/api/v2/{tenant_key}/bookings?size=1000`
- `LK1_BOOKED_OPERATION_EXECUTION_TIMEOUT_MS` — optional, 1000–60000, default 15000

No secret is configurable here beyond the server env public key; the actor token is
per-request, header-only, and is never stored or logged.

## Reuse / no second booking path

The executor reuses the existing atomic subscription-booking provider contract,
factored once into `_booked_operation_viva_contract.js` and characterised against
the live sources by `bookedOperationReceiverExecution.test.mjs`:

- profile read: `GET /end-user/api/v1/{tenant_key}/profile` with
  `Authorization: Bearer <actor token>` (same as `fn_subscription_booking_prepare.js`);
- booking write: `POST /api/v2/exercises/{provider_exercise_id}/bookings` with
  `{clientId, phone, paymentType:"SUBSCRIPTION", clientSubscriptionId, customFields:[]}`
  and the gateway's 202/CONFIRMED readback semantics (same as
  `fn_subscription_booking_router.js` `prepareBookingCreate`/confirmation steps);
- the attribute `operationId` is the receiver's operation id, and the same
  `lk_subscription_daily_booking_ops` collection holds the durable attempt/receipt.

No service/shared `vivacrm_access_token` is ever substituted, and no second
independent booking flow is introduced.

## Evidence

LOCAL (executed from the task worktree):

```bash
node --test scripts/tests/bookedOperationReceiver*.test.mjs
# 27 pass, 1 skipped (Node-RED 4.0.9 runtime test needs NODERED_RUNTIME_ROOT)
# covers: JWT verification matrix, idempotent repeat (no second write/dispatch),
# binding 409, strict read mapping + 404, REJECTED 409 payload, flag-off and
# missing-token PENDING/no-POST, actor-token hash mismatch 403, one POST with
# SUBSCRIPTION payload, ATTEMPTING marker before POST, timeout/5xx -> UNKNOWN with
# no retry on repeat/read, definitive 4xx -> terminal REJECTED, lost marker claim
# -> readback with no second POST, pre-dispatch failures persist nothing, token
# scrubbed from responses and durable documents, provider-contract characterisation.
```

```bash
npx eslint scripts/patch_nodered_booked_operation_receiver_flow.mjs \
  scripts/tests/bookedOperationReceiver*.test.mjs
# 0 problems (nodered_*_nodes function bodies are ignored by eslint.config.js)
# Full `eslint .` in this worktree still reports pre-existing unrelated failures in
# src/** (89 errors, 398 warnings at this head, none in files touched here).
```

CI: `.github/workflows/lk1-subscription-enforcement.yml` does not run this task;
no CI run was possible from this session. The candidate flow has **not** been
imported or deployed; the live flow was not read or modified. No live Node-RED,
Mongo or Viva request was made.

## Residual risks / deliberately deferred

- Import, `functionExternalModules` settings, env provisioning, Nginx/HTTP
  exposure and Mongo indexes remain deployment work.
- Managed subscription enforcement / entitlement policy (DEV allowlist, ЦУП
  reserve/activation) is **not** applied by this adapter; LK2 owns admissibility
  (`target_admissible`) and Viva rejects an invalid subscription. Revisit before
  enabling for products covered by that policy.
- Stale `ATTEMPTING` after a process crash (marker written, POST never sent, or
  POST result lost) is not auto-reconciled: a repeat admission returns `PENDING`
  and sends no POST. Ops reconciliation must read the provider bookings and close
  the document (readback evidence, no retry).
- The read path trusts the LK2-verified session; LK1 compares tenant, user and
  provider mapping but does not re-resolve the active session.
- `outputs/` keeps this handoff; no ADR/runbook/`docs/NODERED_REFERENCE.md` update
  was made to keep the diff to the receiver concern (follow-up for the ops owner).
