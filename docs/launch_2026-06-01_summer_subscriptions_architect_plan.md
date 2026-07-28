# Launch Plan — Summer Subscriptions + Split Games (2026-06-01)

Дата подготовки: 2026-05-31
Целевой запуск: 2026-06-01
Область: `Лето.Падел.Дружба` / `Лето.Падел.Спорт` + split-игры (`/lk/games/*`)

## User Cases

### Матрица A: Абонементы «Лето.Падел.*»

| ID | Тариф | Сценарий | Точки потока | Ожидаемый результат | Критерий приёмки |
| --- | --- | --- | --- | --- | --- |
| SUB-01 | Friendship + Sport | Открытие страницы без авторизации | `tournament-subscription.js` → `GET /lk/tournaments/summer-subscription/status` | Карточки 2 тарифов видны до логина, показывается `Доступно X из Y` | Обе карточки рендерятся, кнопка активна при `remainingCount > 0` |
| SUB-02 | Friendship + Sport | Логин после клика «Оформить подписку» | `TournamentSubscriptionPage` + `AuthForm` | После логина выполняется отложенный старт покупки выбранного тарифа | Покупка продолжается без повторного клика |
| SUB-03 | Friendship | Покупка (create transaction) | `POST /lk/tournaments/summer-subscription/purchase` (`planType=friendship`) | В `lk_tournament_subscription_sales` создаётся `PAYMENT_PENDING` c `campaignKey=summer_padel_friendship_2026` | Ответ `201`, есть `paymentRef`, при `toPay>0` есть `paymentUrl` |
| SUB-04 | Sport | Покупка (create transaction) | `POST /lk/tournaments/summer-subscription/purchase` (`planType=sport`) | В `lk_tournament_subscription_sales` создаётся `PAYMENT_PENDING` c `campaignKey=summer_padel_sport_2026` | Ответ `201`, есть `paymentRef`, при `toPay>0` есть `paymentUrl` |
| SUB-05 | Friendship + Sport | Исчерпан лимит (до 50/план) | `fn_tournament_subscription_purchase_limit.js` | Покупка блокируется | Ответ `409` с текстом про исчерпанный лимит |
| SUB-06 | Friendship + Sport | Confirm после успешной оплаты | `POST /lk/tournaments/summer-subscription/confirm` + Viva `/transactions/:id` | Статус продажи обновляется в `PAID` | Ответ `200`, `paid=true`, `status=PAID`, статус в `/status` уменьшает остаток |
| SUB-07 | Friendship + Sport | Confirm при неуспешной оплате | `confirm` + Viva transaction status | Статус продажи `FAILED` | Ответ `200`, `failed=true`, `status=FAILED` |
| SUB-08 | Friendship + Sport | Confirm при ожидании банка | `confirm` + Viva transaction status | Статус продажи остаётся `PAYMENT_PENDING` | Ответ `200`, `paid=false`, `failed=false` |
| SUB-09 | Friendship + Sport | Автообновление статуса на странице | FE polling каждые 30с + ручной confirm по `summerPaymentRef` | Пользователь видит актуальный остаток без перезагрузки | После confirm/покупки `remainingCount` синхронизируется |
| SUB-10 | Friendship + Sport | Конфликт `planKey/campaignKey` во входе | `fn_tournament_subscription_*_prepare.js` | Неконсистентный `campaignKey` игнорируется для explicit `planKey` | Не происходит продажа «не того» плана при корректном `planKey` |

### Матрица B: Связка со split-играми

| ID | Тариф/Mode | Сценарий | Точки потока | Ожидаемый результат | Критерий приёмки |
| --- | --- | --- | --- | --- | --- |
| SPL-01 | Любой план, organizer | Создание split-игры с оплатой 1/4 (`one_time`) | `POST /lk/games/split/create` → Viva `transactions` | Возврат `paymentUrl`, создаётся split metadata (`payments[ORGANIZER]=PAYMENT_PENDING`) | Ответ `201`, `toPay>0`, есть `paymentUrl` |
| SPL-02 | Любой план, organizer | Создание split-игры со списанием абонемента (`subscription`) | `split/create` + режим `SUBSCRIPTION` | Платёж без редиректа, `toPay=0`, `status=PAID` для организатора | Ответ `201`, `toPay=0`, `paymentUrl=null` |
| SPL-03 | Friendship + Sport, participant | Join split-игры с оплатой 1/4 | `POST /lk/games/:id/split/join` (`one_time`) | Игрок в `waitlist`/`pending`, создаётся `PAYMENT_PENDING` с `deadlineAt` | В metadata есть payment item для игрока |
| SPL-04 | Friendship + Sport, participant | Join split-игры со списанием абонемента | `split/join` (`subscription`) | Списание без банка, игрок подтверждается (или waitlist) | `toPay=0`, запись split-payment обновлена без `paymentUrl` |
| SPL-05 | Friendship + Sport, participant | Timeout 10 минут по неоплате | FE триггер + `POST /lk/games/split/cleanup` (`intent=participant_timeout`) | Истёкший `PAYMENT_PENDING` переводится в `EXPIRED`, игрок удаляется из состава/листов | В `metadata.splitPayment.payments` статус `EXPIRED`, есть `AUTO_PAYMENT_TIMEOUT` leave-event |
| SPL-06 | Friendship + Sport, participant | Late payment: оплата успела до отмены | `split_cleanup_router` step `check_timeout_transaction` | При `PAID` в Viva игрок и статус платежа восстанавливаются | `recoverPaidTimedOutState` срабатывает: `status=PAID`, игрок возвращён |
| SPL-07 | Friendship + Sport, participant | Late payment: оплата после фактической отмены | post-timeout оплата после cancellation | Автовосстановления может не быть | Требуется manual/repair процедура |
| SPL-08 | Friendship + Sport | Leave/removal участника | `POST /lk/games/:id/split/leave` | Конкретные Viva booking’и отменяются, возврат `bookingSuccess/bookingFailed` | `withVivaErrors=false` для успешного удаления |
| SPL-09 | Friendship + Sport | Forced cancel игры организатором | `POST /lk/games/split/cleanup` (`force=true`, `intent=cancel_game`) | Игра архивируется в LK, Viva booking/exercise отменяются | `cancelledInLk=true`, `withVivaErrors=false`, `status=CANCELLED` |
| SPL-10 | Friendship + Sport | Guard от ложного forced cancel | cleanup без `intent=cancel_game` | Полная отмена игры не выполняется | Нет задач `reason=FORCED` |
| SPL-11 | Friendship + Sport | Auto assembly timeout 24h | cleanup reason `ASSEMBLY_TIMEOUT` | Пустые не собранные игры закрываются | `reason=SPLIT_ASSEMBLY_TIMEOUT_24H`, игра архивирована |
| SPL-12 | Friendship + Sport | Сверка LK/Viva состава | `apiFetchTournamentParticipants` + `reconcileRosterWithViva` | Убираются stale leave-events, состав подтягивается из Viva | `games_roster_sync_applied/skipped`, без hard-stop по leave-events |
| SPL-13 | Friendship + Sport | Join при отсутствии `vivaExerciseId` | `split/join` подготовка exercise id | Join невозможен без `exerciseId/studioId/clientPhone` | Ответ `400` (ожидаемо), инцидент требует repair |

## Gaps

1. Нет end-to-end автотеста полного пути `purchase -> bank -> confirm -> split-join` для каждого тарифа. Сейчас есть unit/contract coverage, но не полный сквозной сценарий.
2. Нет явной бизнес-связи «какой именно summer-план списан в split join» в аналитике LK; в split metadata хранится product/subscription, но нет отдельного campaign-level attribution.
3. `split/leave` зависит от `clientId` для client-booking cancel. Если `clientId` не восстановлен, booking отмена деградирует в ошибку по конкретному участнику.
4. `late payment after cancellation` (оплата прошла после выполнения cleanup-отмены) не имеет гарантированного авто-reconcile пути; нужна операторская процедура.
5. Нет выделенного launch-dashboard именно под `summer-subscription/*` + `split/cleanup` (по факту можно собирать из логов и Mongo, но нет готовой «боевой панели» в репозитории).
6. Для `PAYMENT_PENDING` без `expiresAt` в `lk_tournament_subscription_sales` запись считается активной резервацией бесконечно долго (риск блокировки лимита при «грязных» данных).

## Risks

### P0 (блокер запуска / высокий шанс инцидента 1 июня 2026)

1. Токен/доступ Viva падает в runtime: `summer-subscription` покупки/confirm не проходят, `split cleanup` уходит в dry-run и не чистит просроченные записи.
Что ломается завтра: массовые зависшие `PAYMENT_PENDING`, рост обращений в поддержку, занятые слоты.
2. Ошибка forced-cancel цепочки при ручных операциях (неверный `intent`, неверный `gameId`, частичные Viva ошибки): игра может уйти в `CANCELLED_WITH_VIVA_ERRORS`.
Что ломается завтра: игра исчезает в LK, но остаётся частично живой в Viva.
3. Платёж участника проходит «поздно» после cleanup-отмены (окно >10 мин, cancellation уже выполнен).
Что ломается завтра: LK и Viva расходятся по составу/оплате, игрок оплачен, но не в составе.

### P1 (серьёзный риск качества/конверсии)

1. Неверный выбор продукта summer-плана при отсутствии/ошибке `productId` конфигурации и reliance на name-scoring (`Энергия`/`Прогресс`).
Что ломается завтра: продаётся не тот продукт Viva при внешне успешной покупке.
2. Зависшие pending-резервации summer без `expiresAt` блокируют остаток лимита в `/status`.
Что ломается завтра: кнопка «Оформить подписку» сереет раньше времени.
3. Частичное падение `split/leave` без `clientId`.
Что ломается завтра: удаление игрока из LK выполнено, в Viva брони не сняты.

### P2 (операционный шум / UX)

1. Сообщения frontend по confirm/pending достаточно общие, без явного SLA времени подтверждения.
2. Нет централизованного тревожного отчёта по `withVivaErrors` после cleanup — нужны ручные проверки.

## Checks Before Launch

### 1) Техническая целостность (до 2026-06-01 08:00)

1. `npm run nodered:modular:build` — PASS.
2. `npm run nodered:modular:validate` — PASS (`ok: true`).
3. `node --experimental-strip-types --test scripts/tests/tournamentSubscription.summer.nodered.test.ts` — PASS.
4. `node --experimental-strip-types --test scripts/tests/splitCleanup.prepare.test.ts` — PASS.
5. `node --experimental-strip-types --test scripts/tests/splitGameExerciseId.test.ts` — PASS.
6. `node --experimental-strip-types --test scripts/tests/rosterSync.reconcile.test.ts` — PASS.
7. `npm run build` — PASS (включая `tournament-subscription.js/-dev.js`, `release.json`, `release-dev.json`).

### 2) Конфигурация и деплой (до 2026-06-01 09:00)

1. Проверить наличие артефактов на nginx: `tournament-subscription.js`, `tournament-subscription-dev.js`, `release.json`, `release-dev.json`.
2. Проверить, что Tilda-вставка `docs/tilda-tournament-subscription.html` загружает корректный канал (`prod` для боя).
3. Проверить `summer_subscription_*` global keys в Node-RED:
`*_campaign_key`, `*_product_id`, `*_product_name`, `*_limit`, `summer_subscription_reservation_minutes`, `summer_subscription_http_timeout_ms`.
4. Проверить, что `split cleanup` endpoint получает `intent=participant_timeout` только из автосценария, `intent=cancel_game` только из явной ручной отмены.

### 3) Smoke на проде (до 2026-06-01 10:30)

1. По одному тестовому пользователю на `friendship` и `sport`: пройти `purchase -> bank -> confirm`.
2. Проверить `/status`: `paidCount/reservedCount/remainingCount` обновились ожидаемо по каждому плану.
3. Создать одну split-игру 4/4, выполнить join участника в режиме `one_time` (1/4), убедиться в `PAYMENT_PENDING`.
4. Проверить timeout 10 минут (или ускоренный стендовый эквивалент): cleanup переводит item в `EXPIRED` и убирает игрока.
5. Проверить late-payment ветку на одном кейсе: при `PAID` до cancellation игрок восстанавливается (`recoverPaidTimedOutState`).
6. Проверить forced cancel одной тестовой игры: `cancelledInLk=true`, `withVivaErrors=false`.
7. Проверить roster sync: событие `games_roster_sync_applied` появляется хотя бы в одном кейсе с reconcile.

### 4) Мониторинг и алерты (с 2026-06-01 10:30 и весь launch-day)

1. HTTP error alert: `5xx` по `/lk/tournaments/summer-subscription/*` > 1% за 5 минут — P0.
2. HTTP error alert: `5xx` по `/lk/games/*/split/join`, `/split/leave`, `/split/cleanup` > 1% за 5 минут — P0.
3. Data alert: в `lk_tournament_subscription_sales` pending старше `reservationMinutes + 15m` > 0 — P1.
4. Data alert: `lk_games` с `metadata.splitPayment.status=CANCELLED_WITH_VIVA_ERRORS` > 0 за последние 30 минут — P0.
5. Data alert: `split cleanup` response `withVivaErrors > 0` или `processed>0` и `cancelled=0` — P1.
6. Analytics watch: рост `games_roster_sync_failed` относительно `games_roster_sync_started` > 20% за 30 минут — P1.

### 5) Go / No-Go критерии (решение в 2026-06-01 11:00)

GO:
1. Все проверки разделов 1-3 PASS.
2. Нет активных P0.
3. Smoke подтверждает оба тарифа (`friendship`, `sport`) и оба split-режима (`subscription`, `one_time`).
4. За последние 30 минут `withVivaErrors=0` на cleanup smoke.

NO-GO:
1. Любой P0 активен.
2. Невозможно завершить confirm хотя бы по одному из тарифов.
3. Split cleanup отменяет игры некорректно (ложные `CANCELLED`) или не чистит timeout-кейсы.
4. Новый split join всё ещё создаёт записи без `vivaExerciseId`.

## Rollback/Mitigation

1. Быстрый стоп продаж: временно выставить `summer_subscription_friendship_limit=0` и/или `summer_subscription_sport_limit=0` в Node-RED global config.
2. Откат фронта: вернуть предыдущие `tournament-subscription*.js` + обновить `release.json` на предыдущую рабочую версию.
3. Откат cleanup-поведения: отключить автотриггер participant-timeout в UI (временный hotfix) и перейти на ручной cleanup по подтверждённым кейсам.
4. Repair для late/false timeout: запускать `scripts/repair_split_timeout_false_positives.mjs` сначала в dry-run, затем apply/postcheck.
5. Repair missing IDs: запускать `scripts/repair_missing_split_exercise_ids.mjs` при симптомах `exerciseId/studioId/clientPhone required` на join.
6. Для точечных зависших платежей summer: ручной `confirm` по `paymentRef`, затем сверка записи в `lk_tournament_subscription_sales`.
7. При `CANCELLED_WITH_VIVA_ERRORS`: ручной разбор trace в `metadata.splitPayment.vivaCancellation` + повторный selective cancel по booking/exercise.

## Измененные файлы

- `docs/launch_2026-06-01_summer_subscriptions_architect_plan.md` — архитектурный launch-план с матрицей кейсов, gaps, рисками, checklist, мониторингом и rollback-стратегиями.
