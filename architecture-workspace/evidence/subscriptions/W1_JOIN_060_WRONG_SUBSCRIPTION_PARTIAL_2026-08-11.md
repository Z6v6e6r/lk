# W1 Live Evidence — JOIN 60 Selected the Wrong Subscription

Observed: 2026-08-11, `Europe/Moscow`.

Cases:

- `GHAR-BKG-JOIN-060`;
- `GHAR-CAN-SELF-SERVICE` cleanup follow-up.

Evidence status: `FAIL_WRONG_SUBSCRIPTION_PARTIAL_NO_HAR`.

This report contains aliases and non-sensitive runtime values only. Exact
client, game, exercise, booking, subscription and payment references, source
screenshots and their hashes remain in the private run registry outside Git.

## Authority and isolated baseline

- the user explicitly assigned `tester-entitlement-b` as a separate synthetic
  tester;
- the authenticated LK profile visibly matched that tester;
- the cabinet reported no upcoming events before join;
- the user supplied a baseline Viva screenshot showing two active
  subscriptions:
  - expected `subscription-friendship-b`: `30` remaining;
  - control `subscription-ra-b`: `27` remaining;
- `game-join-060-b` was created as a private 60-minute split-payment game on
  22 August at `station-test-yasenevo-a`;
- the organizer was the only roster member before join;
- an unintended station-community publication created with the private game
  was removed before the tester received the invite;
- no real customer and no real-money payment participated in the case.

## Exact live action

1. The tester opened the exact private invite.
2. LK showed the expected date, time, station, court, paid state and roster
   `1/4`.
3. LK exposed one generic subscription CTA: `Списать с абонемента`.
4. There was no UI control showing or selecting one of the tester's two active
   subscriptions.
5. The CTA was clicked once. It was not retried while the write was pending.
6. LK reached roster `2/4`, displayed the tester once and exposed
   `Покинуть игру`.
7. Exact games readback returned two participants and no waitlist entry.

## Failed subscription-selection contract

The Viva screenshot immediately after join proved that the control
subscription was consumed:

| Expected | Observed |
|---|---|
| Debit `subscription-friendship-b` | Debit `subscription-ra-b` |
| `30 -> 29` | `27 -> 26` |
| Control balance remains `27` | Control balance became `26` |

The source path used by game details loads eligible subscriptions, preserves
their provider order and submits `eligibleSubscriptionCandidates[0]`. The
served UI does not require an explicit subscription id when more than one
candidate is eligible. Provider ordering therefore became a hidden business
decision and selected the wrong entitlement in this live case.

This is a product and financial-integrity defect. The successful roster state
must not be treated as a passing join while the wrong client entitlement was
mutated.

## Additional join-state mismatch

Immediately after the successful-looking join:

- roster participant state was `CONFIRMED`;
- split-payment participant state was `WAITLIST`;
- waitlist collection count was `0`;
- the participant had a provider booking reference and zero amount.

The same semantic participant cannot be simultaneously confirmed in roster
and waitlisted in payment metadata. Consumers must not infer booking truth
from one of these projections without reconciliation.

## Compensating self-service leave

Because the wrong control subscription was debited, the tester performed one
compensating leave through the visible `Покинуть игру` action.

Observed authoritative LK/games results:

- the cabinet displayed `Вернули занятие на абонемент`;
- exact game readback changed roster `2 -> 1`;
- waitlist count remained `0`;
- participant payment state became `LEFT`;
- one leave event and one leave operation were recorded;
- exact tester `by-phone` readback no longer returned the game;
- before reload the cabinet still rendered the game as `В листе ожидания`;
- after a hard reload the cabinet returned to `У вас нет предстоящих событий`.

The stale waitlist card is a projection/cache defect even though authoritative
games readback and the post-reload cabinet were clean.

## Partial Viva refund evidence

The follow-up Viva screenshot contains an action-history row for the control
subscription showing `26 -> 27` after leave. In the same screenshot, however:

- `Текущий остаток` still renders `26`;
- the 22 August usage entry is still present.

Therefore the refund command/history entry is confirmed, but the provider
detail projection is not yet reconciled. A refreshed provider readback is
required before cleanup can be marked complete.

## Contract decision

| Check | Result |
|---|---|
| Exact tester and target | `PASS` |
| One join command only | `PASS` |
| One confirmed roster member added | `PASS` |
| Correct subscription selected | `FAIL` |
| Expected balance delta | `FAIL` |
| Roster/payment state consistency | `FAIL` |
| One compensating leave command | `PASS` |
| Authoritative game cleanup | `PASS` |
| Cabinet cleanup without reload | `FAIL` |
| Cabinet cleanup after reload | `PASS` |
| Refund history entry | `PASS`, `26 -> 27` |
| Refreshed provider balance and usage | `PENDING` |
| Raw HAR | `MISSING` |

`GHAR-BKG-JOIN-060` remains failed and must not be promoted to Golden
evidence. Do not repeat the live join with a multi-subscription tester until
explicit entitlement selection is implemented and verified.

## Required product and contract changes

### 1. Make subscription selection explicit

For every create/join/payment surface:

1. Load all eligible subscriptions before the mutating action.
2. Render each candidate with stable name, expiry and remaining visits.
3. If exactly one candidate is eligible, display it explicitly and submit its
   `clientSubscriptionId`.
4. If two or more candidates are eligible, require the tester to select one;
   no default based on response order is allowed.
5. The final CTA must include the chosen subscription name.
6. Disable submit until a valid candidate is selected.

### 2. Enforce the selection server-side

The join contract must require `clientSubscriptionId` for subscription mode.
The backend must validate atomically that it:

- belongs to the authenticated client;
- is active on the event date;
- has enough visits for the event duration;
- allows the event category, direction, station and date horizon;
- satisfies active-service and daily/category limits;
- has not already been consumed by the same idempotency key.

If more than one subscription is eligible and the id is absent, return a
typed `SUBSCRIPTION_SELECTION_REQUIRED` error. Never silently select the first
provider item.

The success response and persisted audit event must include the selected
subscription id, contract/type id, balance before, charged visits and balance
after.

### 3. Use one participant lifecycle state machine

Roster, waitlist, split payment and provider booking must converge on one
semantic state. A zero-amount subscription join may become `CONFIRMED` only
after the provider booking is confirmed. It must not leave payment metadata at
`WAITLIST`.

Recommended terminal states:

- `PENDING_PROVIDER`;
- `CONFIRMED`;
- `WAITLISTED`;
- `LEAVING`;
- `LEFT`;
- `FAILED_RECONCILIATION`.

Each transition needs one idempotency key and readback after an ambiguous
timeout.

### 4. Reconcile leave before navigating

After self-service leave, invalidate or refetch every projection used by the
cabinet. Do not navigate with a locally synthesized waitlist member. The
success state requires:

- participant absent from roster and waitlist;
- participant payment `LEFT`;
- exact tester booking absent from active readback;
- subscription refund confirmed;
- cabinet card absent without a manual reload.

### 5. Capture the missing Viva contract through HAR

If a fresh provider reload still shows balance `26` or the 22 August usage,
capture a sanitized HAR covering:

1. subscription detail reload with cache disabled;
2. current balance response;
3. usage-list response;
4. action-history response;
5. the leave/refund request and response if the case is rerun;
6. correlation/request ids and response status;
7. cache validators and `304` responses.

Do not infer the Viva contract from LK source code. Preserve raw HAR privately,
sanitize it with the repository tool and commit only the manifest/status.

## Regression test matrix

### Automated unit/contract tests

1. One eligible subscription: visible candidate id is submitted.
2. Two eligible subscriptions: mutation is blocked until explicit selection.
3. Reversed provider order: the selected id remains unchanged.
4. Selected subscription becomes ineligible before submit: typed failure and no
   fallback to another subscription.
5. Missing selected id with multiple candidates: server returns
   `SUBSCRIPTION_SELECTION_REQUIRED`; no provider write.
6. Id belongs to another client: forbidden; no provider write.
7. Duration/category/station/date mismatch: typed rejection.
8. Retry with the same idempotency key: one provider booking and one debit.
9. Confirmed roster requires confirmed payment/provider state.
10. Leave makes participant absent from roster, waitlist, by-phone and cabinet
    projection, and records one refund.

### Live E2E rerun with two testers

Tester A creates one private 60-minute game. Tester B must have at least two
active eligible subscriptions with distinguishable balances. Record:

1. both subscription ids/names/balances before join;
2. no active target service and no roster membership;
3. explicit selection of `subscription-friendship-b` in LK;
4. one join click plus raw HAR;
5. exact roster, payment, provider booking and balance readbacks;
6. expected target delta `30 -> 29`, control remains `27`;
7. one self-service leave plus raw HAR;
8. target refund `29 -> 30`, control remains `27`;
9. removal from active/history/public/cabinet projections after hard reload;
10. idempotent readback with no second mutation.

Run the same lifecycle for 90 and 120 minutes only after the 60-minute case
passes with explicit entitlement selection.

## Immediate next gate

1. Refresh the Viva subscription detail.
2. Confirm that current balance is `27` and the 22 August usage is absent.
3. If either value remains stale, capture the sanitized Viva HAR described
   above.
4. Keep `GHAR-BKG-JOIN-060` and self-service cleanup at `NO_GO` until the
   product fixes and clean rerun pass.
