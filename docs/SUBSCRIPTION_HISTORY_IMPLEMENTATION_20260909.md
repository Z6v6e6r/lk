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

## Интеграция в локальный main

По отдельному согласованию пользователя объединены task checkpoint `80b4e1d` и
свежий `origin/main=a0cfefdfa4e6f729fe0c8c952731cec4a3e7ae5a`. CI этой базы:
LK1 Subscription Enforcement `34394715508` — success. Main movement включал
параллельные HAB startup price, group discounts и session cache. Их файлы/поведение
сохранены; единственный текстовый конфликт WORKLOG разрешён сохранением обеих записей.

Проверки объединённого дерева:

- Актуальный critical набор CI с session-cache/join-loading: 548 PASS, 5 SKIP.
- Расширенный candidate/annual/HAB-price/group набор: первоначально 93 PASS, 14 SKIP,
  три отказа. Два положительных теста старого price-only builder использовали новые
  annual sources вместо своих frozen inputs. Старые release pins сохранены; эти два
  теста явно SKIP при superseded sources, новый негативный тест подтверждает отказ
  старого builder от непроверенной композиции. Третий отказ был у fixture с symlink
  в ROOT: checkout в /tmp сам находится внутри разрешённой области. Fixture теперь
  ссылается на filesystem root вне временной области.
- Исправленные два test-файла: 20 PASS, 3 SKIP, 0 FAIL. Три пропуска — два описанных
  исторических positive-теста и необязательный private live fixture. Остальные успешные
  проверки с неизменными входами повторно не запускались. Непроверенный historical
  forward/reverse пакет не объявляется PASS.
- Полный lint: 0 errors, 387 прежних warnings; scoped lint исправленных тестов PASS.
  Полный prod/dev build объединённого дерева с инертным fixture env PASS.
- Read-only integration review: существенных несовместимостей не найдено; просмотрены
  также две локальные корректировки тестов. Runtime source при разрешении конфликтов не менялся.

Дополнительные изменённые файлы этапа: `scripts/tests/habAnnualPriceCandidate.test.mjs`,
`scripts/tests/lk1SubscriptionDevCandidate.test.mjs`, этот отчёт и WORKLOG.
Проверки и logs находятся приватно в `/private/tmp/lk-annual-history-integration-20260909/`.
Task-ветка и checkpoint сохранены. Выполняется только локальный merge; push, новый CI,
deploy, runtime control, provider/Mongo business writes и activation в этот этап не входят.
Перед будущим deploy обязательно заново прочитать flow147 и при drift пересобрать exact
binding/candidate/HUB receipt; старый ff056708… остаётся доказательством прежнего снимка.

## Переподготовка после изменения flow147 — 2026-09-10

Отдельно согласованная переподготовка выполнена в прежней task-ветке, продвинутой
fast-forward до опубликованного `eb9a041`. Его CI `34433165322` завершился success.
Main merge/push нового изменения в этот этап не включены.

Новый read-only snapshot147 содержит 4798 узлов. По сравнению с прошлым снимком
изменены восемь узлов: четыре функции цены/статуса/покупки, initializer цены ХАБ,
подготовка/маршрутизация бронирования и две функции preview. Добавлений/удалений нет.
Первый scp прервался, повторный полный pull с metadata происхождения успешен.

| Связка | SHA256 |
|---|---|
| Проверенный source147 | `ee3f60079e7fbebeba6387d3d2f2f57d6fec17003e3e91ce7da5ff85061c63c7` |
| Новый полный annual candidate | `a9c1bd6663e73dc473e338a7d96c076565afe751bb1d82766a73502e68dc8c53` |
| Новый HAB booking receipt digest | `c1b75e9e7439207f0ef69632413bf180acf5461f4df7f6ebf739b0c0bb18b53f` |

Уже установленные status_prepare/counter_refresh совпадают с целевыми исходниками
и исключены из списка замен. Кандидат меняет восемь узлов, добавляет только expander,
сохраняет остальные узлы/поля, содержит 4799 узлов и прежние 219 HTTP inputs.
Price initializer, group booking и preview updates сохранены без перезаписи.

Изменение gateway потребовало обновить HAB receipt в atomic initializer. Новый helper
`buildAnnualHistoryInitializer` заменяет ровно один валидный JSON-литерал receipt на
значение, полученное из точного live graph и проверенное против binding. Остальные байты
initializer сохраняются; после него добавляется прежний загрузчик persistent sales config.
Неоднозначный/отсутствующий receipt, неверный receipt и повторное добавление config
отклоняются. Итоговый initializer компилируется. Старые receipts покупок и коммерческие
правила не меняются. Функции runtime продажи относительно eb9a041 не редактировались.

Проверки этого изменения:

- Annual history: 27 PASS, 0 SKIP/FAIL, включая полный приватный snapshot/candidate,
  сохранение каждого незатронутого узла, отрицательные source/digest проверки и запуск
  двух initializer в обоих порядках. Private case в обычном CI без snapshot явно SKIP.
- Candidate/compatibility: 68 PASS, 5 SKIP, 0 FAIL. Пропуски — ранее описанные private
  и superseded historical price-only fixtures; они не считаются доказательством выпуска.
- Полный lint: 0 errors, 387 существующих warnings; diff check PASS.
- Private modular build/validate текущего source: 142 selected nodes, 13 HTTP inputs,
  0 broken wires/links. Exact full-flow contract проверен отдельно CLI builder.
- Два независимых read-only review: release graph/custody и payment receipt — PASS.
  Подтверждено, что receipt candidate соответствует его фактическому booking graph.
- Полный build/typecheck и неизменённые runtime regression inputs повторно не запускались:
  используются успешные exact-head CI eb9a041, поскольку frontend, lockfile и runtime
  function sources в этой переподготовке не изменились. Новый startup/rebind path проверен
  описанными тестами; live restart/Provider/Mongo исполнение по-прежнему не проверены.

Изменены: `scripts/annual_subscription_history_binding.json`,
`scripts/prepare_annual_subscription_history_candidate.mjs`,
`scripts/tests/annualSubscriptionHistory.test.mjs`, этот отчёт и WORKLOG.
Приватный каталог `/private/tmp/lk-annual-history-rebind-20260910/` содержит source с
metadata, candidate/contract, журналы, descriptor 17 файлов operator publication closure
и образец `sales-configuration-off.json`. Ничего из этого не опубликовано или применено.

Initializer применяет реальные booleans из ENV: candidate hash сам по себе не доказывает
OFF. До установки нужна проверенная неактивная persistent конфигурация из предыдущего
раздела; отсутствие/ошибка ENV закрывает также РА/Дружбу. В тестах OFF подтверждён
только для явно заданной неактивной конфигурации либо отсутствующего/невалидного ENV.
Коммерческие остатки этого документа относятся к прежним снимкам: при наступившем
новом дне перед открытием нужен новый полный расчёт. В этом этапе stock/data не менялись.

Повторный read-only SHA147 после подготовки снова подтвердил `ee3f600…` (после одного
сетевого таймаута). За время работы parallel main продвинулся до `a7be8cd` с paid-join/
visit lifecycle и group tariff изменениями. Они не включались в этот локальный checkpoint;
при следующей согласованной интеграции их нужно сохранить. Кандидат привязан к фактически
прочитанному flow147, не подменяет ещё не установленные runtime функции исходниками main.

## Локальная интеграция переподготовки — 2026-09-10

По отдельному согласованию `1956274` объединён с `main=a7be8cd`; CI точной базы
`34434812931` — success. Paid JOIN, visit worker/return и group tariff изменения main
сохранены. Единственный конфликт WORKLOG разрешён сохранением обеих записей.
Runtime source и коммерческие правила при интеграции не редактировались.

Проверки объединённого дерева: critical548 PASS/5SKIP; candidate/annual/group/visit
совместимость133 PASS/23SKIP и один loopback-тест, первоначально заблокированный sandbox
(`listen EPERM 127.0.0.1`), отдельно выполнен успешно. Итого134 успешных compatibility
проверки, без неустранённых отказов. Optional physical/private/historical cases остаются
SKIP, не runtime acceptance. Lint0errors/387 прежних warnings; exact candidate CLI
воспроизводит `a9c1bd66…` с прежними4799 узлами/219HTTP. Независимый integration review PASS.
Полный build/typecheck переиспользован из успешного CI a7be8cd: соответствующие входы
относительно этой базы не менялись. Проверки секретов и финального diff выполняются
для merge checkpoint. Logs: `/private/tmp/lk-annual-history-rebind-integration-20260910/`.

Изменённые файлы относительно базы main остаются теми же пятью из предыдущего раздела.
Task-ветка1956274 сохранена. В этом этапе только локальный merge: push/deploy, runtime
control, provider/Mongo business writes и включение продаж не выполняются. Установка
параллельных runtime функций до annual deploy потребует нового сравнения с live flow;
совпадение source нельзя выводить из одной лишь интеграции исходников в main.
