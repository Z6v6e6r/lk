# Платное присоединение по подписке: списание и возврат посещения

Статус: реализовано и проверено локально; не выложено. Ветка
`codex/subscription-join-payment-20260909`, исходная база
`be2e395eebae6b6fee7e405fbfa87ef3e3e703bf`.
Предыдущие checkpoints: `3a9407077233e381d1a6d82da7241608d366c195`,
`0b29acfca8a94df7faa46e30abfbaefd4801baec`, `11f9095`.

## Поведение

1. JOIN с положительной доплатой создаёт одну запись ON_PLACE. Цена берётся из
   серверного расчёта подписки; для исходного HAR 90 минут = 60 бесплатных + 30
   платных, итог 262,50 руб. Используется существующая SERVICE-транзакция со скидкой.
2. Точное подтверждение записи и `lk1.visitJob` сохраняются одним Mongo CAS в
   `lk_subscription_daily_booking_ops`. Задание связано с выбранным экземпляром
   подписки, пользователем, записью, упражнением, продуктом, датой и операцией JOIN.
   Checkout не ждёт фонового запроса, но не продолжается без сохранённого задания.
3. Фоновый worker проверяет запись ON_PLACE и подписку, сохраняет отправку задания,
   затем единожды вызывает изменение лимита на −1. Отдельная запись SUBSCRIPTION
   для списания не создаётся. Полностью бесплатный JOIN сохраняет прежнее поведение;
   при отсутствии бесплатных минут отдельного задания нет.
4. `split_leave` после подтверждённой отмены сохраняет обратное задание до перехода
   к удалению участника. Деньги возвращает прежний механизм отмены; worker возвращает
   посещение через +1 на тот же экземпляр. Удаление участника может завершиться раньше.
5. Только после сохранённого подтверждения +1 операция льготы получает RELEASED.
   Расчёт снова предоставляет бесплатные 60 минут в этот день. Если отмена опередила
   отправку −1, worker освобождает резерв без ненужного списания/возврата.

Отмены из кабинета и очистка неоплаченных игр могут обходить `split_leave`. Worker
периодически проверяет точную запись Viva и ставит обратное задание при подтверждённой
отмене. Он не заявляет, что денежный refund завершён, и не повторяет его. Для штатного
NONE сохраняется `NO_REFUND_REQUESTED`, а не ложное доказательство отсутствия оплаты.
Явный staff `NO_RETURN` сохраняет посещение и резерв: worker проверяет durable
staff-команду после readback отмены, а leave-hook сохраняет `STAFF_NO_RETURN` в журнале.
Это закрывает окно между отменой в Viva и сохранением локального результата.

## Подтверждённый контракт Viva

Оба предоставленных HAR прочитаны офлайн; запросы из них не воспроизводились.
Клиентские ID, токены, исходные HAR и transaction ID покупки не включены в Git.

```http
PUT /api/v1/clients/{clientId}/subscriptions/{clientSubscriptionId}/limit
Content-Type: application/json

{"type":"BY_VISITS","value":-1}
```

Возврат использует тот же URL с `value:1`. HTTP 200 возвращает объект подписки.

| Источник | Действие | visitsTotal | visitsLeft |
| --- | --- | --- | --- |
| P2, индекс 4, экземпляр A | −1 | 365 → 364 | 365 → 364 |
| P2, индекс 6, тот же A | повтор −1 | 364 → 363 | 364 → 363 |
| P2, индекс 8, экземпляр B | −1 | 365 → 364 | 364 → 363 |
| P2-2, индекс 0, тот же B | +1 | 364 → 365 | 363 → 364 |

При сравнении объектов меняются только два счётчика. Список bookings и transactionId
покупки не меняются. Это корректировка лимита; Viva не создаёт отдельную запись
посещения/транзакцию, связанную с ON_PLACE. Аудит связи хранится в нашем журнале.

SHA256 исходных файлов:
- P2: `92c6fac34b48bfa462fd223e814ae3a7ae4d251f0cf6418303f1992a07b36410`.
- P2-2: `820f0d1d2ea00d1538af453c45dc9dd71cdb0b15892fd0210e5c63dfbcee1e4e`.

## Повторы, отмена и восстановление

- `lk_subscription_visit_locks` использует уникальный `_id` на tenant/client/instance.
  Lock не истекает автоматически. Для DEBIT и RETURN применяется отдельная метка
  операции; старый worker не может удалить lock уже начавшегося возврата.
- HTTP выполняется без retry, redirect replay или подмены provider-idempotency.
  Сначала подтверждается CAS отправки. Принимается только непосредственный HTTP 200
  на этот запрос: точный экземпляр, продукт, тип и изменение обоих счётчиков на ±1.
- Потеря ответа, сбой записи ACK, противоречивый DTO или неопределённый статус оставляют
  SENT/UNKNOWN на ручной сверке. Последующий баланс не доказывает авторство изменения.
  Нельзя автоматически повторять PUT, выдавать providerOperationId покупки за ACK
  или освобождать минуты. Lock ограничивает последующие изменения этой подписки.
- Observer требует согласованные идентификаторы и paymentType=ON_PLACE, явные признаки
  состояния записи и корректные даты. Противоречивые aliases и неполная/противоречивая
  пагинация останавливают обработку. Просмотр ограничен 10 страницами по 200 записей.
- Worker обрабатывает отмену, пришедшую во время −1, через revision CAS. Старый результат
  не может освободить резерв нового JOIN. Изменения вне приложения не защищены общим
  provider CAS; противоречие с непосредственным ответом требует ручной сверки.

## Файлы

- `scripts/lib/subscriptionVisitLifecycle.mjs`: журнал, direct-ACK контракт, переходы,
  CAS, удержание сотрудником и освобождение лимита; JSON clone совместим с Node-RED VM.
- `scripts/lib/subscriptionVisitWorker.mjs`: Mongo lock, проверка владельца журнала,
  однократный HTTP, observer внешней отмены и восстановление подтверждённых locks.
- `scripts/run_subscription_visit_worker.mjs`: явный запуск, tenant scope, курсор,
  повторная проверка через 120 секунд, вывод изменений статуса и ручной сверки.
- `scripts/lib/subscriptionVisitRuntimeSource.mjs`,
  `scripts/nodered_lk1_hub_nodes/visit_confirm.js`: embedding журнала и атомарное enqueue.
- `scripts/nodered_lk1_hub_nodes/gateway.js`, `gateway_hooks.js`,
  `scripts/patch_live_lk1_hub.mjs`: подключение подтверждения и зависимости сборки.
- `scripts/nodered_games_nodes/fn_split_leave_daily_limit_find.js`,
  `fn_split_leave_daily_limit_route.js`, `fn_split_leave_daily_limit_ack.js`: точная
  запись вместо выбора всех JOIN упражнения, постановка возврата и различение ACK.
- `scripts/patch_nodered_subscription_paid_join.mjs`: полный fixture-пакет из пяти
  функций — gateway, preview, daily-limit find/route/ack. Связи и остальные узлы сохранены.
- `scripts/tests/subscriptionVisitWorker.test.mjs`: worker, HTTP, Mongo и отрицательные
  сценарии; `lk1HubLiveComposition.test.ts`, `subscriptionPaidJoin.nodered.test.mjs`,
  `splitLeave.router.test.ts`: enqueue и согласование обновлённых узлов.
- Этот отчёт, `SUBSCRIPTION_PAID_JOIN_FIX_20260909.md`, `WORKLOG.md`: статус и доказательства.

## Проверки

- 43 PASS / 0 FAIL / 0 SKIP: lifecycle, leave-guard и worker. В составе — один полный
  тест на настоящей MongoDB 7 и loopback HTTP-фикстуре с 8 параллельными worker: один
  −1, один +1, RELEASED, исходные счётчики восстановлены, locks удалены. Остальные
  тесты используют локальные фикстуры, часть проверяет настоящий HTTP и Node-RED VM.
- 14 PASS / 15 SKIP: source-bound composition и paid JOIN/checkout. Пропущены прежние
  CREATE/identity installation-сценарии, требующие другого исторического снимка.
- 117 PASS / 1 SKIP: смежные split-leave/instance/shared-daily-limit регрессии.
- Полный lint: 0 ошибок / 387 исходных предупреждений; финальный scoped lint — PASS.
- Независимое payment/reliability review: замечания исправлены; блокирующих замечаний
  по последнему коду не осталось. `git diff --check` и узкая проверка новых данных — PASS.
- Предыдущий typecheck относится к неизменённому frontend. Полная сборка ранее
  остановилась до компиляции из-за отсутствующей ignored VITE-конфигурации; это не PASS.
- Новый live-origin modular audit не выполнялся: использован замороженный fixture.
  Пять функций компилируются; exact-graph тест проверяет сохранение всех прочих полей,
  узлов и связей. Это не подтверждение актуальности рабочего Node-RED.

Временная MongoDB работала в Docker internal network; тестовый Node делил её network
namespace и обращался по loopback. Исходники монтировались read-only. Тестовая БД,
контейнер и сеть удалены после проверки. Ни одного обращения к реальному Viva из тестов.

Fixture candidate SHA256:
`10b7984fbc14dd2d7c90a05965b3789484322084dcf581ed3741e68371c484b6`.
Он привязан к прежнему снимку первичного сервера и не является разрешением на выкладку.

## Запуск и следующие этапы

Без `--run` команда `node scripts/run_subscription_visit_worker.mjs` только выводит
описание и не подключается к БД/Viva. Runtime требует server-owned переменные:
`SUBSCRIPTION_VISIT_MONGO_URI`, `SUBSCRIPTION_VISIT_DB`, `SUBSCRIPTION_VISIT_TENANT`,
`SUBSCRIPTION_VISIT_TOKEN_FILE`; origin по умолчанию официальный Viva. Локальные тесты
используют отдельный loopback origin. `--once` выполняет один пакет, обычный запуск
проверяет очередь каждые 5 секунд; неизменившиеся задания получают паузу 120 секунд.
Доступ к service token и запуск worker на сервере ещё не настроены и не выполнялись.

Локальная повторная проверка: тесты `subscriptionVisitLifecycle.test.mjs`,
`subscriptionVisitLeaveGuard.test.mjs`, `subscriptionVisitWorker.test.mjs`; для
physical-сценария нужен отдельный fixture-owned Mongo на loopback и переменная
`LK_VISIT_VERIFY_MONGO_URI=mongodb://127.0.0.1:<port>`. Тест сам создаёт БД с префиксом
`subscription_visit_verify_` и удаляет только её. Зависимости — существующие node_modules.

Перед rollout нужны отдельные согласованные стадии: пользовательская проверка,
интеграция, push, затем свежий live-source audit и подготовка полного пакета + worker
из одного подтверждённого commit. Старый paid-only пакет из двух функций неполон.
Нельзя откатывать журнал/locks с неопределёнными запросами или автоматически повторять
зависшее списание. Ручная сверка и исправление конкретной операции — отдельная операция
с подтверждённым исходом Viva; автоматического механизма угадывания этого исхода нет.

UI/real Viva payment/refund smoke, измерение production-нагрузки и активация worker
не выполнялись. Исходная PENDING_CONFIRMATION-операция из первого HAR не изменялась.
Push, Draft PR, merge, deploy и рабочие provider/database-операции не выполнялись.
MODEL_ROUTE: parent

## 2026-09-10: пользовательская проверка и локальная интеграция

Пользователь подтвердил локальный сценарий, затем отдельно разрешил интеграцию
в локальный main без push/deploy. База интеграции после fetch:
`eb9a041aea7e0f3e13a242147585897d8f861c8b`; принят task checkpoint
`88b9910f999b8b7fde2d5a297b1afe5a048ae768`. Task-ветка и исходная грязная рабочая
копия сохранены. Merge подготовлен в отдельной копии
`/private/tmp/lk-subscription-join-main-integration-20260910`.

Конфликт WORKLOG разрешён сохранением обеих историй. Параллельные изменения групповых
скидок в gateway/preview сохранены. Профильное integration review выявило смешение
нового all-date запроса операций со старым daily-only helper в историческом group
composer. Исправление ограничено этим exact-preimage composer: его запрос снова
ограничен serviceDate, как и frozen gateway/usage. Современный paid preview продолжает
запрашивать все даты для подсчёта активных платных льгот. Это не установка paid
lifecycle частичным group-пакетом; для реальной выкладки нужен новый полный пакет.

Проверки объединённого source:

- Матрица critical subscription из CI: 548 PASS / 5 SKIP / 0 FAIL.
- Фокусные lifecycle, leave, worker, JOIN composition, instance и group проверки:
  суммарно 82 PASS / 17 SKIP. Первоначальный loopback HTTP тест был заблокирован
  sandbox listen EPERM; повтор только этого теста с разрешённым loopback дал PASS.
  Добавленная group-регрессия сначала воспроизвела дефект, после исправления все
  12 group backend тестов PASS. Пропуски: прежние fixture/install-сценарии и physical
  Mongo-тест; успешное Mongo7 свидетельство task checkpoint не переименовано в
  новый интеграционный прогон. Worker/lifecycle исходники идентичны checkpoint.
- Полные npm run lint: 0 ошибок / 387 исходных предупреждений. После исправления
  composer и теста отдельный lint этих файлов: PASS.
- Полный npm run build, включая tsc и prod/dev: PASS с CI-подобной инертной
  конфигурацией https://ci.invalid. Это проверка компиляции, не release artifacts.
- Exact graph проверки использовали прежний приватный fixture. Fresh live modular
  audit, настоящий UI/платёж/Viva refund, CI нового merge и запуск worker не выполнены.

Пользовательский стенд проверяет исходный checkpoint: тестовые оплата/БД/Viva,
реальные локальные функции расчёта и lifecycle. Подтверждены один debit, отсутствие
повторного debit, cancel/return/release, повторные 60 минут и неопределённый исход
без слепого повтора. Это не реальный платёжный smoke.

Push, PR, deploy и рабочие provider/database операции на этапе не выполняются.
Следующий отдельный этап — push подтверждённого локального main и проверка CI.
