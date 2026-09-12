# PadlHub Partner Game Membership API — integration guide (English)

Package for the partner engineering team (rusPadelUp): how to call the three methods with
which PadlHub adds an external player to an open game and creates a Viva booking on our
technical client. Payment for the game happens **on the partner side**; PadlHub never
moves money.

The Russian edition is the primary one: [`../README.md`](../README.md). This English
edition covers the same contract; where wording differs, the Russian version governs.

## Status

| Artifact | Status |
| --- | --- |
| Contract (methods, signing, errors, limits) | ready, frozen for the pilot |
| Offline kit `../../partner-game-membership-kit/` (5 reference vectors) | ready, runs without network |
| Reference signing CLI `../sign.mjs` | ready |
| Production endpoint | **deployed and activated**, verified end to end on a test game |
| Your `clientId`, HMAC key, mTLS certificate, test game, allowlist | **not issued yet** |

The production endpoint is live: on our test client the full `POST` → `GET` → `DELETE`
cycle has been exercised for real — `201 ACTIVE`, operation `COMPLETED`, Viva booking
`ON_PLACE`, then `200 REMOVED` and the booking cancelled. Partner access is still not
issued: the working Host/SNI, `clientId`, HMAC key, mTLS certificate and game allowlist
are handed over privately per [ACCESS_REQUEST.md](ACCESS_REQUEST.md).

Nothing in this repository is a production address. The public test key from the offline
kit never becomes a production key.

Until credentials are issued you can build and test your client entirely offline: the
canonical JSON, signature, header set, bodies and retries are covered by the offline kit
and `sign.mjs`.

## Model

1. The partner client takes payment in its own application.
2. The client calls `POST .../open-games/{gameId}/members` and passes a reference to that
   external settlement. PadlHub adds the player to the game (roster in LK/TSUP) and
   creates a Viva booking on our technical client.
3. PadlHub stores a payment projection `PAID` with source `EXTERNAL_PARTNER`. This is the
   **partner's declaration of an external settlement**, not a PadlHub bank transaction,
   not a fiscal receipt and not a payment through Viva.
4. `DELETE` removes only the membership created by the same integration client.
5. `GET` returns the state of your own operation, including an ambiguous outcome.

## Documents

- [JOIN_EXISTING_GAMES.md](JOIN_EXISTING_GAMES.md) — the join-an-existing-game method in one document: request, response, errors, retries, integration order.
- [INTEGRATION.md](INTEGRATION.md) — signing, endpoints, errors, idempotency, limits, quickstart.
- [ACCESS_REQUEST.md](ACCESS_REQUEST.md) — what we need from you and how access is issued.
- [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) — go-live acceptance checklist.
- [ONBOARDING.md](ONBOARDING.md) — access, environments, rotation, revocation, support.
- [DATA_PROTECTION.md](DATA_PROTECTION.md) — personal data and logging.
- [`../openapi.yaml`](../openapi.yaml) — machine-readable specification of the three routes (OpenAPI 3.1).
- [`../sign.mjs`](../sign.mjs) — reference signing CLI (Node.js 18+, no dependencies).
- [`../../partner-game-membership-kit/README.md`](../../partner-game-membership-kit/README.md) — offline vector kit.

## Language

Russian is the primary language of this package. This English edition covers the same
contract and is kept in step with it; both live in the same repository so they are
reviewed together.
