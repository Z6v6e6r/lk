# LK1 subscription enforcement closure — 2026-08-26

## Frozen inventory inputs

- Fresh `origin/main`: `db6ef007aab39e6dd880019a6c45f9e11c616cba`.
- Fresh main tree: `dc1ee5603cd2fa41afde1551d2bac9ec69cfe4d8`.
- Identity snapshot: `2026-08-27T00:15:56+03:00`.
- Live-147 read-only flow snapshot SHA-256:
  `14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350`.
- Live snapshot contained 4,762 nodes and passed source-origin verification.
- Merge owner: `NONE`.

The source snapshot was read only. No flow, provider, flag, payment, booking,
subscription instance, or production data was mutated during the inventory.

The unified guarded builder `prepare_lk1_subscription_enforcement_candidate.mjs`
is pinned to that exact live SHA and composes the five subscription functions,
legacy revision/CAS prerequisites, provider-authoritative payment confirmation,
and split-cleanup recovery in one source-level graph. It produced source-only
candidate SHA-256
`abe74c8e0452f8e16939da8fa1744d0c4f0690f86ba9815386f97b22d8af71d3`,
with `4762 -> 4812` nodes, `215` unchanged HTTP routes, `104` changed/added
nodes, and broken wires/links `0/0`. Split-pricing recovery nodes already matched
their current-main postimages and were not changed. Production custody is
explicitly `UNBOUND`; this candidate is not authorized for import or deployment.
Any whole-flow, target, tracked-source, route, writer, tab, or node-count drift
stops candidate generation.

## Authoritative write-path inventory

| Operation | Entry point | Identity and subscription lookup | Policy decision | Final recheck | Durable write / verdict |
| --- | --- | --- | --- | --- | --- |
| Direct tournament/group booking | `POST /lk/subscription-bookings` | Bearer Viva profile, exact exercise, exact owned `clientSubscriptionId` | existing plan/category/daily claim rules; managed plans additionally use published CUP policy | after Mongo preaccept, exact exercise and ownership are read again; managed plans then re-read the exact CUP instance revision/digest and run the evaluator again | Viva Admin booking; enforced |
| Split create with subscription | `POST /lk/games/split/create` | authenticated split context and exact selected `clientSubscriptionId` | shared subscription-booking gateway, action `CREATE_GAME` | same final Viva ownership recheck and managed CUP/evaluator recheck | Viva Admin v1 booking, then canonical projection; enforced |
| Split join/rejoin with subscription | `POST /lk/games/:gameId/split/join` | authenticated actor, exact selected instance, exact game/exercise | shared subscription-booking gateway, action `JOIN_GAME`; atomic daily/event operation covers duplicate and retry | same final rechecks | Viva Admin v1 booking, then canonical projection; enforced |
| Legacy roster join/waitlist command | `POST /lk/games/:gameId/roster-command` | Bearer actor and server-read game | canonical command/payment boundary; subscription confirmation requires exact active provider booking and exact `clientSubscriptionId` | provider read-back before projection | Mongo roster CAS; enforced |
| Generic legacy roster patch | `PATCH /lk/games/:gameId`, `PATCH /lk/games/records/:gameId` | browser payload | no safe subscription authority existed | now rejected unconditionally when `participants` or `waitlist` is present | no roster write; bypass closed |
| Direct booking release | `POST /lk/subscription-bookings`, `action=release` | Bearer profile plus exact cancelled provider `bookingId` | exact inactive booking must match the actor, client subscription, exercise, date, and claim | provider active/history read occurs before release CAS | Mongo claim becomes `RELEASED`; duplicate release is idempotent |
| Split self-leave/removal | `POST /lk/games/:gameId/split/leave` | actor/game/payment generation and exact provider bookings | exact cancellation evidence and exact subscription-instance recovery | cancellation read-back and release command | Viva cancellation plus Mongo CAS/release; enforced, ambiguous identity fails closed |
| Staff-assisted leave | `POST /lk/internal/staff/games/:gameId/player-leaves` | staff authorization and exact player/payment generation | same exact cancellation and subscription-return boundary | exact provider result before local projection | Viva cancellation plus Mongo CAS/release; enforced |
| Legacy payment confirmation | `POST /lk/games/:gameId/roster-payment-confirm` | locators only; browser paid flags are ignored | provider transaction/booking read-back; subscription evidence requires one exact active instance | read-back is the boundary | canonical Mongo projection only; ambiguous paid row cannot create entitlement |
| Managed annual status | `GET /lk/tournaments/summer-subscription/status` | selected server counter | price/inventory remain observable | `managedSaleReady=false` without authoritative sale-to-instance binding | read only; cannot advertise purchasability |
| Managed annual purchase | enabled `POST /lk/tournaments/summer-subscription/purchase` in `LK Tournaments`; disabled legacy duplicate exists in `Media2` | server counter | stable fail-closed reason `MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE` | purchase-prepare and purchase-limit both reject; builder patches every matching node in any enabled tab | no Mongo reservation, token request, or Viva transaction |
| Managed annual confirm/reconciliation | enabled confirm/reconciliation plus disabled legacy duplicates | transaction locator and provider read-back | may update a sale row only; it does not create a CURRENT entitlement | managed booking still requires exact owned instance plus CUP runtime context | sale metadata only; historical `PAID` is not entitlement |
| Classic summer/referral sale | summer and referral subscription sale routes | existing transaction identity | existing non-managed sales rules | provider read-back before `PAID` | sale row/provider capability; it is not a managed runtime entitlement |
| Padel Day | `/lk/padel-day/guard*` | Bearer profile and Padel Day booking guard | one-time transaction path; subscription is only a storefront link | booking guard re-read | not a subscription-benefit write path |
| Composite game create | `/lk/games/composite/*` | isolated draft/projection context | payment implementation is not present in this contour | n/a | does not issue a subscription booking or entitlement |

Frontend tournament and group consumers both call `/lk/subscription-bookings` for
subscription mode. Split create/join dispatches subscription mode into the same
gateway before its legacy router may create a provider booking. No additional direct
subscription booking POST was found outside that boundary.

## Lifecycle and identity invariants

- Managed entitlement is keyed by exact `clientSubscriptionId`, exact CUP
  `subscriptionInstanceId`, `policyDigest`, policy version, subscription type, and
  `instanceRevision`.
- Piter and HUB recognition requires exact provider product IDs. A managed-looking
  name without that product mapping fails with
  `MANAGED_SUBSCRIPTION_PRODUCT_MAPPING_REQUIRED`.
- Event identity is canonical and requires both Viva direction and type:
  `viva:direction:<directionId>:type:<typeId>`.
- `CREATE_GAME` and `JOIN_GAME` require `FREE_ENTITLEMENT`; price-bearing or absent
  benefits are rejected.
- `PENDING_ACTIVATION` remains closed unless the existing CUP first-use activation
  integration is configured. `FROZEN`, `EXPIRED`, `CANCELLED`, `REFUNDED`,
  `REVOKED`, no-show blocks, invalid dates, and unresolved state are rejected by the
  existing evaluator.
- Daily/event claims are atomic. Duplicate commands replay the same operation;
  ambiguous upstream outcomes remain `PENDING_CONFIRMATION` and are reconciled by
  exact provider read-back rather than repeated writes.
- A provider or local `PAID` row alone is never consumed by the booking boundary as
  CURRENT entitlement.

## TOCTOU closure

The pre-change gateway evaluated eligibility before the Mongo claim and then could
perform the Viva booking without re-reading entitlement. The final sequence is now:

`atomic preaccept -> exact Viva exercise/ownership re-read -> (managed only: exact CUP revision/digest re-read -> policy evaluator) -> Viva booking POST`

Any changed/missing exercise, plan, category, station, date, managed product,
canonical event identity, CUP revision, policy digest, lifecycle state, or
`FREE_ENTITLEMENT` causes the operation to be persisted as `FAILED` before a provider
write.

## Semantic diff of old Draft PR #2

| Old change | Classification against fresh main | Closure decision |
| --- | --- | --- |
| Exact Piter/HUB provider product IDs | still necessary | adapted into exact product extraction, including configured tier IDs |
| Name-based managed-plan recognition | incomplete on its own | retained only to detect managed-looking input, which now requires exact product identity |
| Canonical direction+type event identity | still necessary | adapted and covered by missing-direction regression |
| `FREE_ENTITLEMENT` for create/join | still necessary | adapted into the shared managed decision boundary |
| Manual `*_ready=true` sale booleans | incorrect | rejected; managed sale remains unconditionally fail closed until authoritative sale-to-instance evidence exists |
| One early eligibility decision | incomplete due to TOCTOU | replaced by exact final Viva re-read and managed CUP/evaluator recheck |
| Existing plan/category/daily-limit behavior | newer implementation already in main | preserved; no old flow was cherry-picked |
| Provider lifecycle checks in the old sales router | useful defense but not sale readiness | retained in main for provider-response validation; it does not open managed sales |

## Adversarial bypass audit

The post-change audit searched frontend callers, Node-RED source functions, all live
mutation HTTP nodes, booking/payment confirmation, split cleanup/leave, staff leave,
background reconciliation, Padel Day, composite create, and duplicate tabs.

Concrete pre-change bypasses found and closed:

1. Generic roster `PATCH` was fail-open unless a production environment flag was set.
2. Live flow retained disabled duplicate summer-subscription functions under
   `Media2`; the source-driven candidate builder previously updated only
   `LK Tournaments` and would have missed an enabled duplicate.
3. Managed policy was not re-read after the atomic claim and before Viva booking.
4. Ordinary plan ownership was not re-read after the atomic claim and before Viva
   booking.
5. Managed-looking product names and type-only event identity could reach the managed
   path without exact product and direction+type identity.
6. Managed annual status/purchase could be opened by product configuration despite no
   authoritative sale-to-current-instance binding.

No remaining known LK1 endpoint or live flow can perform a subscription booking or
roster join outside the shared authoritative boundary. Provider availability is a
separate capability and remains closed where evidence is absent.

## Verification evidence

- Critical subscription/roster/sales regression matrix: `306/306` passed.
- Unified candidate builder and drift-negative tests: `3/3` passed.
- Fresh-source LK Games modular build/validate: 315 nodes, 38 HTTP inputs,
  broken wires/links `0/0`.
- Fresh-source LK Tournaments modular build/validate: 136 nodes, 13 HTTP inputs,
  broken wires/links `0/0`.
- TypeScript build: passed.
- ESLint: zero errors; 342 pre-existing warnings remain outside this scope.
- `git diff --check`: passed.
- Full Vite production build is intentionally unavailable in the clean isolated
  worktree because required ignored production `VITE_*` values are not present;
  the build stopped in the environment assertion before TypeScript/Vite execution.
