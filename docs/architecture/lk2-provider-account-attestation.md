# LK1 provider-account attestation (lk2 ADR 0028, contract v1)

Status: source only. Not installed on lk-primary-147, flag off by default. CRITICAL (identity, PII).

## Route

`POST /lk/integrations/v1/provider-account-attestations` in its own additive tab
(`scripts/patch_nodered_provider_account_attestation.mjs`, 9 nodes, no catch node). It reuses the receiver delegation
prelude and key ring (`LK2_BOOKED_OPERATION_DELEGATION_*`) but not the receiver tab, so the
reviewed receiver and the JOIN v2 live pins are unchanged.

Enabled only when `LK1_BOOKED_OPERATION_RECEIVER_ENABLED`, a valid delegation config and
`LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED` are all set. It does not depend on
`BOOKED_OPERATION_EXECUTION_ENABLED`.

Flag `LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED`:
- owner: product owner;
- purpose: lk2 provider mappings and the owned-subscription proof;
- activation: install plus a signed smoke with one test account;
- removal: review 30 days after lk2 enters the production lane.

## Request

Headers: `X-Subscription-Actor-Delegation`, `X-Subscription-Actor-Token`, `X-Correlation-ID`,
`Content-Type: application/json`. No query string.

Delegation JWT header: exactly `{alg:"RS256", typ:"phub-provider-account-attestation+jwt", kid}`.
Booking routes refuse this `typ`, and this route refuses the booking `typ`.

Claims, exactly this set:

| claim | value |
| --- | --- |
| `iss`, `aud` | configured issuer and audience |
| `sub`, `sid`, `jti`, `tenant_id`, `operation_id` | lowercase UUID |
| `iat`, `nbf`, `exp` | integers; `exp - iat <= 60`; `exp > now` |
| `contract_version` | `1` |
| `scope` | `lk1:provider-account:attest` |
| `caller` | `lk2-api` |
| `method`, `path` | `POST`, `/lk/integrations/v1/provider-account-attestations` |
| `tenant_key` | `iSkq6G` |
| `provider` | `VIVA` |
| `correlation_id` | equals `X-Correlation-ID` |
| `request_sha256` | see below |
| `actor_token_sha256` | `sha256:` + hex SHA-256 of the exact `X-Subscription-Actor-Token` |
| `actor_token_expires_at` | canonical ISO, later than now + clock skew |

Body: `{"contractVersion":1,"operationId":"<uuid>"}`, optionally with
`"target":{"exerciseId":"<id>"}`. No other keys. `operationId` equals the `operation_id` claim.

`request_sha256 = "sha256:" + hex(sha256("provider-account-attestation:v1\u0000" +
JSON.stringify({contractVersion, operationId, target: target ? {exerciseId} : null})))`.

Replay: the verify node remembers `operation_id` and `jti` until `exp` + clock skew. A second use
returns 409 `PROVIDER_ACCOUNT_INVALID`. The registry is in memory (Node-RED context storage is off
on LK1), holds at most 10,000 entries and fails closed with 503 when full. A restart clears it;
the 60-second delegation lifetime bounds that window. An id is remembered only after every other
check passes.

lk2 must not rely on this registry to deduplicate its own operations: after expiry or a restart the
same `operationId` with a new delegation is accepted again. That is safe because the route only
reads.

Trust boundary: LK1 proves that the presented Viva token reads this `providerClientId`. It cannot
prove that the PadlHub `sub` owns that token. lk2 guarantees this by issuing the actor token and the
delegation for the same session (`authService.issueVivaAccessToken`).

## Provider reads

Only with the actor token, without redirects, 10 s each, re-checking expiry before every hop:

1. `GET https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile`: `id`/`clientId` (one value).
2. `GET …/subscriptions?includeFinished=true&size=1000`: a bare array or one complete page.
3. With a target, `GET …/exercises/{exerciseId}`.

No Mongo, no global credential, no provider write.

## Response 200

```json
{
  "contractVersion": 1,
  "operationId": "<uuid>",
  "providerTenantKey": "iSkq6G",
  "providerClientId": "<id from the profile read>",
  "subscriptions": [{ "clientSubscriptionId": "<id>", "productId": "<uuid>|null",
    "title": "<string, at most 120 chars>|null",
    "state": "ACTIVE|NOT_ACTIVATED|PAUSED|FINISHED",
    "remainingUnits": "<int >= 0>|null", "validUntil": "<ISO>|null" }],
  "attestedAt": "<ISO>",
  "targetProof": { "exerciseId": "<id>", "startsAt": "<ISO>", "durationMinutes": 90,
    "ownedClientSubscriptionIds": ["<id>"], "eligibleClientSubscriptionIds": ["<id>"] }
}
```

`targetProof` is present only with a target. At most 50 subscriptions, ordered ACTIVE,
NOT_ACTIVATED, PAUSED, FINISHED, then by `validUntil` descending. Body at most 32 KiB.
Headers: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.

Field derivation from the Viva item:
- `clientSubscriptionId`: the explicit id aliases that `findOwnedSubscriptions` accepts; the
  end-user list uses `subscriptionId`. Conflicting aliases, a duplicate id or a `clientId` other
  than the profile's refuse the whole response.
- `productId`: `collectExactProductIds`, only when exactly one UUID; the end-user list usually has
  none, so expect `null`.
- `title`: `pickName`, control characters removed, at most 120 characters.
- `remainingUnits`: `visitsLeft` when a non-negative integer.
- `validUntil`: `expirationDate` read like the HUB money gate (`lk1LifecycleInstant`, end of day):
  a date-only value is 23:59:59.999 Moscow time, a timestamp without an offset is Moscow time.
- `state` (presentation only; every command re-verifies on LK1):
  - `PAUSED`: `holdUntil`, `frozenUntil` or `isFrozen`;
  - `NOT_ACTIVATED`: `status` `NEW` without `activationDate` (first use activates it);
  - `ACTIVE`: `status` `ACTIVE` and `expirationDate` not passed;
  - otherwise `FINISHED`.
- `targetProof`: `eventStartsAt`, `eventDurationMinutes` and `findOwnedSubscriptions` from the
  booking owner, applied to every attested id (also those beyond the 50 listed), at most 50 ids.
- Ids compare case-insensitively, as `normalizeId` does in the booking owner.
- `targetProof.eligibleClientSubscriptionIds` (unique, at most 50, a subset of owned): owned ids
  that pass the HUB JOIN rule for this exact exercise, all proved by this Viva read:
  - exactly one product id (`collectExactProductIds`), equal to `LK1_OVERLAY_HUB_PRODUCT_ID`
    (`nodered_lk1_hub_nodes/gateway.js`);
  - exactly one purchase day (`collectSubscriptionPurchaseDateEvidence`, Moscow) on or after
    `MANAGED_ENFORCEMENT_PURCHASE_FROM` (2026-09-01, booking owner);
  - `status` `ACTIVE`, `variant` `BY_VISITS`, integer `visitsLeft >= 1`;
  - activation (`lk1LifecycleInstant`) not after now and not after the game start;
  - expiry (end of day) not before now and not before the game end;
  - no `holdUntil` or `frozenUntil`, and `isFrozen` absent or `false`;
  - no row `id` naming another instance (the money gate's `instance_id_mismatch`).
  The pins and helpers are extracted from those nodes, not copied. A missing field is not
  eligible. Eligible is computed from the (at most 50) owned ids returned, so it is always a
  subset of them. **Expect it to be empty in practice:** the end-user list usually carries no
  product id (see `productId` above), and then nothing is eligible until a server-owned product
  identity is added. An empty list is the fail-closed outcome, not a defect; the post-install
  signed smoke confirms which case applies.
  Eligible does not mean "HUB-enforced at this station": station-level legacy/exclusion
  (`lk1Config`) is not part of this rule, and the booking owner re-checks on the command.

## Errors

Body `{"code": "<code>"}`.

| status | code |
| --- | --- |
| 400 | `PROVIDER_ACCOUNT_REQUEST_INVALID` |
| 401 | `PROVIDER_ACCOUNT_DELEGATION_REQUIRED`, `PROVIDER_ACCOUNT_DELEGATION_INVALID` |
| 403 | `PROVIDER_ACCOUNT_FORBIDDEN` (Viva 401/403), `PROVIDER_ACCOUNT_CONTEXT_MISMATCH`, `PROVIDER_ACCOUNT_ACTOR_TOKEN_INVALID` |
| 409 | `PROVIDER_ACCOUNT_INVALID` (inconsistent provider data, exercise 404, replay) |
| 503 | `PROVIDER_ACCOUNT_UNAVAILABLE` (disabled, transport, unparseable body, other Viva status) |

## Probe

`GET` on the same path with `X-Provider-Account-Attestation-Contract: 1` returns
`{contractVersion:1, capability:"PROVIDER_ACCOUNT_ATTESTATION", maxSubscriptions:50, targetProof:true}`.
It returns 503 when the route is disabled and 404 for any other header. It is not part of the
booking owner probe, so the reviewed owner router stays unchanged.

## Fixture

`scripts/tests/fixtures/viva-end-user-subscriptions.redacted.json` is reconstructed from the LK1
cabinet type (`src/utils/apiClient.ts`) and the live parsers, not captured. A redacted capture
with a real test account replaces it before activation.

## Install

The live packet builder must also refuse an existing `http in` whose Express pattern (parameter or
wildcard) matches this path, because such a route would receive the delegation and the actor token.

Not part of this change. It needs a live packet builder pinned to the then-current flows.json, the
reviewed-flow runner, the env flag and the owner's direct approval.
