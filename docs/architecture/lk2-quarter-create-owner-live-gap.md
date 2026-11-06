# Четвертной CREATE: живой LK1 → main (решение A, 2026-11-06)

Решение владельца: **A — подтянуть живой LK1 к `main`**, затем поставить поток подготовки CREATE
(LK #273) и перебазировать обёртку. Этот PR — **шаг A1**: перебазированное трёхстороннее
слияние узлов подписочного бронирования на текущий живой образ. Только исходники и тесты:
на живом LK1 ничего не выполнено. Шаги A2 (LK #273) и A3 (обёртка) не начаты.

## Исходное расхождение (только чтение, 2026-11-06)

Живой `/root/.node-red/flows.json` на `lk-primary-147`, sha256
`9ed37134a09bb2283160325ee5f18104983720c26f7135f869d6266ee1912425`. Последняя запись —
`fpr284-event-20261103`, она трогала только турнирные узлы. Копия лежала вне репозитория и удалена.

Живой граф подписочного бронирования — это установленная сборка совместимости владельца
(`57648b82`), поверх которой есть LK1-функции, которых нет в `main`: trial-group,
pro-training, topokraty, оплата событий LK1, правила тарифов, исключения по станциям,
rejoin/reclaim, product router. В `main` с тех пор появились JOIN v2, owner readback,
precreate rejection, managed leave, training owner, хунки четвертного CREATE и диагностика.

Живые sha256 `func`:

```
router       5e571a859e3ac3363e54d5a21836f9e6199b4dbd14f6c2441e97c356bfdd64ce
prepare      f1cbb94f598635abd767c3494fd0a4d24e8049f3c64a68f2069a731cbd76cf12
finalize     2f62d0efd4ed4424b03e43d5f5435ec27fbdebc218be6df8cd99d096b1e7e8ab
mongo_error  1c786def280a91c684dae8a71d56ac903ad1912f059145aa85d1dab0944f3a56
options      949efce458f5fbd1ba9cb6178f4db75fddc39a9f4affa21ad2268eca58d5b395
split create f3f9a60354d394da: b69eb36c138d5b9ae6ac020202148ca6d86f7495b4046811f7dde1473ea0ef9d
split router 8f7bd5b482fe9763: d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b
```

## Шаг A1: что делает слияние

`scripts/lib/bookedOperationOwnerLiveRebase.mjs` + `scripts/prepare_booked_operation_owner_live_rebase.mjs`.

- Три стороны: LIVE — установленный `func` (точный sha), BASE — канонические исходники
  `57648b82` (живой содержит все их операторы), CANONICAL — текущие исходники (точный sha).
- Слияние по операторам. Живые-only операторы защищены: router — 160, finalize — 5.
  Операторы, которые живой не менял, берутся из main. Остальные сливаются через
  `git merge-file`, и каждая живая строка обязана сохраниться.
- Пять перекрытий решены явно и привязаны к sha хунков; новое или изменённое перекрытие
  останавливает сборку:
  - `emit`, `prepareBookingCreate` — сначала живые гейты trial/preflight, затем канонические;
  - `managed_entitlement_reserve` — сначала строгая проверка JOIN v2, затем установленная общая;
  - `profile` — живой перенёс release/preflight в `lk1_profile_continue`. Канонические блоки
    SELF leave и JOIN v2 переносятся туда же, перед release. Поэтому JOIN v2 и
    `lk2LegacyJoin` из тела запроса проходят LK1 ingress replay и product identity и не обходят их;
  - `prepare` — непересекающиеся ключи allowlist.
- Явные адаптации под живую топологию:
  - SELF leave в main читает полномочия через выход router 7. На живом выход 7 — это
    product router, хранилища leave нет. Поэтому SELF leave отвечает `MANAGED_SELF_LEAVE_GRAPH_UNAVAILABLE`;
  - probe рекламирует только контракт `1`, как и сейчас. `2` (JOIN v2) требует обновлённого
    receiver (`71db8103`), `3` (SELF leave) — своего графа;
  - `options` и managed policy не меняются: GET-ветка training из main возвращает выход 3,
    которого на живом нет.
- Пакет: 4 узла, меняется только `func` (router, prepare, finalize, mongo_error). 0 добавлений,
  провода, id и `initialize` не меняются, контракт exact-graph. Кандидат на живом образе
  `9ed37134…`: `8fb31c923f3ce8dd6ff7b9bf1d9f5fccae795e77b675d9a458f567d60042b420`.

## Проверки (LOCAL)

`scripts/tests/bookedOperationOwnerLiveRebase.test.mjs`, подключён в `test:booked-operation-receiver`.

- Без живой копии (CI): механика слияния, отказы на неизвестное перекрытие, потерю или
  удаление оператора, двойное добавление, привязка канонических sha и base-блобов.
- С живой копией (`LK1_OWNER_LIVE_FLOW_FIXTURE=/private/flows.json`), 29/29:
  - меняются только 4 `func`, остальные узлы побайтно те же;
  - матрица router: 57 живых шагов × 7 контекстов × 21 ответ провайдера — ответы совпадают;
  - prepare, finalize, mongo_error на обычных входах совпадают;
  - граф от `POST /lk/subscription-bookings` по настоящим проводам с фейковыми Viva и Mongo:
    открытая игра (HUB, спорт), турнир, групповая тренировка, скидки, выбор места, release
    (после отмены, с операцией в базе, ещё активная), без авторизации, без ключа
    идемпотентности. Трасса запросов, операций и ответа совпадает;
  - ожидаемые отличия: тело с `trainingRegistration` → 400 `TRAINING_REGISTRATION_INVALID`
    (раньше бронировалось как обычное); `lk2LegacyJoin` → JOIN recovery только после
    LK1 ingress и product identity; SELF leave закрыт; probe v1/v2/v3 отвечает как раньше.
- Граница покрытия: фейковая Viva доходит до проверки денег LK1 (`LK1_MONEY_*`), но не до
  создания брони. Путь split-оплаты проверен матрицей шагов (caller `split`,
  `split_create_readonly_preflight`), а не графом от `/lk/games`. Узлы split в A1 не меняются.

## План выкладки A1 (ничего не выполнено; ⚠ — отдельное согласие владельца)

Механизм: `scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs`. Схема —
как в `scripts/deploy_nodered_lk1_confirmed_replay_guard_147.sh`: stage
`/root/.node-red/.padlhub-reviewed-flow-stage-<stamp>-<pid>`, бэкапы
`/root/.node-red/.padlhub-reviewed-flow-backups/`.

1. Локально, после merge в `main`: `npm run nodered:modular:pull-147 -- /abs/new/workspace`
   (только чтение). Если живой sha ≠ `9ed37134…`, стоп: слияние нужно перебазировать заново.
2. Локально: `node scripts/prepare_booked_operation_owner_live_rebase.mjs /abs/workspace /abs/new/out`
   → `candidate.flow.json`, `contract.json`, `report.json`. Затем прогнать тест с этой копией.
3. ⚠ Создать stage на сервере и скопировать кандидат, контракт и runner (`install -d -m 700`, `scp`).
4. ⚠ `node <stage>/deploy_reviewed_flow_147_remote.mjs preflight --candidate … --contract … --deployment-id owner-live-rebase-<sha12>`.
   Должно быть `ok`, `sourceSha256 = 9ed37134…`, ровно 4 изменённых узла.
5. ⚠ `… apply … --stamp <stamp>`: бэкап flow и контракта, атомарная запись, перезапуск
   `node-red` через pm2, lease 15 мин.
6. Проверка: `sha256sum /root/.node-red/flows.json` = кандидат. pm2 `node-red` online.
   `GET /lk/subscription-bookings` с `x-booked-operation-owner-contract: 1` → 200 v1;
   с `2` и `3` → 404. `POST` без авторизации → 401 `SUBSCRIPTION_BOOKING_AUTH_REQUIRED`.
   Затем 15 мин наблюдения по логам `node-red`: нет `ReferenceError` и новых `*_PENDING`.
7. ⚠ Откат в окне lease: `… rollback --deployment-id … --flow-backup <flows-pre-…json> --contract-backup <contract-…json>`.
   Откат кода не отменяет брони и списания, созданные после apply: их сверять вручную.

Остановка до apply: дрейф живого sha, preflight не `ok`, активный чужой lease.
После apply: readback ≠ кандидат, 401-smoke не проходит, `ReferenceError` в логах. Во всех
этих случаях — откат шага 7.

## Следующие шаги (не начаты)

- A1b: training owner (`patch_nodered_training_registration_owner.mjs`), managed SELF leave и
  receiver JOIN v2 ожидают преимиджи, которых на живом нет. Их нужно так же перебазировать
  на результат A1, и только тогда включать probe `2`/`3` и GET-ветку training.
- A2: поток подготовки CREATE (LK #273).
- A3: перебазирование `patch_nodered_game_create_owner.mjs` на результат A1/A2.
