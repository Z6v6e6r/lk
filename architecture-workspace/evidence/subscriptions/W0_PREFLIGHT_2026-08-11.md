# W0 Read-only Preflight — 2026-08-11

Observed at: `2026-08-11T06:35:16Z` / `2026-08-11T09:35:16+03:00`

Decision: `NO_GO` for `GHAR-BKG-JOIN-060` and
`GHAR-CAN-SELF-SERVICE`.

This report contains aliases and public runtime/catalog values only. Raw client,
subscription, booking, exercise and station ids were not copied to Git.

## Scope

Performed read-only:

- opened the current LK and legacy subscription catalog;
- observed active subscription and booking cards;
- opened one non-mutating game detail view;
- switched to booking history and confirmed that it loads;
- read the public release manifest;
- checked browser console errors/warnings.

Not performed:

- join/create/payment/cancellation/refund;
- profile edit, subscription share or form submit;
- Mongo, Viva, Node-RED or production mutation;
- raw HAR export or storage access.

## Runtime fingerprint

| Field | Observed |
|---|---|
| LK entrypoint | Production `padlhub.ru/lk_new?authMode=viva` |
| Static origin | `padlhub.su/lk` |
| Release version | `20260811T034751Z` |
| Source commit | `ed809293390ca538ec4757c0f303880c5e00286f` |
| Source branch | `main` |
| Source dirty | `false` |
| Loaded bundles | `bundle.js`, `games.js`, `communities.js` with the same release version |
| Browser console | No observed errors or warnings during W0 pages |

This is a served-runtime fingerprint, not proof of provider state.

## Identity candidate

The authenticated profile is assigned alias `candidate-client-a`.

| Gate | Result | Reason |
|---|---|---|
| Synthetic/test ownership confirmed | `NO` | Visible profile looks like a normal named account; no test-owner attestation |
| Exact provider client id stored privately | `NO` | Not exposed by visible UI and was not extracted from auth/session storage |
| Safe for write tests | `NO` | Synthetic status and compensation authority are unknown |

The account must not be used for W1 until the owner explicitly confirms it is a
test account or supplies a separate synthetic tester.

## Subscription candidate

Observed alias `candidate-subscription-sport-a`:

- displayed type: `Лето.Падел.Спорт`;
- displayed state: active;
- displayed validity end: `2026-09-01`;
- subscription share action exists but was not opened;
- exact `clientSubscriptionId` is not visible;
- provider visits balance is not visible;
- the wallet amount in LK is not treated as a visits balance.

The active Sport subscription was not present as a separate offer in the
observed legacy catalog. Name matching cannot prove which provider product or
station mapping owns the active contract.

## Active/history readback surfaces

| Surface | Result |
|---|---|
| Active booking cards | `AVAILABLE` |
| History UI | `AVAILABLE`, loaded without network error |
| Cancelled/completed markers in history | `OBSERVED` |
| Exact active/history booking id consistency | `NOT_VERIFIED` |
| Subscription visits balance before action | `NOT_AVAILABLE` |
| Cancellation options/refund method | `NOT_READ` — no safe exact booking selected |

UI availability is not sufficient for Golden HAR approval; exact ids and
provider balance readback remain mandatory.

## Game candidates

### `candidate-game-a`

- 60-minute game;
- visible station label: Сочи;
- at least one other participant is present;
- cancellation action is available.

Decision: `REJECTED_FOR_TEST`. Another participant may be a real client, so the
game cannot be used for join/cancel evidence.

### `candidate-game-b`

- 60-minute card;
- visible station label: Ясенево;
- card shows only the authenticated organizer;
- detail view returns `Game not found`;
- detail view shows unpaid state;
- authoritative station, court and start time are missing in details.

Decision: `REJECTED_FOR_TEST`. This is a broken/synthetic projection candidate,
not an exact authoritative game for W1.

## Legacy catalog snapshot

Observed values are current UI state only, not the proposed annual-subscription
contract:

| Offer alias | Displayed price | Availability |
|---|---:|---|
| `legacy-academy` | 23 800 RUB | CTA available; count not shown |
| `legacy-ra` | 23 800 RUB | `0/7`, limit exhausted, countdown visible |
| `legacy-friendship` | 9 800 RUB | `61/100`, CTA available |
| `legacy-energy-5` | 19 800 RUB | CTA available; count not shown |

No purchase CTA was activated. These counters do not prove atomic inventory,
price snapshots or Buyers/LTV contracts.

## Browser evidence capability

The automated Chrome extension transport was unavailable even though Chrome was
running and the extension/native-host checks were healthy. The authenticated
in-app browser supported read-only UI observation but does not provide the raw
DevTools HAR needed for Golden evidence.

Before W1, either:

1. restore the Browser plugin/Chrome connection and verify HAR export, or
2. assign a human browser tester to capture raw HAR manually in Chrome DevTools.

## GO/NO-GO matrix

| W1 requirement | Result |
|---|---|
| Approved environment/mutation window | `NO` |
| Confirmed synthetic tester | `NO` |
| Exact provider client id | `NO` |
| Exact active `clientSubscriptionId` | `NO` |
| Visits balance `B0` | `NO` |
| Product/Viva-approved `D60` | `NO` |
| Safe 60-minute target without real clients/money | `NO` |
| Exact game/exercise/station/type ids | `NO` |
| Active/history exact-id readback | `NO` |
| Approved subscription-return option | `NO` |
| Cleanup owner/procedure | `NO` |
| Private HAR capture path | `NO` |

Decision remains `NO_GO`. No partial UI observation can waive these gates.

## What unlocks W1

1. Confirm or supply a synthetic tester account.
2. Privately provide exact client/subscription/product/station ids.
3. Provide authoritative visits balance readback and approve `D60`.
4. Prepare a disposable 60-minute game with no real participants or money.
5. Privately record exact LK game/Viva exercise/type ids.
6. Confirm the subscription-return cancellation option through read-only Viva
   inspection or a current sanitized HAR.
7. Assign mutation window, test owner, cleanup owner and reviewer.
8. Prepare Chrome DevTools HAR capture or repair the Browser plugin connection.
