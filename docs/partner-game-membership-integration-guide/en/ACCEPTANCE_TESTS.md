# Pre-launch acceptance tests

Checklist for the test environment. Every item states a concrete expected behaviour, not a
general description. The "Verified by us" column marks whether that behaviour has been
observed live on our production endpoint (`yes`) or follows from the contract and is
verified on your side (`contract`).

Substitute your own test values: `<HOST>`, `<GAME_ID>`, `<MEMBERSHIP_ID>`. Real values
arrive with your credentials.

## A. Offline, no network

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| A1 | `node contract-selftest.mjs --self-test` in the offline kit | `OFFLINE_CONTRACT_VECTORS_PASS vectors=5 network=NOT_USED live_security=NOT_TESTED` | contract |
| A2 | Your signing code on the published vector `POST_BASE` | `v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo` | yes |
| A3 | `POST_RETRY`: same `Idempotency-Key`, same body, new timestamp/nonce/correlation | Signature changes, `Idempotency-Key` unchanged | contract |

## B. Transport and ingress

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| B1 | Request without a client certificate | Rejected before business logic (`400`, handshake failure/`403`) | yes |
| B2 | Request with a foreign `Host`/SNI | `421` | yes |
| B3 | TLS below 1.2 | Rejected | yes |
| B4 | Route outside the three issued ones | `404 ROUTE_NOT_FOUND` | yes |
| B5 | Request from an IP outside the allowlist | `403` from the ingress | yes |
| B6 | `Content-Type: application/json; charset=utf-8` | `400 RAW_CONTENT_TYPE_INVALID` | yes |
| B7 | Response carries `Cache-Control: no-store` and no CORS headers | yes | yes |

## C. Happy path

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| C1 | `POST /open-games/<GAME_ID>/members` with a valid signature | `201`, `membership.state=ACTIVE`, `paymentStatus=PAID`, `settlementSource=EXTERNAL_PARTNER` | yes |
| C2 | `GET /operations/<OPERATION_ID>` from C1 | `200`, `operation.state=COMPLETED`, `error=null` | yes |
| C3 | The participant appears in LK/TSUP and Viva holds a booking on the technical client with `paymentType=ON_PLACE` | yes | yes |
| C4 | `DELETE /open-games/<GAME_ID>/members/<MEMBERSHIP_ID>` with a body of exactly `{}` | `200`, `membership.state=REMOVED` | yes |
| C5 | `GET` of the removal operation | `200`, `state=COMPLETED` | yes |
| C6 | The Viva booking is cancelled | yes | yes |
| C7 | A second participant in the same game | `201`, a separate booking; participants do not conflict | yes |

## D. Idempotency and replay

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| D1 | Repeat C1 with the same `Idempotency-Key`, same body, new proof | `200`, the same `operationId` and `membershipId`, no second booking | contract |
| D2 | Same `Idempotency-Key`, different body | `409 IDEMPOTENCY_CONFLICT` | contract |
| D3 | Resend the identical wire request (same nonce) | `409 REQUEST_REPLAY_DETECTED` | contract |
| D4 | Repeat `DELETE` | Same result, state `REMOVED` | contract |
| D5 | Abort the connection and repeat the command with the previous `Idempotency-Key` | The result is not duplicated | contract |

## E. Access control

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| E1 | Game outside the allowlist | `403 GAME_ACCESS_DENIED` | contract |
| E2 | Station outside the allowlist | `403 STATION_ACCESS_DENIED` | contract |
| E3 | `DELETE` of someone else's membership | `403 MEMBERSHIP_NOT_OWNED` | contract |
| E4 | Missing scope | `403 SCOPE_DENIED` | contract |
| E5 | Disabled client or key | `403 CLIENT_DISABLED` / `401 INVALID_SIGNATURE` | contract |

## F. Validation

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| F1 | Unknown field in the body | `400 UNKNOWN_REQUEST_FIELD` | contract |
| F2 | Wrong signature | `401 INVALID_SIGNATURE` | contract |
| F3 | `X-PadlHub-Audience` of another environment | `401 INVALID_AUDIENCE` | contract |
| F4 | Timestamp outside ±90 s | `401 INVALID_TIMESTAMP` / `REQUEST_EXPIRED` | contract |
| F5 | `Idempotency-Key` that is not a lowercase UUID | `400 INVALID_IDEMPOTENCY_KEY` | contract |
| F6 | `payment.reference` already used | `409 PAYMENT_REFERENCE_ALREADY_CLAIMED` | contract |
| F7 | Player already active in the game | `409 MEMBER_ALREADY_ACTIVE` | contract |
| F8 | Duplicate critical header | `400 RAW_HEADER_DUPLICATE` | yes |
| F9 | Duplicate JSON key | `400 RAW_JSON_DUPLICATE_KEY` | yes |

## G. Limits and ambiguous outcomes

| # | Action | Expected | Verified by us |
| --- | --- | --- | --- |
| G1 | Exceed 2 rps per client | `429` | contract |
| G2 | Body larger than 16 384 bytes | `413` or `400 RAW_BODY_SIZE` | contract |
| G3 | Forced timeout after sending | `202` and `state=UNKNOWN`; only `GET` afterwards | yes |
| G4 | `202` handled per section 7 of [INTEGRATION.md](INTEGRATION.md): no blind provider retry, no automatic `DELETE` | yes | contract |

## H. Sign-off

- [ ] All items A–G passed on the test environment.
- [ ] Any deviation is recorded in writing and closed.
- [ ] Secrets and private keys live in secure storage; test and production are separated.
- [ ] Logs contain no signature, secret, nonce, body, `displayName` or
      `payment.reference`.
- [ ] Revocation behaviour and the escalation path are defined.
- [ ] The go-live checklist in [ONBOARDING.md](ONBOARDING.md) is signed by both sides.

Items marked `yes` were already observed on our endpoint against a test game and serve as
the reference for expected values. Items marked `contract` are verified on your side and
confirmed by the acceptance record.
