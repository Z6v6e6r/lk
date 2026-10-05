# Клубная доплата «Дружба Топократы» по часу корта (2026-10-05)

Решение владельца от 2026-10-05 заменяет пропорциональную доплату от разового тарифа события
(решение 2026-09-26, `docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md`).

## Правило

Клубный продукт `14692232-12be-4218-9fa1-2d5b79b62035`:

1. Первый час события несёт бесплатный визит подписки — общий дневной бакет и логика посещения
   существующей клубной ветки не меняются.
2. Каждый следующий **начатый** оплачиваемый час стоит ровно **одну четверть часовой цены
   корта**: `chargeableHours × floor(hourlyCourtPriceMinor / 4)`.
   Skolkovo, 6 000 ₽/час: второй час — 1 500 ₽; трёхчасовое событие — 2 × 1 500 = 3 000 ₽.
3. Если бесплатного визита нет (дневной бакет израсходован или достигнут лимит активных
   записей) — полная разовая цена события, посещение не списывается (как и раньше).
4. Направление клуба `6180` «Топократы игра» использует ту же модель для платной части:
   игра до лимита бесплатного визита (90 минут) бесплатна, каждый оплачиваемый час — четверть
   часовой цены корта.

База доплаты — **часовая цена корта**, подтверждённая сервером для станции, корта и окна
события, а не разовый тариф упражнения и не доля игрока: `hourlyCourtPriceMinor =
round(windowTotalMinor × 60 / durationMinutes)`. Недоказанная цена часа корта — отказ
`LK1_COURT_PRICE_UNRESOLVED`, без тихого отката на тариф события (именно он давал 500 ₽).

## Источник часовой цены

- **Событие (6233/6180 через `/lk/subscription-bookings`)**: шлюз до запроса владения выполняет
  тот же запрос master-service, что и раздельная игра:
  `GET /api/v1/studios/{stationId}/rooms/{roomId}/sub-services/{subServiceId}/price?fromDate&fromTime&toTime&size=100`
  (сервисный токен). Пара `masterServiceId`/`subServiceId` берётся из проверенной таблицы
  станций (та же, что публикует `scripts/nodered_onboarding_nodes/fn_onboarding_stations.js`),
  с кэшем в `global` для станции вне таблицы; нерезолвимая станция — `LK1_COURT_PRICE_UNRESOLVED`.
- **Игра (сплит)**: тот же запрос делает шлюз; база игрока (`target.basePriceMinor`) при этом
  остаётся прежней проверенной ценой обычного сплита.
- **Превью**: тот же запрос и та же таблица в `lk_subscription_price_preview_nodes/router.js`,
  поэтому котировка и запись цитируют одну сумму.

## Коды отказа

| Код | Где | Смысл |
| --- | --- | --- |
| `LK1_COURT_PRICE_UNRESOLVED` | `gateway_hooks.js` (шаги `lk1_court_window`), `router.js` превью | Часовая цена корта не подтверждена: запрос/станция/ответ/окно/URL |
| `LK1_COURT_PRICE_UNRESOLVED` | `evaluator.js` | В решении нет `target.hourlyCourtPriceMinor`, пригодного для доплаты |
| `BENEFIT_VALUE_INVALID` | `evaluator.js` | `perHourMinor` не равен `floor(hourly / 4)` или число часов неположительно |

## Форма решения и денежный мандат

`decision.benefit = { kind: "COURT_HOURLY_COPAY", basePriceMinor, discountMinor, finalPriceMinor,
partialPriceCalculation: { chargeableHours, hourlyCourtPriceMinor, perHourMinor,
chargeBeforeDiscountMinor, percentageDiscountMinor }, currency: "RUB" }`, свободные минуты — в
`decision.courtMinutes` (для игры — `decision.gameMinutes`), `eventDiscountPercent = 0`,
`subscriptionVisitCount = 1`.

- `finalPriceMinor = perHourMinor × chargeableHours` (ограничен `basePriceMinor`).
- `discountMinor = basePriceMinor − finalPriceMinor` — скидка, которую несёт разовый
  продукт-носитель Viva; она неотрицательна, потому что доплата ограничена базой.
- `lk1ClubEventPaymentBinding` (`event_payments.js`) воспроизводит эти числа и требует
  `subscriptionVisitCount === 1`; иначе `null` и `LK1_*_PAYMENT_BINDING_INVALID`.
- Дневной учёт: `courtMinutes.freeMinutes` читает и шлюз (`lk1_usage_operations`), и превью;
  связывающий блок (`AUDIT_BINDING`) продолжает защищать игру бесплатного визита.

## Котировка превью для виджета

Событийная котировка клубной доплаты несёт собственный вид вместо процента:

```json
{ "kind": "GROUP_TRAINING_COURT_COPAY_V1", "amountMinor": 150000, "basePriceMinor": 400000,
  "discountPercent": 0, "durationMinutes": 120, "freeMinutes": 60, "paidMinutes": 60,
  "chargeableHours": 1, "hourlyCourtPriceMinor": 600000, "perHourMinor": 150000 }
```

- `discountPercent` здесь всегда `0`: доплата — деньги корта, а не доля тарифа события, поэтому
  процент её не выражает, и смысл несёт вид котировки вместе с полями часа.
- Клиент (`src/utils/groupSubscriptionDiscount.ts`) принимает новый вид только при
  `amountMinor === min(perHourMinor × chargeableHours, basePriceMinor)`, положительных целых
  `perHourMinor` и `hourlyCourtPriceMinor`, `chargeableHours >= 1` и
  `freeMinutes + paidMinutes === durationMinutes`, плюс прежние проверки личности и свежести.
  Виды `GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1` / `TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1` сохраняют
  прежнюю арифметику без ослабления.
- В окне записи (`GroupSchedulePage.tsx`) новый вид показывается как
  «Доплата 1 500 ₽ за 1 ч по подписке «Дружба Топократы»», а не как «Скидка N %».
- В шлюз по-прежнему уходят только `basePriceMinor`, `amountMinor`, `productId`, `startsAt`,
  `durationMinutes`, `discountPercent`; `discountPercent = 0` совпадает с
  `decision.eventDiscountPercent` клубного решения.

## Затронутые файлы

| Файл | Что |
| --- | --- |
| `scripts/nodered_lk1_hub_nodes/evaluator.js` | Ветки 6233/6180: `COURT_HOURLY_COPAY`, `courtMinutes`, помощники часа корта, `LK1_COURT_PRICE_UNRESOLVED` |
| `scripts/nodered_lk1_hub_nodes/gateway.js` | `target.hourlyCourtPriceMinor` из `lk1TariffProof.windowTotalMinor`; чтение `decision.courtMinutes` в дневном учёте |
| `scripts/nodered_lk1_hub_nodes/gateway_hooks.js` | Проверка окна корта: таблица станций, шаги `lk1_court_service`/`lk1_court_window`, запрос в profile-шаге |
| `scripts/nodered_lk1_hub_nodes/event_payments.js` | `lk1ClubEventPaymentBinding` принимает `COURT_HOURLY_COPAY` |
| `scripts/nodered_subscription_price_preview_nodes/router.js` | Тот же запрос окна корта, проверка арифметики и цитирование `COURT_HOURLY_COPAY`; событийная котировка нового вида |
| `src/utils/groupSubscriptionDiscount.ts` | `GROUP_TRAINING_COURT_COPAY_V1`: тип, строгая проверка суммы и полей часа |
| `src/components/group-schedule/GroupSchedulePage.tsx` | Метка «Доплата … за N ч по подписке» для нового вида |
| `scripts/patch_live_lk1_patriots_friendship.mjs` | Перепин `reviewedPreviewSource` на изменённые байты роутера |
| `scripts/patch_live_lk1_hub.mjs` | Композиция несёт новые хуки |
| `scripts/patch_live_lk1_topokraty_friendship_hotfix.mjs` | `patchTopokratyCourtWindowBody()`, пины фрагментов окна корта, перепин reviewed-решателя |
| `scripts/patch_live_lk1_topokraty_copay_hotfix.mjs` | Генерация внедряет окно корта и пересобирает превью (4 узла) |
| `scripts/patch_live_lk1_plan_rules.mjs` | Перепин `PLAN_RULES_REVIEWED_EVALUATOR_SHA256` |
| `scripts/tests/lk1TopokratyFriendship.test.mjs` | Явные числа Skolkovo, отказ без цены корта, игра, мандат, превью, маркеры |
| `scripts/tests/topokratyFriendshipHotfix.test.mjs` | Пин поколения решателя и отказ на чужом теле |

## Проверки (LOCAL)

- `node --experimental-strip-types --test scripts/tests/lk1TopokratyFriendship.test.mjs` — 28/28 PASS.
- `node --experimental-strip-types --test` по `scripts/tests/lk1*.test.{mjs,ts}` — 478 тестов,
  387 pass, 91 skip, 0 fail.
- Подписочные наборы (`topokraty*`, `proTraining*`, `patriots*`, `groupEventPayment*`,
  `subscription*`, `groupSubscriptionDiscount*`) — 741 тест, 619 pass, 118 skip, 4 fail; все 4
  (`subscriptionBindingPatch` ×2, `subscriptionReturnVerificationPatch` ×2) падают одинаково на
  чистом `origin/main` (`7779e163`).
- `tsc --noEmit -p tsconfig.app.json` — 0 ошибок; `eslint` по изменённым файлам — 0 ошибок
  (Node-RED источники исключены конфигом); `git diff --check` — чисто.
- `new Function` parse-check каждого изменённого тела Node-RED (решатель, платёжный мандат,
  шлюз, собранные хуки, роутер превью).

## Остаточные риски

- **Схема живого Viva не проверена на сервере 147.** Запрос цены окна корта и таблица станций
  взяты из уже проверенного раздельного пути (`fn_split_router.js`, `apiClient.ts`,
  dev-фикстура `scripts/lk1_subscription_visit_dev/fixture.mjs`); отдельного живого pull для
  события не было. До свежего pull нужно подтвердить, что
  `products/master-services/{id}/price` отвечает для группового события теми же полями
  (`from`/`total`).
- **Обобщение >2 часов.** Правило реализовано как `chargeableHours × floor(hourly/4)`:
  трёхчасовое событие — 2 доплатных часа. Это обобщение решения владельца, а не отдельно
  согласованная формула.
- **Живые пины.** `live*Sha256`/`patched*Sha256` в `patch_live_lk1_topokraty_*_hotfix.mjs` и
  `HUB_PREIMAGES`/`preimages.json`/`PLAN_RULES_TARGETS` не тронуты: они пересчитываются при
  свежем pull и повторном review, иначе патчеры падают на preimage-guard.
- **Кэш станции вне таблицы.** Резолвер читает кэш из
  `global "subscriptions_lk1_court_service:<stationId>"` со значением
  `JSON.stringify({ masterServiceId, subServiceIds: [subServiceId], roomId })`, но ни один
  источник репозитория его не пишет: станция вне проверенной таблицы закрывается отказом, пока
  её пара не добавлена в таблицу (или в кэш). Динамическое разрешение через
  `/api/v1/studios/{id}/rooms/{id}` не реализовано намеренно — без живого подтверждения его
  схема была бы догадкой.
