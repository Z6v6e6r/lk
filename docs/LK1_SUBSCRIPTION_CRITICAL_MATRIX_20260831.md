# LK1 subscription critical matrix — 2026-08-31

Status: executable specification for
`codex/lk1-subscription-enforcement-20260831`.

Safety boundary:

- all browser acceptance uses the local/synthetic `FAKE_NO_VIVA` adapter;
- no test may call a Viva write, create a real booking, start a payment, or mutate
  shared CUP/provider data;
- client-provided price, eligibility, benefit, or entitlement state is never an
  authoritative decision;
- an unrecognised or incomplete response maps to a retryable technical error and
  never to a subscription discount.

The executable implementation of the `EXPECTED_DECISION` and `EXPECTED_UI`
columns is covered by `scripts/tests/subscriptionCriticalMatrix.test.ts`. Atomic
reserve/replay/readback cases are also exercised by
`scripts/tests/managedSubscriptionDevRuntime.test.ts` and
`scripts/tests/subscriptionBookingGateway.nodered.test.ts`.

## No subscription

### NS-CREATE — create game

```text
INPUT: action=CREATE_GAME, paymentMode=one_time, no clientSubscriptionId
PRECONDITION: user has no active subscription; exact slot is server-resolved
EXPECTED_DECISION: ORDINARY_PAYMENT_ALLOWED
EXPECTED_UI: "Оплата без подписки" with the exact server amount
SIDE_EFFECTS: no entitlement reserve/confirm/release; ordinary provider path only outside tests
READBACK: selectedPaymentMode=one_time; subscriptionApplied=false
```

### NS-JOIN — join game

```text
INPUT: action=JOIN_GAME, paymentMode=one_time, no clientSubscriptionId
PRECONDITION: free seat exists and user is not already joined
EXPECTED_DECISION: ORDINARY_PAYMENT_ALLOWED
EXPECTED_UI: "Присоединение без подписки" with the exact server amount
SIDE_EFFECTS: no entitlement mutation
READBACK: selectedPaymentMode=one_time; subscriptionApplied=false
```

### NS-PAYMENT — normal payment path

```text
INPUT: successful one-time response with paymentUrl and positive toPayMinor
PRECONDITION: server selected one_time
EXPECTED_DECISION: ORDINARY_PAYMENT_ALLOWED
EXPECTED_UI: ordinary payment CTA; no subscription-success wording
SIDE_EFFECTS: payment redirect may happen in production; synthetic test performs zero writes
READBACK: payment URL belongs to the ordinary response; subscriptionApplied=false
```

### NS-NO-FALSE-APPLY — subscription cannot be applied accidentally

```text
INPUT: paymentMode=subscription without an exact clientSubscriptionId
PRECONDITION: no active owned subscription instance
EXPECTED_DECISION: SUBSCRIPTION_INVALID
EXPECTED_UI: "Подписка недействительна" / choose another payment method
SIDE_EFFECTS: zero entitlement and provider writes
READBACK: SUBSCRIPTION_SELECTION_REQUIRED or SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE
```

## Active subscription

### AS-DAILY-AVAILABLE — daily use available

```text
INPUT: active instance, dailyUsed=0, action=CREATE_GAME, duration=60
PRECONDITION: policy/instance/target versions match; exact slot is available
EXPECTED_DECISION: SUBSCRIPTION_ALLOWED
EXPECTED_UI: "Можно по подписке" and zero final price
SIDE_EFFECTS: exactly one entitlement reserve followed by confirm on provider success
READBACK: entitlement state CONFIRMED; dailyUsed increases once
```

### AS-UNUSED — unused entitlement

```text
INPUT: active instance, activeServices below max, dailyUsed below limit
PRECONDITION: no matching operation exists
EXPECTED_DECISION: SUBSCRIPTION_ALLOWED
EXPECTED_UI: available benefit and exact server price/discount
SIDE_EFFECTS: one atomic entitlement reservation
READBACK: operationId, decision digest and usage units match the request
```

### AS-CONSUMED — daily entitlement already consumed

```text
INPUT: active instance, dailyUsed=1, action=CREATE_GAME or JOIN_GAME
PRECONDITION: policy uses post-limit percentage discount
EXPECTED_DECISION: ADDITIONAL_PAYMENT_REQUIRED
EXPECTED_UI: "Бесплатный лимит использован" plus exact discounted amount
SIDE_EFFECTS: no second free entitlement; paid continuation only after user action
READBACK: subscriptionApplied=true only for the discounted benefit; no free-unit decrement
```

### AS-CREATE — creation

```text
INPUT: action=CREATE_GAME with exact server-resolved station/slot/duration
PRECONDITION: active owned instance and game capacity policy permits creation
EXPECTED_DECISION: SUBSCRIPTION_ALLOWED or ADDITIONAL_PAYMENT_REQUIRED
EXPECTED_UI: server decision appears before redirect/final success notice
SIDE_EFFECTS: provider create is after final entitlement recheck; synthetic test has zero provider writes
READBACK: created booking and entitlement operation correlate by stable operationId in production
```

### AS-JOIN — join

```text
INPUT: action=JOIN_GAME with exact gameId and selected clientSubscriptionId
PRECONDITION: user is not joined, game has capacity, state is current
EXPECTED_DECISION: SUBSCRIPTION_ALLOWED or ADDITIONAL_PAYMENT_REQUIRED
EXPECTED_UI: server reason/amount, never a silent fallback
SIDE_EFFECTS: one join/booking and one entitlement lifecycle at most
READBACK: exact game/booking/subscription correlation
```

### AS-REPEAT — repeated request

```text
INPUT: the same action and the same stable operationId twice
PRECONDITION: first request completed or timed out after acceptance
EXPECTED_DECISION: same deterministic decision with replayed=true
EXPECTED_UI: the same final state; no second spinner/action
SIDE_EFFECTS: entitlement usage changes once
READBACK: same reservation/booking identity; counter delta is not duplicated
```

## Additional duration

### DUR-30 — additional 30 minutes

```text
INPUT: active subscription, duration=90, one free hour
PRECONDITION: partial-price rule matches exact target
EXPECTED_DECISION: ADDITIONAL_PAYMENT_REQUIRED
EXPECTED_UI: "60 минут по подписке" + доплата за 30 минут + exact discount
SIDE_EFFECTS: one entitlement unit; payment only for server-calculated excess
READBACK: finalPriceMinor and partialPriceCalculation match the server decision
```

### DUR-60 — additional 60 minutes

```text
INPUT: active subscription, duration=120, one free hour
PRECONDITION: partial-price rule matches exact target
EXPECTED_DECISION: ADDITIONAL_PAYMENT_REQUIRED
EXPECTED_UI: "60 минут по подписке" + доплата за 60 минут + exact discount
SIDE_EFFECTS: one entitlement unit; no browser price assertion
READBACK: finalPriceMinor is calculated from the exact server-resolved player share
```

### DUR-DISCOUNT — discount applicability

```text
INPUT: 90/120-minute decision with a matching partial-price rule
PRECONDITION: daily/active-service limits do not force full price
EXPECTED_DECISION: ADDITIONAL_PAYMENT_REQUIRED
EXPECTED_UI: exact percentage and exact discounted excess amount
SIDE_EFFECTS: discount is applied by server only
READBACK: base, discount, surcharge and final price are internally consistent
```

### DUR-INVALID — incorrect duration

```text
INPUT: duration outside 60/90/120 or response duration differs from request
PRECONDITION: none
EXPECTED_DECISION: ACTION_UNAVAILABLE
EXPECTED_UI: "Действие недоступно" and select another duration
SIDE_EFFECTS: zero entitlement/provider writes
READBACK: DURATION_NOT_ALLOWED or response-contract mismatch
```

### DUR-RETRY — duplicate/retry

```text
INPUT: repeated 90/120-minute request with the same operationId
PRECONDITION: first request has a durable operation record
EXPECTED_DECISION: identical ADDITIONAL_PAYMENT_REQUIRED decision
EXPECTED_UI: one payment/decision state
SIDE_EFFECTS: no second entitlement reservation or payment creation
READBACK: identical operation/reservation identity
```

## Edge cases

### EDGE-ALREADY-JOINED

```text
INPUT: JOIN_GAME for an existing participant
PRECONDITION: authoritative roster already contains the actor
EXPECTED_DECISION: ACTION_UNAVAILABLE
EXPECTED_UI: "Вы уже участвуете в этой игре"
SIDE_EFFECTS: zero new booking/entitlement writes
READBACK: existing membership remains unchanged
```

### EDGE-FULL

```text
INPUT: JOIN_GAME for a full game without an allowed waitlist path
PRECONDITION: authoritative capacity is full
EXPECTED_DECISION: ACTION_UNAVAILABLE
EXPECTED_UI: "В игре нет свободных мест"
SIDE_EFFECTS: zero entitlement/provider writes
READBACK: roster/capacity unchanged
```

### EDGE-STALE

```text
INPUT: create/join based on an outdated revision or changed slot
PRECONDITION: final server recheck differs from the client snapshot
EXPECTED_DECISION: STALE_STATE
EXPECTED_UI: "Данные изменились — обновите и повторите"
SIDE_EFFECTS: no blind retry and no second entitlement debit
READBACK: latest revision/slot must be fetched before a new operation
```

### EDGE-EXPIRED

```text
INPUT: selected subscription is EXPIRED or target is after activeTo
PRECONDITION: exact instance exists but is outside validity
EXPECTED_DECISION: SUBSCRIPTION_INVALID
EXPECTED_UI: "Подписка недействительна для этой даты"
SIDE_EFFECTS: zero entitlement/provider writes
READBACK: SUBSCRIPTION_EXPIRED or TARGET_AFTER_SUBSCRIPTION_EXPIRY
```

### EDGE-MISSING-INSTANCE

```text
INPUT: managed product selected but exact runtime instance is missing
PRECONDITION: no unique CURRENT instance matches clientSubscriptionId
EXPECTED_DECISION: SUBSCRIPTION_INVALID
EXPECTED_UI: "Не удалось найти активную подписку"
SIDE_EFFECTS: fail closed; no provider write
READBACK: MANAGED_SUBSCRIPTION_INSTANCE_NOT_FOUND / mapping-required code
```

### EDGE-BACKEND-UNAVAILABLE

```text
INPUT: subscription decision endpoint returns network error or 503
PRECONDITION: no authoritative decision is available
EXPECTED_DECISION: TECHNICAL_ERROR
EXPECTED_UI: "Временная техническая ошибка" with retry action
SIDE_EFFECTS: no fallback discount and no automatic provider write
READBACK: retryable=true; subscriptionApplied=false
```

### EDGE-RUNTIME-UNKNOWN

```text
INPUT: missing/invalid runtime decision, unknown response code or malformed body
PRECONDITION: client cannot prove a complete server decision
EXPECTED_DECISION: TECHNICAL_ERROR
EXPECTED_UI: "Не удалось подтвердить условия подписки"
SIDE_EFFECTS: fail closed; no entitlement/provider write
READBACK: UNKNOWN maps to a known fail-closed UI state; UNKNOWN_P0 remains zero
```

### EDGE-TIMEOUT-RETRY

```text
INPUT: timeout after submission, then retry with the same operationId
PRECONDITION: outcome of the first request is ambiguous
EXPECTED_DECISION: TECHNICAL_ERROR until idempotent readback/replay resolves it
EXPECTED_UI: retry guidance; never "успешно" before readback
SIDE_EFFECTS: retry reuses the operationId and cannot debit twice
READBACK: replay returns the original terminal or pending state
```

## Required browser acceptance

The local browser smoke must capture these six user-visible states without external
writes:

1. active subscription with available entitlement;
2. successful synthetic subscription reserve with readback;
3. active subscription with exhausted benefit limit;
4. correct full-price/additional-payment explanation;
5. no-subscription state;
6. ordinary payment path with `subscriptionApplied=false`.
