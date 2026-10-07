# Phone-free public responses

This change implements phone removal and opaque public identities. Anonymous
schedule and roster reads remain available. It does not add authentication,
change membership/role rules, deploy a flow, rotate a secret, or migrate data.

## Response contract

- Game/chat/community member and author DTOs omit telephone fields, including
  `phoneNorm`, `authorPhone`, `playerPhone`, and message `relatedPhones`.
- Result diagnostics expose status, counts and timestamps, without private
  failure records or raw provider errors.
- Existing non-phone client IDs, names, levels, tournament scores, participant
  positions/cancellation state, and rating metrics remain available.
- Phone-valued IDs, dictionary keys and embedded legacy identifiers become
  scoped `pp_` HMAC aliases. The old enumerable `rm_*` result-member hashes are
  also wrapped, including persisted session references returned by game reads.
- Issued `pp_` aliases, UUIDs and BSON ObjectIds retain their exact value and
  normal JSON representation, including after repeated projection/export. A
  coincidental phone-shaped digit sequence inside an opaque ID is not a phone.
- Successful split-payment responses and server-confirmed subscription checkout
  responses/replays retain their root provider `paymentUrl`, `bookingId`,
  `transactionId`, `productId` and `exerciseId`. The exception is limited to
  exact POST routes and recognized success contexts. Explicit phone query
  parameters, roster contacts, unrecognized metadata, other routes and errors
  remain filtered. Known game `booking`, `payment`, `metadata`,
  `metadata.splitPayment` and `metadata.splitPayment.payments[]` records also
  retain their declared booking/exercise/transaction/product references so
  payment confirmation readback can still match the original booking IDs.
- Personalized responses include presentation-only `isViewer`/`authorIsViewer`
  flags. These flags and public IDs are never authorization credentials.
- HTTP projection runs after existing response/cache branches and sets
  `Cache-Control: no-store`. Old server cache entries are projected on every read.
  CSV/XLSX data is projected before encoding. No database/provider document is
  changed by the response projection.

## Identity and write compatibility

`LK_PUBLIC_IDENTITY_HMAC_KEY` is a server-only secret of at least 32 UTF-8 bytes.
Provision a randomly generated key through the deployment secret mechanism;
never place it in Vite configuration, flow JSON, source control or a report.
There is deliberately no default key or unkeyed phone digest. A request needing
an alias fails with a generic 503 when the key is unavailable. Configuration is
a deployment prerequisite, not an action performed by this source change.

The HMAC includes a version/domain and the community/game ID or tournament
tenant and ID. The key must remain stable across nodes, reads and offline retries.
Rotation requires an explicit identity compatibility plan; old aliases will
otherwise receive 409 and require refresh.

Inbound aliases are resolved only against server-read documents:

- Tournament save/results restore the full participant graph, including pairs,
  byes, parameter references, standings and dictionary keys. Resaving a phone-free
  roster retains existing private contact fields on the server. A new private
  lookup failure terminates before the tournament write.
- Community management restores only the target `member`; exact player-rating
  reads restore only the requested `playerId`. Caller/actor identities are not
  rewritten. Existing access checks continue to run.
- Game result submit/session PATCH restore only lineup references. Trusted actor,
  role inputs, revision, score and idempotency fields remain unchanged. Unknown
  and cross-game aliases fail before the existing writer. Legacy `rm_*` input is
  accepted by existing handlers for rollout compatibility, but is never emitted.

The browser supports both old and new response shapes during rollout. Own-message,
membership and unread display use genuine IDs or viewer flags, with a legacy
phone fallback for an independently deployed old backend.

Local JSON exports sanitize imported/offline/stale browser data too. Existing
server-issued aliases remain stable. An old phone-only local identity receives a
random `manual-participant-public-*` file-local ID; the exported graph remains
consistent, but this ID cannot recover a private identity on an existing server
tournament. Such an overwrite fails with 409 until the current server data is
refreshed or the participant is selected again. Public/file-local aliases must
not be sent to Viva as client IDs; manual Viva synchronization requires selecting
the actual client. This also applies to a stable local `manual-participant-*`
record without a canonical Viva client ID: its phone is intentionally absent
from the exported file. No provider lookup or write is performed by these projections.

## Guarded candidate and release boundary

`scripts/phone_privacy_contract.json` contains only reviewed node IDs and a
whole-flow preimage hash, never a raw flow or customer records.
`scripts/patch_live_phone_privacy.mjs` inserts response/target projection nodes
and one private tournament read with a scoped error handler. It verifies that
existing code, authorization, DB settings, HTTP methods/URLs, and unrelated
fields remain unchanged; only reviewed wiring changes are allowed.

For a separately authorized release, first obtain a fresh private `live-147`
workspace with the canonical source-origin tooling. If its full-flow hash has
changed, review the new composition and update the contract; do not bypass the
hash or freshness checks. The CLI only writes a new private external directory:

```sh
node scripts/patch_live_phone_privacy.mjs \
  --workspace /absolute/private-live-workspace \
  --output /absolute/new-private-output/candidate.json \
  --report /absolute/new-private-output/report.json
```

Before activation, verify the secret is configured, Node-RED can load its built-in
`crypto` module, the exact frontend/backend candidates pass staging checks, and
rollback custody is available. Check anonymous list/detail/roster access, own
chat/unread display, moderation of a phone-only target, tournament continuation,
offline result retry, export, and absence of phone/legacy-hash material in actual
responses. On staging, also check split create/join payment redirects, confirmed
subscription checkout/replay and chat message identity after a reload. Do not
remove the key while this candidate is active. Rolling back
the backend restores the old disclosure behavior and needs a deliberate incident
decision. Previously obtained client data cannot be revoked by this patch.

## Verification

The workflow includes `publicPhonePrivacy`, `phonePrivacyCandidate`,
`frontendPhoneIdentity`, and `tournamentJson` regression suites. Tests use
synthetic identities; no live requests, customer exports, payment operations or
database writes are needed. Candidate fixtures exercise reviewed graph edges,
drift rejection, unchanged anonymous routes and fail-closed lookup errors.

The implementation was additionally replayed against a private audited source
snapshot using synthetic messages. That is source/runtime-function evidence,
not evidence of deployment. LK2 native DTOs required no change in this slice;
separate provider responses and broader auth findings remain outside this patch.
