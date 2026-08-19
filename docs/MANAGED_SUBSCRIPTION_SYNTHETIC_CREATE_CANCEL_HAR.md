# Synthetic create/read-back/cancel HAR plan

## Status and boundary

This document is an execution plan, not an authorization to mutate Viva, LK,
MongoDB, payments, subscriptions, or production Node-RED.

The implementation checkpoint only prepares a Node-RED candidate that changes
the body of the existing Viva exercise-create request. It does not import or
deploy the candidate. A real run requires a separate approval after the exact
test slot, station, room, synthetic client instance, rollback owner, and
observation window have been recorded.

The provider calls are production-data mutations even when they are initiated
from an LK DEV bundle. If Viva has no isolated tenant, the run must be treated
as a production canary with a synthetic client.

## Reviewed facts

- Fresh live flow source:
  `lk-primary-147:/root/.node-red/flows.json`, SHA-256
  `5a9b52ae6fa0d8c457f9605d55bfb8e947e11d1dc582259616a96b9f3e34791b`.
- Target function: `8f7bd5b482fe9763`, `Route Viva split payment`.
- Live function SHA-256:
  `624e4a233bcd6cf011cd0f0d61aa48243c6878393f31330d5a218e81003227a1`.
- The live create body uses legacy `direction` and `type`, includes undocumented
  `clientId`, and omits `trainers`.
- Current Viva Admin Swagger defines `POST /api/v1/exercises` with required
  `directionId`, `typeId`, `timeFrom`, `timeTo`, `roomId`, `trainers`, and
  `requirements`.
- Current Swagger defines the following read-back and compensation operations:
  - `GET /api/v1/exercises/{id}`;
  - `POST /api/v1/exercises/{id}/bookings`;
  - `GET /api/v1/exercises/{id}/bookings?showCancelled=...`;
  - `GET /api/v1/clients/{clientId}/bookings/{bookingId}`;
  - `GET /api/v1/clients/{clientId}/bookings/{bookingId}/cancel`;
  - `PUT /api/v1/clients/{clientId}/bookings/{bookingId}/cancel`;
  - `DELETE /api/v1/exercises/{id}`.
- `ExerciseBookingRequest` requires `paymentType` and `customFields`; subscription
  booking additionally uses the exact customer-owned `clientSubscriptionId`.
- `ExerciseBookingCancelRequest` requires `cancelExercise` and `refundMethod`.
  The actual values must come from the provider cancellation-options response
  and the observed Viva UI flow; they must not be guessed.
- For the exact annual catalogue product `Дружба 12 месяцев`, API `cost=5600000`
  corresponds to Viva UI `56 000 ₽`. This does not prove the money semantics or
  identity of the separate by-booking product.
- The approved synthetic tester is referenced in retained evidence only by the
  masked suffix `••••3190`. The latest read-only product lookup returned no
  customer subscription instance for this tester. Therefore a subscription
  booking canary is currently blocked until an independently authorized
  purchase/assignment creates an exact owned `clientSubscriptionId`.
- The requested provisional service date is `2026-08-22`; it must still be
  re-approved together with the exact free station, room, and time immediately
  before any mutation.

## Roles

Use separate people or clearly separated browser sessions where possible:

1. **LK tester** — performs only the approved user actions as the dedicated
   synthetic client. Store the full phone outside Git and evidence artifacts;
   reports use only a masked suffix.
2. **Viva observer** — confirms exercise, booking, subscription balance, and
   cancellation through read-only UI/API views. This person does not repair
   data while the test is running.
3. **Runtime observer** — watches the scoped correlation ID, Node-RED route,
   Mongo operation state, and HTTP statuses. Tokens and raw provider bodies are
   never logged.
4. **Rollback owner** — is authorized to execute only the pre-approved exact
   booking cancellation and exercise cancellation if the normal cleanup path
   does not complete.

## Gate 0 — explicit mutation approval

Before any create request, write down and approve all of the following:

- exact execution date and Moscow-time window;
- exact station ID, room ID, direction ID, and exercise type ID re-read from
  Viva immediately before the run;
- the slot is free and reserved for the canary;
- synthetic client ownership is confirmed;
- exact active customer subscription instance is confirmed and its
  `clientSubscriptionId` is recorded in a secret operator worksheet;
- the client instance belongs to the intended subscription product and station;
- current remaining visits, active-service count, and relevant booking-window
  state have been captured read-only;
- the candidate SHA and Node-RED source SHA are pinned;
- normal and emergency cleanup owners are online;
- separate approval explicitly authorizes provider and application mutations.

Stop if any item is missing. Never substitute the catalogue `productId` for a
customer `clientSubscriptionId`.

## Gate 1 — candidate construction without deployment

Pull a new live snapshot into a new external workspace. Never reuse the sample
workspace or a flow that is older than 30 minutes:

```bash
npm run nodered:modular:pull-147 -- /absolute/new/external/workspace
npm run nodered:modular:verify -- --workspace /absolute/new/external/workspace
npm run nodered:split-create-contract:patch -- \
  --workspace /absolute/new/external/workspace \
  --output /absolute/new-publication/candidate.json \
  --report /absolute/new-publication/report.json
```

Required report assertions:

- source SHA equals the newly approved live source;
- exactly one node changed;
- the only changed field is `func` on node `8f7bd5b482fe9763`;
- node IDs, wires, links, HTTP routes, and counts are unchanged;
- candidate and report remain outside the repository with modes `0600`;
- no import, deploy, restart, or provider request occurred.

If live SHA or target function SHA differs, stop and repeat review from the new
live source. Do not widen the accepted preimage list during the run.

## Gate 2 — isolated DEV functional rehearsal

Run the candidate in an isolated Node-RED DEV instance with a separate MongoDB
database and no production public route. First use a stub provider that records
only method, normalized path, top-level field names, and value types.

Expected create request:

```json
{
  "directionId": 4588,
  "typeId": 1613,
  "timeFrom": "<approved ISO date-time with +03:00>",
  "timeTo": "<approved ISO date-time with +03:00>",
  "maxClientsCount": 4,
  "roomId": "<approved Viva room UUID>",
  "trainers": [],
  "requirements": []
}
```

Assertions:

- `direction`, `type`, and `clientId` are absent from the exercise-create body;
- `directionId` and `typeId` are integers;
- `trainers` and `requirements` are arrays;
- the time interval matches the requested 60/90/120-minute game exactly;
- no booking, transaction, Mongo production write, or public publication occurs
  during the stub rehearsal.

An empty `trainers` array is schema-conformant but still requires a real
provider acceptance check for an open game without a trainer. A provider 4xx is
a stop condition; do not retry with an arbitrary trainer ID.

## Gate 3 — capture setup

Use one stable, non-secret correlation ID across the LK request, redacted
server trace, and evidence manifest. Do not place access tokens, phone numbers,
`clientSubscriptionId`, cookies, or provider credentials in the correlation ID.

Capture two complementary traces:

1. **Browser HAR** — LK DEV page to the public DEV gateway. Preserve log and
   disable cache. The HAR does not see server-to-server Viva calls.
2. **Scoped provider trace** — for the one correlation ID, record only method,
   normalized provider path template, status, duration, request top-level field
   names/types, response top-level field names/types, and hashes of the raw
   bodies. Do not record headers or raw bodies.

Run the repository HAR sanitizer before retaining any browser artifact:

```bash
npm run har:sanitize-viva -- \
  --input /absolute/raw.har \
  --output /absolute/case.sanitized.har \
  --manifest /absolute/case.manifest.json \
  --case-id MANAGED-SUBSCRIPTION-CREATE-CANCEL-001 \
  --host DEV_GATEWAY_HOST \
  --path-prefix /lk/games/split
npm run test:har-sanitizer
```

Replace `DEV_GATEWAY_HOST` with the exact hostname before execution; do not add
unrelated hosts merely to make the sanitizer retain more entries.

Delete the raw HAR after the sanitized artifact passes the privacy scan and its
SHA-256 is recorded. Never attach the raw HAR to a task or Git commit.

## Gate 4 — create and authoritative read-back

After the separate mutation approval, the LK tester performs exactly one game
creation from the approved DEV interface.

Expected sequence:

1. LK sends one idempotent split-create operation.
2. Node-RED sends one `POST /api/v1/exercises` with the Gate 2 field contract.
3. Viva returns one exercise ID.
4. Node-RED performs the existing booking step separately; the exercise-create
   request itself must not book the client implicitly.
5. Observers read the exact exercise through `GET /api/v1/exercises/{id}`.
6. Observers read the exact booking through both exercise-scoped and
   client-scoped endpoints.

Create assertions:

- one exercise exists, not two;
- station, room, direction, type, start, end, capacity, and trainer list equal
  the approved request;
- one exact client booking exists for the synthetic client;
- subscription payment uses the approved exact `clientSubscriptionId`;
- the provider response and read-back agree on booking ID and exercise ID;
- LK game metadata stores the same Viva exercise ID;
- retrying the same application idempotency key does not create another
  exercise or booking;
- a different idempotency key is not tried during the canary.

If exercise creation succeeds but the response is lost, read back by the exact
room and time interval before any retry. Do not blindly repeat POST.

## Gate 5 — subscription and restriction assertions

Record before/after values without exposing the instance ID:

- remaining subscription visits;
- number of active services under the configured definition;
- daily/weekly/monthly usage ledger counters involved in the policy;
- nearest-booking-window decision;
- station rule and surcharge decision;
- selected duration and expected visit count;
- quoted and final amount in minor RUB units, if a paid surcharge is involved.

For the first canary, select a scenario with no surcharge and no payment page.
Discount, partial-price, and surcharge cases remain blocked until the exact
by-booking product identity and money fields are independently verified.

The canary must stop before payment if the quote is not fully explained by the
published policy snapshot and provider product evidence.

## Gate 6 — normal cancellation and cleanup

Cleanup begins immediately after read-back; do not leave the synthetic event
published until the end of the observation window.

Required sequence:

1. Cancel through the normal LK game cleanup path using a new idempotency key.
2. Read provider cancellation options for the exact booking.
3. Use only the option and `refundMethod` returned for that exact booking. The
   cancel request must explicitly carry `cancelExercise` and `refundMethod`.
4. Read the exact booking again and require explicit cancelled state.
5. Confirm the subscription visit/balance was restored according to the
   provider read-back; a local counter alone is insufficient.
6. Confirm the server-side daily/active-service claim was released exactly
   once and repeated cleanup is idempotent.
7. Confirm the LK game is unpublished/archived and absent from public and
   personal-cabinet lists.
8. If the normal path does not cancel the empty creator-owned exercise, the
   rollback owner may use the separately approved exact
   `DELETE /api/v1/exercises/{id}` once, then read back the result.

Never delete an exercise if another active booking exists or ownership of the
exercise is ambiguous.

## Failure and compensation matrix

| Observed state | Required action |
|---|---|
| No exercise ID and read-back finds nothing | Stop; preserve evidence; no cleanup mutation needed |
| Create transport timeout | Read back exact room/time first; do not repeat POST blindly |
| Exercise exists, booking absent | Cancel only the exact empty synthetic exercise after approval |
| Booking exists, LK game persistence failed | Cancel exact booking, verify restored visit, then cancel the empty exercise |
| Booking cancel timed out | Read exact booking; retry only with the same cancellation operation if still active |
| Booking cancelled but visit not restored | Stop automatic cleanup, retain provider evidence, escalate to Viva; do not adjust counters manually |
| Exercise cancelled but LK still visible | Archive/unpublish the exact LK game through its idempotent cleanup operation |
| Any ID, station, client, or subscription mismatch | Stop all automatic writes and escalate; never compensate by guessed IDs |

## Multi-tester acceptance matrix

| Tester | Scenario | Expected result |
|---|---|---|
| LK tester | One approved 60-minute create with exact active subscription | One exercise and one booking; no transaction |
| Viva observer | Immediate exercise and booking read-back | IDs and all canonical fields match |
| Runtime observer | Same operation replay | No second provider create or booking |
| LK tester | Normal cancel from personal cabinet | Booking becomes cancelled; game disappears after read-back |
| Viva observer | Balance and visit read-back | Provider confirms restoration exactly once |
| Runtime observer | Repeated cleanup | Idempotent success; no negative counters or extra provider mutation |
| Second QA tester | Mobile/desktop visibility after cleanup | No card in public list or personal cabinet |

## Evidence packet

Retain only:

- candidate report and SHA-256;
- sanitized browser HAR and SHA-256;
- redacted provider trace with methods, path templates, statuses, field names,
  types, durations, and body hashes;
- before/after counters with client and subscription identifiers HMAC-hashed;
- exact exercise and booking IDs in a restricted operator artifact, not Git;
- screenshots with phone, name, tokens, and identifiers masked;
- a final cleanup checklist signed by the LK tester, Viva observer, and rollback
  owner.

The public task report contains only masked identifiers, aggregate counters,
HTTP status classes, hashes, and the final pass/fail decision.

## Definition of done

This slice is complete only when all of the following are proven:

- documented create body is accepted by Viva;
- one request creates exactly one exercise;
- one separate booking is bound to the exact synthetic client and exact
  customer subscription instance;
- exercise, booking, LK game, and ledger IDs reconcile;
- repeated create and cleanup operations are idempotent;
- cancellation restores the provider balance and releases local claims once;
- the game disappears from publications and the personal cabinet;
- all raw secrets and HAR files are deleted after reviewed sanitization;
- candidate promotion follows the separate merge, push, deploy, and postcheck
  gates.
