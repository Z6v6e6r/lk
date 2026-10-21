# HANDOFF — LK1 booked-operation receiver (LK2 commercial JOIN)

Branch: `codex/booked-operation-receiver-20261021` (based on LK1 `origin/main`).
Status: **LOCAL only**. No flow import, no deploy, no Node-RED restart, no live
Node-RED/Mongo/Viva provider access, no secrets in Git.

## What was delivered

The LK1 owner side of the LK2 commercial JOIN admission/read contract, fail-closed:

| Part | Path |
| --- | --- |
| Receiver function sources (single source of truth) | `scripts/nodered_booked_operation_receiver_nodes/` |
| Focused flow patcher (preimage → candidate + report) | `scripts/patch_nodered_booked_operation_receiver_flow.mjs` |
| Function-node, patcher and Node-RED 4.0.9 tests | `scripts/tests/bookedOperationReceiver*.test.mjs` |
| npm test entry | `package.json` → `test:booked-operation-receiver` |

Routes installed by the patch, in one isolated tab (`LK Booked Operation Receiver`):

- `POST /lk/integrations/v1/booked-operation-admissions`
- `GET /lk/integrations/v1/booked-operations/:operationId`

The patch script adds the tab, two HTTP-in nodes, two verification function nodes,
one router, one response guard, one fault guard, a catch node, a find node and one
`updateOne` (upsert) node. It reuses the existing `lk_subscription_daily_booking_ops`
Mongo client, edits no existing node, adds no provider/exec node, and writes the
candidate/report atomically with mode 0600 after a whole-flow preimage check:

```bash
node scripts/patch_nodered_booked_operation_receiver_flow.mjs \
  --input <fresh-private-live-preimage.json> \
  --output <candidate.flow.json> --report <report.json> \
  --expected-flow-sha256 <sha256-of-the-preximage>
```

## Behaviour (fail-closed by construction)

- RS256 `phub-subscription-runtime-actor-delegation+jwt` verification with `kid`,
  `alg=RS256`, `typ`, `iss`, `aud`, `exp/nbf/iat` (10–60 s window), `jti`, `sub`,
  exact claim set, exact method/path/scope/caller/provider, and the exact
  `request_sha256` over the canonical body
  `booked-operation-admission:v1\0{"action":"JOIN_GAME","target":{"id":…,"expectedRevision":…},"paymentIntent":"USE_SUBSCRIPTION"}`.
  The public key comes only from env; nothing key-like is committed.
- One durable document per `operation_id` in `lk_subscription_daily_booking_ops`
  (`_id = operationId`, `kind = BOOKED_OPERATION_ADMISSION`, states
  `PENDING | CONFIRMED | UNKNOWN | REJECTED`, immutable binding hash, tenant/actor/
  provider mapping, first-seen delegation metadata, append-only `attempts`/`receipts`).
  First admission uses `updateOne` + `$setOnInsert` + `upsert:true`; a repeat/race
  only reads and returns the same state — never a second booking attempt.
- Strict read payload `{contractVersion, operationId, status, asOf, reason}` with
  `PENDING/OWNER_PENDING`, `UNKNOWN/RECONCILIATION_REQUIRED`,
  `CONFIRMED/OWNER_BOOKING_CONFIRMED`; unknown/foreign operations are 404.
- No Viva/provider request is made for a `PENDING` operation. The receiver only
  stores `PENDING`; it never invents `CONFIRMED`, never substitutes identity, and
  never sends an unattributable provider write.

## Missing LK2-side contract extension (blocking real execution)

The current admission envelope carries tenant/actor/provider **identity** but no
user-scoped provider credential and no impersonation contract. Therefore `POST`
stops at `PENDING` by design. Before execution can be enabled, LK2 must extend the
envelope with exactly one of:

1. **Delegated actor token (preferred):** a backend-issued, short-lived
   (≤60 s), user-scoped Viva access token delivered as a new header
   `X-Subscription-Actor-Token`, bound to the delegation by an extra JWT claim
   `actor_token_sha256` (and `actor_token_expires_at`), so the token cannot be
   swapped across operations. LK1 then uses it as `Authorization: Bearer …` for
   the user-scoped Viva calls and the booking write.
2. **Explicit service-impersonation claim:** `service_impersonation: {mode,
   provider_actor_user_id, provider_client_id, contract_version:1}` plus a Viva
   provider contract that accepts on-behalf-of attribution, and a separate LK1
   activation flag. Substituting the shared `global vivacrm_access_token` is not
   acceptable.

When that extension exists, execution should reuse the existing atomic
subscription-booking machinery rather than write a second booking path:

- `scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js`
  (user Bearer → Viva profile) and
- `scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js`
  (`prepareBookingCreate` → `POST https://api.vivacrm.ru/api/v1/exercises/{provider_exercise_id}/bookings`
  with `paymentType:"SUBSCRIPTION"`, exact `clientSubscriptionId`, plus the existing
  durable CAS/`PENDING_CONFIRMATION` → confirmation readback).

That executor must be invoked with the receiver's `operation_id` as the gateway
operation identity, write the same collection for the receipt, and append (never
rewrite) the `attempts`/`receipts` list. Until then the receiver must stay
default-off (`LK1_BOOKED_OPERATION_RECEIVER_ENABLED` unset).

## Receiver runtime configuration (server env only, no key in Git)

- `LK1_BOOKED_OPERATION_RECEIVER_ENABLED=true`
- `LK2_BOOKED_OPERATION_DELEGATION_ISSUER`
- `LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE`
- `LK2_BOOKED_OPERATION_DELEGATION_KEY_ID`
- `LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM` (SPKI `BEGIN PUBLIC KEY` PEM;
  `\n` escapes accepted)
- optional `LK2_BOOKED_OPERATION_DELEGATION_MAX_LIFETIME_SECONDS` (10–300, default 120)
- optional `LK2_BOOKED_OPERATION_DELEGATION_CLOCK_SKEW_SECONDS` (0–60, default 5)

Runtime prerequisite: Node-RED `settings.js` must **not** set
`functionExternalModules: false`. The verification nodes load the Node.js builtin
`crypto` module through the standard function-node external-module entry
(`{"var":"nodeCrypto","module":"crypto"}`); no npm package is installed and no new
dependency is introduced. On Node-RED 4.0.9 this was verified locally (see below).
If the setting is explicitly false, the node cannot initialise — check settings
before importing the candidate.

## Evidence (LOCAL)

```bash
node --test scripts/tests/bookedOperationReceiver.nodered.test.mjs \
  scripts/tests/bookedOperationReceiverPatch.test.mjs
# pass: JWT verify matrix (valid / bad signature / wrong scope, method, path,
# caller, issuer, audience / expired, nbf-future, unbounded / replayed body,
# correlation and target mismatch), idempotent repeat POST (no second write),
# 409 binding conflict, strict read mapping and 404, no provider node.

NODERED_RUNTIME_ROOT=<existing Node-RED 4.0.9 tree> \
  node --test scripts/tests/bookedOperationReceiverRuntime.test.mjs
# pass: real Node-RED 4.0.9 runtime loads the builtin crypto module, deploys the
# actual verification nodes and enforces 202/401/403 over HTTP (local evidence,
# not CI and not a live instance).
```

CI: the repository has `.github/workflows/lk1-subscription-enforcement.yml`, but
this task is not wired into it and no CI run was possible from this session. The
candidate flow has **not** been imported or deployed; the live flow was not read
or modified.

## Residual risks / follow-ups

- The patcher requires a fresh private live preimage; it was exercised only against
  synthetic local flows. Real import, `functionExternalModules` settings, env
  provisioning, Nginx/HTTP exposure and Mongo indexes remain deployment work.
- The read path trusts the LK2-verified session; LK1 compares tenant, user and
  provider mapping but does not re-resolve the active session.
- Rejected operations surface as `UNKNOWN/RECONCILIATION_REQUIRED` (never a new
  purchase); LK2 must keep the attempt custodian behaviour.
- `outputs/` keeps this handoff; no ADR/runbook/`docs/NODERED_REFERENCE.md` update
  was made to keep the diff to the receiver concern (follow-up for the ops owner).
