# Integration reference

Everything on the wire: transport, headers, canonical JSON, signature, the three methods,
error codes, retries, limits and a runnable quickstart.

## 1. Transport

| Parameter | Value |
| --- | --- |
| Minimum TLS version | 1.2 |
| Client identity | mTLS, mandatory |
| CIDR as sole identity | not accepted |
| `Content-Type` | exactly `application/json`, no `charset` |
| Chunked transfer / content encoding | not supported |
| Responses | `Cache-Control: no-store`, CORS headers hidden |

The dedicated ingress accepts only the exact Host/SNI assigned to you and only the three
routes below. Query strings and fragments are rejected. The ingress strips inbound
`Forwarded`/`X-Forwarded-*` and rebuilds them from the socket peer, so forwarding headers
cannot be spoofed.

## 2. Headers

All eight proof headers are required on **all three methods, including GET**. Each appears
exactly once; duplicates of critical headers are rejected.

| Header | Format | Purpose |
| --- | --- | --- |
| `X-PadlHub-Client-Id` | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}` | Issued M2M client ID |
| `X-PadlHub-Audience` | `[a-z0-9][a-z0-9._:-]{2,127}` | Exact environment audience |
| `X-PadlHub-Key-Id` | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}` | Key version, for rotation |
| `X-PadlHub-Timestamp` | exactly 10 digits, Unix seconds | Window ±90 seconds |
| `X-PadlHub-Nonce` | `[A-Za-z0-9_-]{22,128}` | Fresh cryptorandom base64url |
| `X-PadlHub-Signature` | `v2=` + base64url (43 chars) | HMAC-SHA256 |
| `Idempotency-Key` | lowercase UUID | Business command identity |
| `X-Correlation-ID` | lowercase UUID | Attempt tracing |

`Host` must match the assigned ingress. POST and DELETE need an exact `Content-Length` in
UTF-8 bytes; GET sends no body (`Content-Length` absent or `0`).

## 3. Canonical JSON

The signature covers a canonical representation of the body, not the raw bytes you send.

- object keys sorted recursively as JS UTF-16 code units (plain `Array#sort()`);
- strings escaped as `JSON.stringify`, no Unicode normalization;
- arrays keep their order;
- numbers must be safe integers; `-0` becomes `0`;
- duplicate keys and invalid UTF-8 are rejected by the raw guard.

This is not RFC 8785. `sha256` is computed over the UTF-8 bytes of the canonical string,
lowercase hex.

Example body and its canonical form:

```json
{"externalPlayerId":"player-001","displayName":"Test Player","payment":{"reference":"pay-001","paidAt":"2026-09-01T08:59:00.000Z","amountMinor":250000,"currency":"RUB"}}
```

```json
{"displayName":"Test Player","externalPlayerId":"player-001","payment":{"amountMinor":250000,"currency":"RUB","paidAt":"2026-09-01T08:59:00.000Z","reference":"pay-001"}}
```

`sha256` = `38e85283a47d9c00aab3a4dbda49757cbd3f031c32f524376420e245d9ca6d66`.

## 4. Signature

Exactly 11 lines joined by `\n`, **no trailing newline**:

```text
PADLHUB-PARTNER-GAME-V2
<audience>
<client-id>
<key-id>
<unix-seconds>
<nonce>
<UPPERCASE-METHOD>
<exact-path-without-query>
<sha256(canonical-json-body)>
<idempotency-key>
<correlation-id>
```

Signature: `v2=` + `base64url(HMAC-SHA256(secret, signing-string))`, no `=` padding.

- `path` is the exact relative API path: no host, query, fragment, percent-encoding or
  segment normalization.
- For GET and DELETE the signed body is canonical `{}`. DELETE sends a body of exactly
  `{}` (2 bytes); GET sends no body but still signs `{}`.
- The secret is at least 32 bytes and is delivered out of band; it never appears in a
  request, in a flow or in this repository. Server-side comparison is constant time.

### Secret format

- Production keys in our keyring are stored as a **base64url** string.
- The public test key of the offline kit is the literal UTF-8 string
  `public-test-vector-key-32-bytes!!` (33 bytes) and is **not** base64url.

In `sign.mjs` the format is explicit: `--secret-format base64url` (default) or
`--secret-format utf8`.

### Verified vector

```text
clientId:    partner-test
audience:    padlhub-partner-game-test
keyId:       key-2026-09
timestamp:   1788253200
nonce:       MDEyMzQ1Njc4OWFiY2RlZjAxMjM0
method:      POST
path:        /lk/integrations/v1/open-games/game-001/members
signature:   v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo
```

Reproduce it with `../sign.mjs --json` (see [QUICKSTART](#10-quickstart)). If your code
produces a different value, stop and fix it before sending anything.

## 5. Endpoints

Namespace `/lk/integrations/v1`. The base URL, `clientId` and `audience` are issued
privately with your credentials.

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `POST` | `/lk/integrations/v1/open-games/{gameId}/members` | `members:add` | Add an external player |
| `DELETE` | `/lk/integrations/v1/open-games/{gameId}/members/{membershipId}` | `members:remove` | Remove only your own membership |
| `GET` | `/lk/integrations/v1/operations/{operationId}` | `operations:read` | Read only your own operation |

Identifier rules:

| Field | Format |
| --- | --- |
| `gameId` | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}`, canonical game ID from the server-side allowlist |
| `membershipId` | lowercase UUID from the `POST` response |
| `operationId` | lowercase UUID from a `POST`/`DELETE` response or from `GET` |
| `externalPlayerId` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, stable and never reused for another person |

`gameId` is neither a Mongo `_id` nor a legacy field. A client can only call the games
explicitly granted to it.

### POST — add a player

Closed schema: an unknown field yields `UNKNOWN_REQUEST_FIELD`.

```json
{
  "externalPlayerId": "stable-id-from-partner",
  "displayName": "Test Player",
  "payment": {
    "reference": "unique-payment-reference",
    "paidAt": "2026-09-01T08:59:00.000Z",
    "amountMinor": 250000,
    "currency": "RUB"
  }
}
```

| Field | Rules |
| --- | --- |
| `externalPlayerId` | Stable player ID on your side |
| `displayName` | Display name, non-empty within accepted bounds |
| `payment.reference` | Unique reference to the external settlement; single-use per client |
| `payment.paidAt` | Canonical UTC ISO with milliseconds (`new Date(x).toISOString() === x`) |
| `payment.amountMinor` | Safe integer, `0 … 100000000`, minor currency units |
| `payment.currency` | `^[A-Z]{3}$` |

`payment` is **mandatory**: it is the declaration of an external settlement, and
`reference` is the uniqueness fence `(clientId, payment.reference)` so that one payment
cannot mark two participants. PadlHub does not verify the amount and never moves money.

First success returns `201`:

```json
{
  "operationId": "<uuid>",
  "membership": {
    "membershipId": "<uuid>",
    "gameId": "<game-id>",
    "externalPlayerId": "stable-id-from-partner",
    "state": "ACTIVE",
    "paymentStatus": "PAID",
    "settlementSource": "EXTERNAL_PARTNER"
  }
}
```

Replaying the same business command returns `200` with the stored result. An ambiguous
outcome returns `202`:

```json
{ "operation": { "operationId": "<uuid>", "action": "ADD_MEMBER", "state": "UNKNOWN",
  "gameId": "<game-id>", "membershipId": "<uuid>", "error": { "code": "…" } } }
```

A healthy add on the activated endpoint was observed as `201` with
`membership.state=ACTIVE` and `operation.state=COMPLETED`.

### DELETE — remove a player

Body is exactly `{}`. Only the membership created by the same client can be removed.

```json
{ "operationId": "<uuid>",
  "membership": { "membershipId": "<uuid>", "gameId": "<game-id>",
                  "externalPlayerId": "stable-id-from-partner", "state": "REMOVED" } }
```

`200` on success, `202` when the outcome is ambiguous, `403 MEMBERSHIP_NOT_OWNED` for
someone else's membership.

### GET — read an operation

Reads only operations created by the same client.

```json
{ "operation": { "operationId": "<uuid>", "action": "ADD_MEMBER", "state": "COMPLETED",
  "gameId": "<game-id>", "membershipId": "<uuid>", "error": null } }
```

`state` is `COMPLETED`, `RECEIVED` or `UNKNOWN`. `404 OPERATION_NOT_FOUND` for an unknown
operation, including one belonging to another client.

## 6. Errors

Error body:

```json
{ "error": { "code": "GAME_NOT_OPEN", "message": "…", "operationId": "<uuid|null>", "correlationId": "<uuid>" } }
```

`message` is for humans, never branch on it. Branch on `code`. `operationId` may be
present when the operation already exists — then read it through `GET`.

### 400 — fix the request

`INVALID_REQUEST_BODY`, `UNKNOWN_REQUEST_FIELD`, `INVALID_EXTERNAL_PLAYER_ID`,
`INVALID_DISPLAY_NAME`, `INVALID_PAYMENT_REFERENCE`, `INVALID_PAYMENT_AMOUNT`,
`INVALID_PAYMENT_CURRENCY`, `INVALID_PAYMENT_TIME`, `INVALID_IDEMPOTENCY_KEY`,
`INVALID_CORRELATION_ID`, `INVALID_REQUEST_PATH`, `AMBIGUOUS_AUTH_HEADER`,
`INVALID_AUTH_HEADER`, `INVALID_JSON_NUMBER`, `INVALID_JSON_VALUE`, and the `RAW_*`
family (`RAW_BODY_SIZE`, `RAW_HEADERS_SIZE`, `RAW_JSON_DUPLICATE_KEY`,
`RAW_HEADER_DUPLICATE`, `RAW_JSON_INVALID`, `RAW_CONTENT_TYPE_INVALID`,
`RAW_FRAMING_INVALID`, `RAW_HOST_INVALID`, `RAW_PEER_INVALID`,
`RAW_SECURITY_HEADER_INVALID`, `RAW_JSON_COMPLEXITY`, …) which rejects the request in the
ingress guard before business logic.

**Retry:** fix the cause and send a new business command with a fresh proof. Blindly
replaying the same body is pointless.

### 401 — signature and time

`INVALID_SIGNATURE`, `INVALID_AUDIENCE`, `INVALID_TIMESTAMP`, `REQUEST_EXPIRED`,
`INVALID_NONCE`.

**Retry:** sync clocks, check keyId/secret/audience and the canonical string, then send a
**new attempt** with a new timestamp, nonce, correlation and signature, keeping the same
`Idempotency-Key` and body.

### 403 — access

`SCOPE_DENIED`, `CLIENT_DISABLED`, `STATION_ACCESS_DENIED`, `GAME_ACCESS_DENIED`,
`MEMBERSHIP_NOT_OWNED`. **Do not retry**; contact the integration owner.

### 404 — not found

`ROUTE_NOT_FOUND`, `GAME_NOT_FOUND`, `OPERATION_NOT_FOUND`. Retrying does not help.

### 409 — conflicts and ambiguity

| Code | Meaning | Action |
| --- | --- | --- |
| `REQUEST_REPLAY_DETECTED` | Nonce already used (replayed wire request) | Never resend the same wire request; a new attempt needs a new proof |
| `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key`, different method/path/body | Stop and fix the command |
| `MEMBER_ALREADY_ACTIVE` | Player already active in the game | Read the operation or membership state |
| `PAYMENT_REFERENCE_ALREADY_CLAIMED` | `payment.reference` already used | Never reuse a reference |
| `MEMBERSHIP_STATE_CONFLICT`, `MEMBERSHIP_BINDING_INCOMPLETE` | State does not allow the action | Read the operation |
| `GAME_NOT_OPEN`, `GAME_SCHEDULE_UNKNOWN`, `GAME_IDENTITY_CONFLICT` | Game not open, no schedule, contradictory identity | Do not retry; check the game |
| `GAME_FULL`, `GAME_CAPACITY_CONFLICT`, `GAME_CAPACITY_INVALID`, `GAME_CAPACITY_UNKNOWN`, `GAME_RESERVATION_FENCE_FAILED` | Capacity limit or race | Do not retry blindly |
| `VIVA_EXERCISE_UNKNOWN` | Viva did not confirm the exercise | Check through the operation |

### 202 — unknown outcome

Not an error. Read the operation with `GET`, then reconcile. **Blind provider retries and
automatic compensation are forbidden.**

### 5xx and transport

| Status / code | Meaning | Action |
| --- | --- | --- |
| `503 PARTNER_API_DISABLED` | Endpoint switched off by kill switch | Back off; this is not transient overload |
| `503 VIVA_RUNTIME_NOT_CONFIGURED`, `VIVA_TECHNICAL_CLIENT_NOT_CONFIGURED`, `KEY_CONFIGURATION_INVALID`, `AUDIT_UNAVAILABLE`, `MONGO_PREREQUISITES_MISSING`, `VIVA_SERVICE_TOKEN_UNAVAILABLE` | Runtime not ready | Back off and escalate to the owner |
| `429` | Rate limit exceeded | Back off; honour `Retry-After` when present |
| `408` / `502` / `504` | Abort, unavailability, timeout | Outcome **unknown**: read the operation with `GET` |
| `413` | Body or headers too large | Shrink the request |

### General rules

1. Repeating an HTTP request and repeating a business command are different things.
2. Any ambiguous outcome (timeout, `5xx`, abort) moves the operation to `UNKNOWN`; the
   only correct path is `GET` plus reconciliation.
3. Never perform an automatic `DELETE` or refund as compensation.
4. Alert on spikes of `INVALID_SIGNATURE`, `REQUEST_REPLAY_DETECTED`, `SCOPE_DENIED`:
   they indicate a client bug or an attack.

## 7. Idempotency, retries and replay

| Mechanism | Protects | Key |
| --- | --- | --- |
| Signature + timestamp | Request integrity and freshness | timestamp ±90 s, HMAC |
| Nonce ledger | Replay of an intercepted HTTP request | `X-PadlHub-Nonce`, single use |
| Idempotency-Key | Repeat of a business command | `Idempotency-Key` |

1. **Never resend the same wire request.** Every HTTP attempt needs a new timestamp, a new
   cryptorandom nonce, a new correlation ID and a new signature. The server inserts the
   nonce into the ledger atomically; reusing one yields `409 REQUEST_REPLAY_DETECTED`
   before any game or Viva call.
2. **Repeat after an abort.** If no response arrived (timeout, reset, `408`, `502`,
   `504`), repeat the same business command: same `Idempotency-Key`, same method, path and
   body; new timestamp, nonce, correlation and signature. The server returns the stored
   result without a second Viva call.
3. **New key for a new command.** A different player, game or intent needs a new
   `Idempotency-Key`. Never reuse one "just in case".
4. **Conflict.** The same `Idempotency-Key` with a different method/path/body yields
   `409 IDEMPOTENCY_CONFLICT` — a client bug: stop and fix the command.
5. **Parallel attempts.** If a second attempt arrives while the first is still running, the
   server returns `202` with the current state instead of starting a second operation.
   Read the operation; do not force an outcome.

Timings: the timestamp window is ±90 seconds; nonces live in the ledger for 86 400 seconds
and must not be reused even after the timestamp window passes; the idempotency result
stays available as long as the operation is stored.

## 8. Limits

| Parameter | Value |
| --- | --- |
| Maximum body size | 16 384 bytes |
| Maximum request line | 2 048 bytes |
| Maximum header size | 16 384 bytes |
| Requests per second per client | 2, burst 10 |
| Requests per second per source | 5, burst 20 |
| Concurrent requests per client | 4 |
| Concurrent requests per source | 8 |
| Upstream timeout | 15 seconds |

Rate limiting returns `429`. Use exponential backoff with jitter and honour `Retry-After`
when present. Do not "just retry" a mutation — see section 7.

## 9. Observability

Log `operationId`, `correlationId`, HTTP status, error code and latency. **Never** log the
signature, the secret, the nonce, the full body, `displayName` or `payment.reference`.

## 10. Quickstart

Requires Node.js 18+ for the examples and `sign.mjs`.

Step 0 — verify your implementation offline:

```sh
cd ../../partner-game-membership-kit
node contract-selftest.mjs --self-test
# OFFLINE_CONTRACT_VECTORS_PASS vectors=5 network=NOT_USED live_security=NOT_TESTED
```

Then reproduce the published vector:

```sh
cd ../partner-game-membership-integration-guide
printf '%s' '{"externalPlayerId":"player-001","displayName":"Test Player","payment":{"reference":"pay-001","paidAt":"2026-09-01T08:59:00.000Z","amountMinor":250000,"currency":"RUB"}}' > /tmp/member.json
node sign.mjs \
  --client-id partner-test --audience padlhub-partner-game-test \
  --key-id key-2026-09 --secret 'public-test-vector-key-32-bytes!!' --secret-format utf8 \
  --method POST --path /lk/integrations/v1/open-games/game-001/members \
  --body /tmp/member.json --timestamp 1788253200 --nonce MDEyMzQ1Njc4OWFiY2RlZjAxMjM0 \
  --idempotency-key 11111111-1111-4111-8111-111111111111 \
  --correlation-id 22222222-2222-4222-8222-222222222222 --json
```

Expected signature: `v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo`.

Step 1 — sign with your issued key:

```sh
node sign.mjs \
  --client-id "$PADLHUB_CLIENT_ID" --audience "$PADLHUB_AUDIENCE" \
  --key-id "$PADLHUB_KEY_ID" --secret "$PADLHUB_SECRET" \
  --method POST --path "/lk/integrations/v1/open-games/$GAME_ID/members" \
  --body /tmp/member.json --json
```

Keep the `Idempotency-Key` from the output: you need the same one to repeat the command.

Step 2 — send it:

```sh
curl --fail-with-body --http1.1 \
  --cert client.crt --key client.key --cacert padlhub-ca.pem \
  -X POST "https://<ASSIGNED_HOST>/lk/integrations/v1/open-games/$GAME_ID/members" \
  -H 'Content-Type: application/json' \
  -H "X-PadlHub-Client-Id: $PADLHUB_CLIENT_ID" \
  -H "X-PadlHub-Audience: $PADLHUB_AUDIENCE" \
  -H "X-PadlHub-Key-Id: $PADLHUB_KEY_ID" \
  -H "X-PadlHub-Timestamp: $TS" -H "X-PadlHub-Nonce: $NONCE" \
  -H "X-PadlHub-Signature: $SIGNATURE" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "X-Correlation-ID: $CORRELATION_ID" \
  --data "$(cat /tmp/member.json)"
```

Step 3 — read the operation with `GET` (no body, signature still over canonical `{}`),
then delete with `DELETE` and a body of exactly `{}`. Full request shapes are in the
Russian edition's `../QUICKSTART.md`, which this section mirrors.

### Minimal Node.js caller

```js
import crypto from "node:crypto";

const VERSION = "PADLHUB-PARTNER-GAME-V2";
const canonical = (v) => v === null || typeof v !== "object"
  ? JSON.stringify(Number.isSafeInteger(v) || typeof v !== "number" ? (Object.is(v, -0) ? 0 : v) : v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

async function call(method, path, body, ctx) {
  const canonicalBody = canonical(body ?? {});
  const bodySha256 = crypto.createHash("sha256").update(canonicalBody).digest("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const correlationId = crypto.randomUUID();
  const input = [VERSION, ctx.audience, ctx.clientId, ctx.keyId, timestamp, nonce,
    method, path, bodySha256, ctx.idempotencyKey, correlationId].join("\n");
  const signature = `v2=${crypto.createHmac("sha256", Buffer.from(ctx.secret, "base64url"))
    .update(input).digest("base64url")}`;
  const headers = {
    "X-PadlHub-Client-Id": ctx.clientId, "X-PadlHub-Audience": ctx.audience,
    "X-PadlHub-Key-Id": ctx.keyId, "X-PadlHub-Timestamp": timestamp,
    "X-PadlHub-Nonce": nonce, "X-PadlHub-Signature": signature,
    "Idempotency-Key": ctx.idempotencyKey, "X-Correlation-ID": correlationId,
  };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method, headers, body: method === "GET" ? undefined : canonicalBody,
  });
  return { status: response.status, body: await response.json() };
}
```

## 11. Troubleshooting

- `401 INVALID_SIGNATURE` — re-check against section 4 and reproduce the vector.
- `409 REQUEST_REPLAY_DETECTED` — you resent the same wire request.
- `400 RAW_CONTENT_TYPE_INVALID` — send exactly `application/json`, without `charset`.
- `421` — wrong `Host`/SNI for the assigned endpoint.
- `202` — read the operation, then reconcile.
