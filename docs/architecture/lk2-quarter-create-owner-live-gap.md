# Четвертной CREATE: расхождение с живым LK1 (2026-11-06)

Статус: **решение владельца 2026-11-06 — вариант C.** Четвертной CREATE через LK1 в первую
версию не входит: на живой LK1 ничего не ставится, LK2 держит этот путь выключенным. Патч
на живой образ не перенесён, потому что обёртка опирается на код, которого на живом LK1 нет.
Документ фиксирует факты на случай, если к задаче вернутся после первой версии. Изменений
в коде патча нет.

## Что проверено (только чтение)

- Живой `/root/.node-red/flows.json` на `lk-primary-147`, sha256
  `9ed37134a09bb2283160325ee5f18104983720c26f7135f869d6266ee1912425`, последняя запись
  `fpr284-event-20261103` (reviewed-flow stage `20261103T062642+0000-284`, меняла только
  турнирные узлы). Копия держалась вне репозитория и удалена.
- `composeGameCreateOwner(live)` → `CREATE_OWNER_TOPOLOGY_DRIFT` (LOCAL).
- Существующие тесты `gameCreateOwner.test.mjs` и `gameCreateOwnerGraph.test.mjs`: 79/79 (LOCAL).

## Почему не совпадают хэши

`main` и живой LK1 — две разошедшиеся ветки одного графа:

| | только на живом | только в `main` (база `62e32f7b`) |
| --- | --- | --- |
| router | trial-group, pro-training, topokraty, lk1 event payment/checkout, plan rules, station exclusions, rejoin/reclaim, `lk_subscription_product_router_20260907` | managed JOIN v2, owner readback/confirmation, precreate rejection persist/recovery, managed leave, diagnostics |
| prepare | 3151 символ, 2 выхода, без training capability | 11.5K, 3 выхода (`63cc8077` training owner) |
| options | 2 выхода | 3 выхода (`→ prepare`) |
| диагностика | нет `lkDiagnostic` ни в одном из 7 узлов | инструментированы (`13b68858`) |

Совпадает с репозиторием только `mongo_error`: это бизнес-преимидж `1c786def…` без диагностики.

Живые sha256 `func` (для будущих `gameCreateOwnerPrerequisites`):

```
prepare               f1cbb94f598635abd767c3494fd0a4d24e8049f3c64a68f2069a731cbd76cf12
finalize              2f62d0efd4ed4424b03e43d5f5435ec27fbdebc218be6df8cd99d096b1e7e8ab
mongo_error           1c786def280a91c684dae8a71d56ac903ad1912f059145aa85d1dab0944f3a56
options               949efce458f5fbd1ba9cb6178f4db75fddc39a9f4affa21ad2268eca58d5b395
router                5e571a859e3ac3363e54d5a21836f9e6199b4dbd14f6c2441e97c356bfdd64ce
split_create_prepare  b69eb36c138d5b9ae6ac020202148ca6d86f7495b4046811f7dde1473ea0ef9d
split_router          d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b
```

## Чего обёртке не хватает на живом

1. **Хелперы router**, которые вызывают `_game_create_owner_gateway.js` / `_split.js`, а на живом
   их нет: `recordOwnerReadback`, `recordOwnerConfirmation` (`453e8459`),
   `resumePrecreateRejection` (`d77a3274`), `preparePrecreateEntitlementReadback` (`de95b8cc`),
   `managedJoinV2SignerReady` (`71db8103`), `abortManagedCreateReservation` (`c4425940`).
   Хунки router из `2dddaabd` тоже частично привязаны к ним (`managed_precreate_entitlement_readback`).
2. **Топология capability-пути:** `prepare` выход 3 → router и `options` выход 3 → prepare
   (training owner `63cc8077`). На живом у обоих узлов 2 выхода.
3. **Поток подготовки CREATE (LK #273):** обёртка принимает только существующую приватную
   капсулу подготовки. На живом нет ни маршрутов подготовки, ни `gcHash`. Получить капсулу LK2 негде.
4. Есть: booked-operation receiver (`/lk/integrations/v1/booked-operation-admissions`, `…/booked-operations/:operationId`),
   но ключи `LK2_BOOKED_OPERATION_DELEGATION_*` не заданы.

Если перенести только новые узлы и хунки, а хелперы и топологию не трогать, CREATE-путь
либо не заработает (`GAME_CREATE_OWNER_GRAPH_UNAVAILABLE`), либо, что хуже, получит
`ReferenceError` на этапе резерва/восстановления. Если переносить и хелперы — это уже пять
CRITICAL-функций router и целый поток подготовки, то есть расширение логики, а не перенос.

## Варианты (выбран C; A и B — если вернутся после первой версии)

- **A. Сначала привести живой граф подписочного бронирования к `main`.** Через существующий
  трёхсторонний merge `prepare_booked_operation_owner_compatibility.mjs`: сохраняет живые
  LK1-функции и добавляет канонические. Его live-преимиджи тоже устарели (совпадения нет), их
  придётся перебазировать. Затем поставить поток подготовки LK #273, затем перебазировать этот
  патч на результат. Это три отдельных CRITICAL-выкладки.
- **B. Новая реализация обёртки на живой линии** без JOIN v2 и recovery-хелперов. Это новый
  дизайн CRITICAL-пути с отдельным review, а не перенос.
- **C. Для первой версии не включать четвертной CREATE через LK1.** LK2 оставляет его выключенным.

## План установки (не применяется при варианте C; для A/B, когда будет кандидат)

Механизм: `scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs`,
stage `/root/.node-red/.padlhub-reviewed-flow-stage-<stamp>-<n>`, бэкапы
`/root/.node-red/.padlhub-reviewed-flow-backups/`. Пункты с ⚠ требуют согласия владельца.

1. Свежая проверка (только чтение): sha256 живого `flows.json` равен `sourceSha256` контракта,
   pm2 `node-red` online, нет активного `.padlhub-reviewed-flow-deploy.lease.json`.
2. Локально: `composeGameCreateOwner(live)` → `candidate.flow.json` + `contract.json` (exact-graph,
   `allowedChanges` = 6 узлов, `allowedAdditions` = 16 id `lk_game_create_owner_*_20261101`).
3. ⚠ Задать на LK1 `LK2_BOOKED_OPERATION_DELEGATION_*` (публичный ключ LK2, issuer, audience, kid).
   Это изменение секрета/конфигурации, отдельное согласие.
4. ⚠ Скопировать stage на сервер, затем `… preflight --candidate … --contract … --deployment-id …`.
5. ⚠ `… apply --candidate … --contract … --deployment-id … --stamp …`: бэкап flow/contract/candidate,
   атомарная запись, перезапуск `node-red` через pm2 и окно наблюдения (lease 15 мин).
6. Проверка: обычный `POST /lk/subscription-bookings`, GET-probe и split-оплата отвечают как до
   выкладки. Новые маршруты без подписи возвращают отказ. Приёмка LK2 `lk2:commercial-acceptance`
   идёт только с отдельного согласия: она создаёт реальные Viva-бронирования.
7. ⚠ Откат: `… rollback --deployment-id … --flow-backup <flows-pre-…json> --contract-backup <contract-…json>`
   в окне lease. Код-откат не отменяет уже созданные бронирования и списания визитов: их сверять вручную.
