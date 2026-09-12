# Personal data and logging

Authoritative Russian text: [`../DATA_PROTECTION.md`](../DATA_PROTECTION.md). This English
edition covers the same rules.

## Data the partner sends

| Field | Type | Notes |
| --- | --- | --- |
| `externalPlayerId` | Pseudonymous identifier | Stable player ID on the partner side |
| `displayName` | Display name | Shown in the game roster |
| `payment.reference` | Settlement identifier | External reference, not payment credentials |
| `payment.paidAt` | Time | UTC ISO |
| `payment.amountMinor`, `payment.currency` | Amount | Minor units plus ISO currency code |

**Not required and not accepted:** phone, e-mail, passport data, card numbers, payment
credentials, an arbitrary PadlHub user ID, a participant array, a Viva client or booking ID.

## What PadlHub stores

- the canonical membership (`membershipId`, `gameId`, `externalPlayerId`,
  `payment.reference`, state);
- the `PAID` payment projection with source `EXTERNAL_PARTNER` in the game record;
- operation audit records (codes, correlation, identifiers) for investigation and
  reconciliation;
- outbox events for internal processing.

## Logging

Never logged: the signature, the HMAC secret, the raw nonce, the raw IP, the full body,
`displayName`, `payment.reference`. Nonce, IP and body are represented by HMAC digests
under a separate audit key. Access logs are redacted, the request body is not written and
security headers are not written.

The same rule is recommended for the partner: log `operationId`, `correlationId`, HTTP
status, error code and latency; never log secrets or personal data.

## Retention and deletion

- `DELETE` removes the membership and withdraws the projection from the game roster.
- Audit and operation records are **not** deleted by removing a participant: they are
  needed for investigation and reconciliation. They are an operations journal, not user
  content.
- Retention and SIEM export are agreed before the pilot; audit access is a separate
  read-only role.

## Responsibility

- **Partner:** protecting secrets and certificates, separating environments, keeping
  personal data out of logs, handling error codes correctly.
- **PadlHub:** server-side security, audit, data durability, correct Viva interaction,
  controlled shutdown and recovery.
