# Joining a player to an existing game

Method-focused guide: exactly what is needed to add a partner player to an **already existing
open PadlHub game**. The game is created by an organizer in TSUP; the partner neither creates
nor changes it.

- **What it does:** adds the external player to the game roster and creates a Viva booking on
  our technical client with `paymentType=ON_PLACE`.
- **What it does not do:** it does not create a game, change its schedule, take money or move a
  payment. Payment for the game happens in the partner application.

Signing, endpoints, errors, retries, limits and quickstart: [INTEGRATION.md](INTEGRATION.md).
Acceptance: [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) · access: [ACCESS_REQUEST.md](ACCESS_REQUEST.md) ·
full Russian endpoint tables: [`../ENDPOINTS.md`](../ENDPOINTS.md).

## 1. How the partner learns which games can be joined

`gameId` comes **from the list PadlHub issues together with the credentials** (the client
allowlist). The contract has no public "list games" method: a client can call only the games it
was explicitly granted, and any other game returns `403 GAME_ACCESS_DENIED`.

In practice:

- the partner stores the issued game list (`gameId`) and its related data on its side;
- the mapping between a partner game and a `gameId` is fixed by both sides during issuance;
- if dynamic game selection is needed later (catalogue, filters, live free places), that is a
  **new method**, not a parameter of this one, and must be requested separately.

Together with the games we issue: the exact Host/SNI, `clientId`, `audience`, `keyId` and
secret, the mTLS certificate, the `stationIds` and the capacity of each game.

## 2. Request

```http
POST /lk/integrations/v1/open-games/{gameId}/members HTTP/1.1
Host: <assigned host>
Content-Type: application/json

{ "externalPlayerId": "player-42", "displayName": "Ivan P.",
  "payment": { "reference": "order-2026-000123", "paidAt": "2026-09-11T12:00:00.000Z",
               "amountMinor": 250000, "currency": "RUB" } }
```

Scope: `members:add`. Query strings and fragments are rejected.

| Field | Rules |
| --- | --- |
| `gameId` (path) | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}`, only from the issued allowlist |
| `externalPlayerId` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, stable partner-side player ID, never reused for another person |
| `displayName` | Display name, non-empty string |
| `payment.reference` | Unique reference to the external settlement; single-use per client |
| `payment.paidAt` | Canonical UTC ISO with milliseconds (`new Date(x).toISOString() === x`) |
| `payment.amountMinor` | Safe integer `0 … 100000000`, minor currency units |
| `payment.currency` | `^[A-Z]{3}$` |

`payment` is **mandatory**: it declares the external settlement, and `reference` is the
uniqueness fence `(clientId, payment.reference)` so one payment cannot mark two participants.
PadlHub does not verify the amount and never moves money. The schema is closed: an unknown
field returns `400 UNKNOWN_REQUEST_FIELD`.

Headers are the eight proof headers, `Host` and `Content-Type: application/json` without
`charset`, each exactly once. The signature is HMAC v2 over canonical JSON: [signing](INTEGRATION.md#4-signature).
POST needs an exact `Content-Length` in UTF-8 bytes.

## 3. Response

First success is `201`:

```json
{ "operationId": "<uuid>", "membership": { "membershipId": "<uuid>", "gameId": "<gameId>",
  "externalPlayerId": "player-42", "state": "ACTIVE", "paymentStatus": "PAID",
  "settlementSource": "EXTERNAL_PARTNER" } }
```

- `200` — idempotent repeat of the same business command: the stored result is returned and no
  second booking is created.
- `202` — the outcome is **unknown**: the body carries `operation` with `state: "UNKNOWN"` and
  `error.code`. This is not a failure; read the operation with `GET` (section 6).

Keep `operationId` and `membershipId`: the first is needed to read state and in support
requests, the second to remove the participant.

## 4. What happens inside (the order explains the errors)

1. Proof verification: signature, freshness, duplicate headers, request shape.
2. Nonce ledger: a replayed wire request is stopped here.
3. Business-command idempotency by `Idempotency-Key`.
4. Access: client, scope, game and station from the allowlist, game open, schedule present,
   capacity available (`GAME_FULL`, `GAME_CAPACITY_*`).
5. A Viva booking is created on the technical client with `paymentType=ON_PLACE` and is then
   **verified by reading it back** (booking, client and payment type).
6. The participant is written into the game roster and the `PAID` payment projection with
   source `EXTERNAL_PARTNER`.
7. The operation is written to the audit log.

If step 5 is not confirmed, the operation stays `UNKNOWN` and the participant is not added: the
system does not confirm what it could not verify.

Partner-side verification: the participant appears in the game roster with source `PARTNER_API`
and a linked `vivaBookingId`, and `GET` of the operation returns `COMPLETED`.

## 5. Errors that matter for this method

| Code | Meaning | Action |
| --- | --- | --- |
| `400 INVALID_REQUEST_BODY` / `UNKNOWN_REQUEST_FIELD` / `INVALID_*` | Body or field outside the schema | Fix and send a new command |
| `400 RAW_CONTENT_TYPE_INVALID` | `Content-Type` is not exactly `application/json` | Fix the header |
| `401 INVALID_SIGNATURE` / `INVALID_AUDIENCE` / `INVALID_TIMESTAMP` | Signature, environment or clock | Check [signing](INTEGRATION.md#4-signature), sync the clock, retry as a **new** attempt |
| `403 GAME_ACCESS_DENIED` / `STATION_ACCESS_DENIED` / `SCOPE_DENIED` | Game, station or scope not granted | Do not retry; contact the integration owner |
| `403 MEMBERSHIP_NOT_OWNED` | Removing someone else's membership | Do not retry |
| `404 GAME_NOT_FOUND` | No such game | Check `gameId` |
| `409 MEMBER_ALREADY_ACTIVE` | Player already in the game | Read the state; do not create a second command |
| `409 PAYMENT_REFERENCE_ALREADY_CLAIMED` | `reference` already used | Do not reuse the reference |
| `409 GAME_FULL` / `GAME_CAPACITY_CONFLICT` | No places left, or a race for one | Do not retry blindly; tell the player the game is full |
| `409 GAME_NOT_OPEN` / `GAME_SCHEDULE_UNKNOWN` | Game closed or without a schedule | Do not retry; check the game |
| `409 IDEMPOTENCY_CONFLICT` | Same key, different command | Stop and fix the command |
| `409 REQUEST_REPLAY_DETECTED` | The same wire request was resent | Do not resend; a new attempt needs a new proof |
| `429` | Rate limit exceeded | Back off and honour `Retry-After` |
| `503 VIVA_*` / `MONGO_PREREQUISITES_MISSING` / `KEY_CONFIGURATION_INVALID` | Runtime not ready | Back off and escalate to the owner |
| `202` | Unknown outcome | Only `GET` the operation and reconcile |

The complete catalogue is in [errors](INTEGRATION.md#6-errors).

## 6. Retries: three different mechanisms

| Mechanism | Protects | Key |
| --- | --- | --- |
| Signature + timestamp | Integrity and freshness (±90 s) | HMAC |
| Nonce ledger | Replay of an intercepted HTTP request | `X-PadlHub-Nonce`, single use |
| Idempotency-Key | Repeat of a business command | `Idempotency-Key` |

1. **Never resend the same wire request.** Every attempt gets a new timestamp, nonce,
   correlation and signature.
2. **After an abort** (timeout, `408`, `502`, `504`) repeat the same command: same
   `Idempotency-Key`, same body, new proof headers. The answer will be the stored result.
3. **New command, new key.** Another player, another game, another intent.
4. **`202` is not an error.** `GET /lk/integrations/v1/operations/{operationId}`, then
   reconcile. Blind provider retries and automatic compensation are forbidden.

## 7. Limits

| Parameter | Value |
| --- | --- |
| Body | ≤ 16 384 bytes; `Content-Type: application/json` without `charset` |
| Headers | ≤ 16 384 bytes; duplicate critical headers and JSON keys are rejected |
| Requests per second | 2 per client (burst 10), 5 per source (burst 20) |
| Concurrent requests | 4 per client, 8 per source |
| Response timeout | 15 s; TLS ≥ 1.2, mTLS mandatory |

## 8. Removing the participant

```http
DELETE /lk/integrations/v1/open-games/{gameId}/members/{membershipId}   → 200, "state": "REMOVED"
```

The body is exactly `{}` (2 bytes), scope `members:remove`. Only a membership created by the
same client can be removed. The Viva booking is cancelled and the participant leaves the roster —
this is the correct way to roll a join back.

## 9. Integration order

1. Offline: verify your signature against the reference — [quickstart](INTEGRATION.md#10-quickstart), step 0
   (kit `../partner-game-membership-kit/`, reference signature
   `v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo`). Do not continue until it matches.
2. Receive credentials and the game list ([ACCESS_REQUEST.md](ACCESS_REQUEST.md)).
3. First `POST` against the test game; expect `201` and `state: ACTIVE`.
4. Persist `Idempotency-Key` across attempts and handle `200`/`202`.
5. Implement `GET` of the operation and branch on `error.code`, never on the message text.
6. Implement `DELETE` for rollback.
7. Pass [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) and sign the acceptance record.

## 10. What not to do

- do not treat `payment` as proof of payment on the PadlHub side: we never move money;
- do not retry a mutation blindly after an abort;
- do not run a compensating `DELETE` or refund automatically;
- do not log the signature, secret, nonce, full body, `displayName` or `payment.reference`;
- do not pass a `gameId` outside the issued allowlist;
- do not expect this method to create a game or change a schedule.
