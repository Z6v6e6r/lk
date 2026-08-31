# LK1 subscription browser acceptance — 2026-08-31

## Safety boundary

- URL: `http://127.0.0.1:3036/lk_subscription_dev`
- Runtime: `MANAGED_SUBSCRIPTIONS_DEV_RUNTIME=1`
- Policy: in-memory `annual-shadow` fixture
- Adapter: local fake provider only
- Viva writes: none
- CUP writes: none
- Payment/debit calls: none
- Browser console errors: 0

All subscription decision/mutation requests in the browser network log used only these
local endpoints:

- `POST /__dev/managed-subscriptions/seed`
- `POST /__dev/managed-subscriptions/quote`
- `POST /__dev/managed-subscriptions/reserve`
- `POST /__dev/managed-subscriptions/ordinary`

The existing application bootstrap also emitted Firebase configuration/installation
and Google Analytics traffic. No request to Viva, CUP, a payment provider, or an LK
production mutation endpoint was present.

## Acceptance readback

| # | User state and action | UI readback | Side-effect readback | Result |
| --- | --- | --- | --- | --- |
| 1 | Active subscription, zero active services, create 60 minutes | `Разрешено`; `первые 60 минут бесплатно`; `итого 0 ₽` | Quote only; reserve button enabled | PASS |
| 2 | Confirm the available entitlement | `Создать DEV-резерв` completes | Active services changed `0 -> 1`; ledger added one `RESERVATION_CREATED` | PASS |
| 3 | Repeat the same reserve request | Same successful decision | Both POST bodies used the same operation id; active services remained `1` | PASS |
| 4 | Join 60 minutes after the free daily entitlement was used | `Разрешено`; `бесплатный час использован`; `скидка 30% 450 ₽`; `итого 1 050 ₽` | Quote only | PASS |
| 5 | Active-service limit exhausted (`4 / 4`), create 60 minutes | `Разрешено без подписки`; `лимит льгот подписки исчерпан`; `без скидки`; `итого 1 500 ₽` | Subscription reserve is not offered; explicit full-price continuation is offered | PASS |
| 6 | User without an active subscription, ordinary create path | `Разрешено без подписки`; `активной подписки нет`; `без скидки`; `итого 1 500 ₽` | `ORDINARY_PAYMENT_ALLOWED`; entitlement counters unchanged | PASS |

## Duplicate request evidence

Both browser reserve requests used the same stable id:

```json
{
  "targetId": "create-station-a-60-aug18",
  "operationId": "reserve:create-station-a-60-aug18:<stable-session-uuid>"
}
```

The UUID is intentionally redacted from this tracked artifact. Playwright readback
showed the same concrete value in both request bodies and an unchanged active-service
counter after replay.

## Artifact limitation

Playwright DOM snapshots and request/console readback completed successfully. The CLI
image capture exceeded its fixed five-second screenshot timeout, so no PNG is included;
this did not affect interaction, decision, counter, request-body, or console evidence.
