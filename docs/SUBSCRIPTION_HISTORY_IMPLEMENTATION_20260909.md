# Локальная реализация учёта истории годовых подписок

Согласованный этап: реализация плана с учётом всех 18 оплаченных продаж ХАБ.
Ветка `codex/subscription-sale-quotas-20260909` сохранена. База `origin/main=aebcc59`
включена коммитом `0bafdc0`, поэтому параллельное исправление цены не потеряно.
Это результат локальной разработки, не подтверждение открытия продаж.

## Реализованное поведение

- РА: новая дневная квота 10 в v3; прежние v2 операции сохраняются.
- Дружба: всего 7 за дневное окно, с вычетом оплаченных и активных pending.
- ХАБ: все платные Viva продажи входят в общий лимит 100; одна продажа за московский
  день, новая цена 98 000 ₽, активация на следующий день.
- Питер: 42 исходные платные продажи + фиксированная корректировка 10 дают начальные
  48 свободных мест из партии 100. Общий лимит 400, цена 19 800 ₽, активация на следующий день.
  Поздняя оплата уменьшает остаток; корректировка больше не пересчитывается для возврата к 48.

Schema3 хранит реальные canonical transaction/subscription связи отдельно от новых
checkout reservations. Продажи вне ЛК не превращаются в фиктивные документы платежей.
История бесплатных выдач, возвратов и просроченных UNPAID остаётся проверяемой.
UNPAID не переводится массово в FAILED: фоновая сверка продолжает наблюдение.

Поздние PAID/REFUNDED сохраняются даже при закрытых flags/ready и превышении квоты.
Canonical ID проверяется между историей и reservations, повтор не меняет счётчик.
Ledger CAS сохраняет факт и задание проекции вместе. Изменение существующего документа
продажи — отдельный CAS с неизменной идентичностью и суммами. Потеря ACK восстанавливается
по postimage. Незавершённая проекция или неуспешная последняя сверка закрывает admission.
Это восстанавливаемая последовательность, не атомарная cross-document runtime transaction.

Планировщик ставит до 40 наблюдений каждого продукта за тик перед существующим
ограничителем 1 запрос/сек. Курсор попыток предотвращает вечное повторение первых 40
при ошибках. Исторические строки не дублируются обычными reconcile jobs.

Новые оплаты schema3 используют реальный контракт Viva: `sum=cost`,
`toPay=cost-discount`, включая PAID. Версия заморожена в saleRecord и проверяется по
фактическому ledger; старые receipts сохраняют старый путь. Для ХАБ canonical GET
транзакции не содержит clientSubscriptionId. Полный paginated GET подписок клиента
однозначно находит экземпляр до CAS и повторно после ACK, затем завершает LK1 projection.
Неисполненные функции ЦУП при этом не включаются.

## Файлы

| Область | Изменённые/новые файлы относительно aebcc59 |
|---|---|
| Canonical история, расчёт, восстановление | `scripts/lib/annualSubscriptionHistory.mjs`, `annualSubscriptionHistoryRouter.mjs`, `annualSubscriptionOpening.mjs` |
| Оператор обслуживания | `scripts/manage_annual_subscription_history.mjs`, `scripts/lib/subscriptionHistoryMaintenanceContract.mjs` |
| Сохраняемая конфигурация | `scripts/lib/subscriptionSalesConfiguration.mjs` |
| Node-RED source | `scripts/nodered_games_nodes/fn_tournament_subscription_{confirm_resolve,piter_atomic_router,purchase_prepare,purchase_router,reconcile_query,reconcile_record,reconcile_expand,status_response}.js` |
| Генерация и exact flow contract | `scripts/sync_annual_subscription_history.mjs`, `scripts/prepare_annual_subscription_history_candidate.mjs`, `scripts/annual_subscription_history_binding.json` |
| Source-only fingerprints, старые release pins сохранены | `scripts/lib/piterAtomicTopologyContract.mjs`, `scripts/prepare_lk1_subscription_enforcement_candidate.mjs` |
| Проверки и включение в существующий CI command | `scripts/tests/annualSubscriptionHistory.test.mjs`, `subscriptionSaleOpening.test.mjs`, `tournamentSubscription.summer.nodered.test.ts`, `package.json` |
| Документация | этот отчёт, `docs/SUBSCRIPTION_HISTORY_OPENING_PLAN_20260909.md`, `docs/WORKLOG.md` |

## Проверки и доказательства

1. `node --test scripts/tests/annualSubscriptionHistory.test.mjs`: 25 PASS.
   Негативные сценарии: stale/partial evidence, cross-inventory collision, финансовые и
   клиентские противоречия, дубликаты экземпляров, late payment при overflow, возвраты,
   потеря ledger/sale ACK, mutation/grant/lease drift, неизменность mapping,
   schema3 recovery, полный HAB post-ACK readback, dry-run обоих продуктов.
2. Критический набор из CI (18 файлов, включая `tournamentSubscription.summer.nodered`):
   528 PASS, 5 SKIP, 0 FAIL. Candidate/compatibility набор (7 файлов + новые тесты):
   88 PASS, 2 SKIP, 0 FAIL; включает 23 из 25 новых тестов до добавления двух чисто
   операторских/source-binding тестов, которые отдельно прошли пункт 1. Эти числа не суммируются.
3. `npm run lint`: 0 errors, 387 существующих warnings. Финальный scoped lint новых тестов
   выполняется дополнительно после их дополнения.
4. `npm run build`: все prod/dev bundles собраны с явно инертными fixture env URL
   `https://build-fixture.invalid/...`. Обычная команда без env остановилась на 17 обязательных
   ключах. Это проверка сборки, артефакты не предназначены для релиза.
5. Повторный read-only pull147: source SHA
   `325839a66e235caa9e56bde36afdb89286aab8e26e963f2612dea03bf7a7cb75`, 4798 узлов.
   `nodered_modular_flow.mjs build/validate` в приватном workspace: 142 выбранных узла,
   13 HTTP inputs, 0 broken wires/links. Это отдельная проверка исходного modular graph.
6. Полный annual candidate собран CLI с exact preimage/node/source/graph проверками:
   SHA `ff056708ce47aca989dfef9156600586c022fe5f317453417e135325ff131e12`,
   4799 узлов, прежние 219 HTTP inputs; изменены 10 узлов, добавлен один expander.
   Candidate и reviewed graph contract сохранены приватно, не опубликованы.
7. Свежий read-only сбор завершён `2026-09-09T19:00:43.103Z`: 160 provider GET,
   150 транзакций и 103 локальные строки. Контракт принял все 150 фактов без ошибок.
   ХАБ 18 PAID (14 вне ЛК), 19 UNPAID watches, остаток 82 и 1 за день.
   Питер 42 PAID (2 вне ЛК), 42 UNPAID watches, adjustment10, остаток первой партии48.
   Разброс snapshots 11.799/9.152 сек. Бизнес-записей ноль.
8. Offline replay реального снимка: reconcile-refunds → seed → activate для обоих
   продуктов проходит. Postimages после первого шага синтетические; clock явно зафиксирован
   на моменте исходного снимка. Пакеты диагностические, не fresh live grants.
9. Независимые read-only payment-safety и reliability/release reviews выполнены.
   Найденные дефекты устранены: повторный учёт, starvation, изменяемая проекция,
   custody/recovery, финансовый контракт и неполное чтение экземпляра ХАБ.

Private evidence: `/private/tmp/lk-annual-history-implementation-20260909/` (0700, данные0600).
В Git не включаются снимки, полные provider данные, runtime JSON, токены и release bundles.

## Условия следующего выпуска

До установки candidate нужно опубликовать в существующем управляемом PM2 окружении
валидную **неактивную** persistent конфигурацию `PADLHUB_SUBSCRIPTION_SALES_CONFIGURATION`:

```json
{"kind":"SUBSCRIPTION_SALES_CONFIGURATION_V1","revision":1,"common":false,"hub":false,"piter":false,"raClosed":false,"friendshipClosed":false}
```

Initializer при отсутствии/ошибке JSON закрывает также РА и Дружбу. Поэтому этот
предварительный шаг обязателен для сохранения прежней доступности этих продуктов
во время установки. Локально проверены повторная загрузка и выборочная остановка;
фактическую PM2 persistence/startup attestation надо проверить в отдельно разрешённом выпуске.
Простого присваивания memory globals недостаточно.

Maintenance operator требует stopped Node-RED, отсутствие конфликтующей deploy lease,
существующий flock, root-owned неизменяемую публикацию полного dependency closure,
точные flow/host/Mongo identities, quiescence других writers и ограниченный grant.
Проверяет полные BSON pre/postimages, majority snapshot transaction, durable intent/receipt,
восстановление подтверждённого postimage без повторной бизнес-записи. Не запускает runtime
и не включает flags. Старые empty-only/deferred/soaking операторы не ослаблены.

Реальное исполнение нового оператора в Linux/Mongo transaction, stopped/start,
live persistence/readback, CI нового checkpoint, deployment и публичный UI нового
поведения ещё не проверены. Приватные snapshot/packet имеют ограниченное окно свежести:
перед записью их нужно пересобрать; любое изменение flow требует нового exact binding.
Откат старого flow поверх уже созданной schema3 истории не подготовлен и не разрешён.
При проблеме закрывается admission с сохранением платежей/истории.

В этом этапе main merge, push, deploy, provider/Mongo business writes, остановка/запуск
runtime, изменение env и flags, реальный платёж не выполнялись. Создаётся только локальный
checkpoint в существующей task-ветке. MODEL_ROUTE: parent.
