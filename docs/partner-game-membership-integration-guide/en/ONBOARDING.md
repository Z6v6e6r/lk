# Onboarding: access, environments, rotation, revocation, support

The exact data we need from you and the issuance order are in
[ACCESS_REQUEST.md](ACCESS_REQUEST.md). Pre-launch verification is in
[ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md).

## What PadlHub issues

Individually, privately, separately for each environment:

| Artifact | Purpose |
| --- | --- |
| Base URL and exact Host/SNI | Working API address |
| `clientId` | M2M client identifier |
| `audience` | Exact environment string (part of the signature) |
| `keyId` + secret | HMAC key (base64url, ≥32 bytes) |
| CA + client mTLS certificate | Transport identity |
| Allowlist | Permitted `stationIds` and games with capacity |
| Scopes | `members:add`, `members:remove`, `operations:read` |

No questionnaire and no formal contract negotiation are required: PadlHub provides the
methods and a fixed contract, the partner implements the client. The public test key from
the offline kit never becomes a production key.

## Environments

- Test and production receive **different** `clientId`, `audience`, HMAC key and mTLS
  certificate. Reuse between environments is forbidden.
- `X-PadlHub-Audience` is part of the HMAC: a request captured in test will not be accepted
  in production even if the client ID happens to match.
- The client must store environment configuration explicitly rather than toggling a flag.

## mTLS certificate

1. The partner generates the private key and CSR **locally**; the private key never leaves
   the partner infrastructure.
2. The CSR is transferred to us over an agreed private channel.
3. PadlHub signs the certificate and returns it together with the CA.
4. The certificate is bound to one environment and one client.

CIDR is used only as an additional restriction, never as the identity itself.

## Key rotation

Rotation without an outage:

1. PadlHub adds a new `keyId` alongside the old one;
2. the partner switches the client to the new `keyId`;
3. after an agreed grace period the old key is disabled, then removed.

The partner must be able to take the new `keyId` from configuration, not from code.

## Revocation

During an incident PadlHub disables the client or a specific key at the ingress. The client
sees `403 CLIENT_DISABLED` / `SCOPE_DENIED` or `401 INVALID_SIGNATURE`. On those codes you
must **stop mutations** and contact the integration owner instead of retrying.

## Pre-launch checklist

- [ ] Your signing code matches the reference on the offline vectors.
- [ ] Secrets and private keys live in secure storage, not in the repository or logs;
      test and production are separated.
- [ ] `Idempotency-Key` is preserved across attempts of one command.
- [ ] `202`, `409`, `429`, `408/502/504` are handled per
      [INTEGRATION.md](INTEGRATION.md) sections 6 and 7.
- [ ] Logs contain no signature, secret, nonce, body, `displayName` or
      `payment.reference`.
- [ ] Backoff accounts for the rate limits in section 8.
- [ ] Behaviour on access revocation is defined.

## What not to send

Request dumps containing secrets, private keys, certificates over an open channel, or real
personal data of test players. Public vectors are sufficient to verify your signature.

## Personal data

PadlHub stores the membership projection: `externalPlayerId`, `displayName`, the
`payment` declaration, the game and station identity, and the booking reference in Viva.
Logs and audit records are built so that they do not carry the signature, the secret, the
nonce, the full request body, `displayName` or `payment.reference`. See
[DATA_PROTECTION.md](DATA_PROTECTION.md) for the full rules; the Russian edition's
`../DATA_PROTECTION.md` is authoritative.

## Support

The point of contact and the escalation channel are provided by the PadlHub integration
owner together with the credentials; they are deliberately not published in this
repository. When reporting an incident include `operationId`, `correlationId`, the UTC
time, the HTTP status and the error code — never secrets or personal data.
