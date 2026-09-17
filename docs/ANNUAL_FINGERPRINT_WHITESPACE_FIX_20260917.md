# Годовая ХАБ: хвостовой перевод строки в отпечатке брони закрывал продажу

Дата: 2026-09-17. Статус: прод-ремонт выполнен (авторизован отдельно), кодовый фикс
готов в task-ветке, деплой на `147` не выполнялся.

## Симптом

`https://padlhub.ru/sub_hab`, вариант «год» карточки «Дружба»: цена 98 000 ₽ / год,
«Осталось: 1 / 1», кнопка «Сейчас недоступно» (`disabled`). Публичный статус:

```
GET /lk/tournaments/summer-subscription/status?counterKey=network_friendship
canPurchase: false, managedSaleReady: false, managedSaleError: "HUB_ATOMIC_LEDGER_NOT_READY"
bindingReady: true, remainingCount: 1, totalLimit: 1, price: 98000
```

Питер (`piter_friendship`) в том же выпуске продавался (`canPurchase: true`), то есть
флаги выпуска, epoch, admission и readiness-API managed-продажи были в порядке —
блокировал только HUB-леджер.

## Корень

`fn_tournament_subscription_piter_atomic_router.js` (живой узел `piter_atomic_router_20260903`,
общий для ХАБ и Питера) строит отпечатки как

```js
[toStr(ctx.inventoryId), toStr(ctx.counterKey), toStr(ctx.paymentRef),
 toStr(ctx.clientPhone), toStr(ctx.clientId)].join("\n");
```

`Array.prototype.join` вставляет разделитель и для пустого последнего элемента, поэтому
гостевой (телефонный) чекаут без `clientId` получал `intentFingerprint` и
`requestFingerprint` с **хвостовым `\n`**. Валидатор `annualHistory.validate` требует
`text(x) === x` (строка без краевых пробелов) для `intentFingerprint` активной брони, и
одна такая бронь делает невалидным весь леджер → `hubLedgerValid = false` →
`managedSaleReady = false` → `HUB_ATOMIC_LEDGER_NOT_READY` → `canPurchase = false`.

Живое подтверждение (read-only, 147):

- леджер `inventory:network_friendship_12m_20260910_epoch`: `ready: true`,
  `schemaVersion: 3`, epoch совпадает, счётчики согласованы, но `validate() === false`;
- дефект ровно в одной строке — `reservations[15]`, `PAYMENT_PENDING`, `clientId == null`,
  `intentFingerprint` 69 симв. (68 после `trim`, хвостовой `\n`), `requestFingerprint` тоже;
- бисекция живым валидатором: удаление только этой строки → `validate() === true`;
  `trim(intentFingerprint)` этой строки → `validate() === true`;
- скан всей коллекции `games.lk_tournament_subscription_sales` (4669 документов): легаси-форма
  встречается только у этого чекаута от 2026-09-15T09:24:11Z.

Следствие: с 2026-09-15 продажа ХАБ была закрыта, и каждое следующее гостевое оформление
повторяло бы поломку. Крон-реконсайлер зависших броней не помогает: он сам требует
валидный леджер (дедлок).

## Выполненный прод-ремонт (авторизован владельцем)

Точечная нормализация одной брони без изменения квот и статусов:

- документ `games.lk_tournament_subscription_sales`,
  `_id = inventory:network_friendship_12m_20260910_epoch`;
- снят хвостовой `\n` с `reservations[15].intentFingerprint` и
  `reservations[15].requestFingerprint`;
- preimage сохранён (0600):
  `/root/.node-red/.padlhub-annual-ledger-repairs-20260917/preimage-inventory_network_friendship_12m_20260910_epoch-2026-09-17T15-13-27-009Z.json`;
- CAS по `_id + revision 182 + старому значению обоих полей`; `matched 1 / modified 1`;
- postcheck: `annualHistory.validate` = true, `admissionReady` = true, revision 183,
  счётчики не изменились (`paidCount 0 / reservedCount 3 / takenCount 3`);
- публичный статус: `canPurchase: true`, `managedSaleReady: true`, `managedSaleError: null`;
- витрина: вариант «год» → «Оформить подписку» активна.

## Кодовый фикс (task-ветка)

- `scripts/nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js`:
  оба билдера (`fingerprint`, `intentFingerprint`) завершаются `.trim()`. Для всех ранее
  чистых значений отпечаток остаётся байт-в-байт прежним, поэтому сохранённые строки и
  дедупликация активных броней не ломаются.
- `scripts/tests/tournamentSubscription.summer.nodered.test.ts`:
  новый тест «HUB annual guest checkout keeps the epoch ledger valid without a clientId»
  (падает на старом билдере, проходит на новом) и приведение фикстур, кодировавших старую
  форму, к новой.
- `scripts/subscription_payment_archive_generation.json`: rebind
  `candidateSha256` для `piter_atomic_router_20260903` на новый sha256 исходника.

## Границы и остаток

- Деплой на `147` не выполнялся: до него живой код продолжит писать легаси-отпечаток на
  каждом гостером чекауте и снова закроет годовую продажу. Нужно отдельное разрешение
  CRITICAL-деплоя (source, scope, target, операции, проверка, stop-сигнал, откат).
- У того же мёртвого чекаута от 2026-09-15 легаси-форма осталась в
  `reservations[15].saleRecord.requestFingerprint` (вложенная копия) и в отдельном
  документе-продаже (`_id` с меткой `206db6dae7ee`, `status: PAYMENT_PENDING`). На
  валидность леджера и на открытие продажи они не влияют (валидатор их не читает), но
  реплей этого конкретного чекаута после деплоя будет fail-closed. Нормализация — отдельное
  решение по данным.
- Платежи, провайдерские записи, флаги выпуска и квоты не менялись.

## Проверки

- `node --experimental-strip-types --test scripts/tests/tournamentSubscription.summer.nodered.test.ts` → 143/143;
- `node --test` по `piterAtomicTopologyContract`, `subscriptionSaleOpening`,
  `subscriptionCounterEpochRuntime`, `piterAtomicActivationTools`, `annualSubscriptionHistory`,
  `habAnnualPriceCandidate`, `subscriptionPaymentPolling`, `lk1SubscriptionEnforcementCandidate` → все pass;
- `npx eslint` по изменённым файлам → без ошибок (Node-RED-исходники в ignore-списке);
- `npm run nodered:modular:validate` → не применимо без `--workspace`;
- живой postcheck статуса и витрины после прод-ремонта (см. выше).
