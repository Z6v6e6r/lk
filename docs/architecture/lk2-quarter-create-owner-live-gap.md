# Четвертной CREATE: живой LK1 → main (решение A, 2026-11-06)

Решение владельца: **A — подтянуть живой LK1 к `main`**, затем поставить поток подготовки CREATE
(LK #273) и перебазировать обёртку. Этот PR — **шаг A1**: перебазированное трёхстороннее
слияние узлов подписочного бронирования на текущий живой образ. Только исходники и тесты:
на живом LK1 ничего не выполнено. Шаги A2 (LK #273) и A3 (обёртка) не начаты.

## Исходное расхождение (только чтение, 2026-11-06)

Живой `/root/.node-red/flows.json` на `lk-primary-147`, sha256
`9ed37134a09bb2283160325ee5f18104983720c26f7135f869d6266ee1912425`. Последняя запись —
`fpr284-event-20261103`, она трогала только турнирные узлы. Копия лежала вне репозитория и удалена.

Обновление 2026-11-06 15:47 MSK: `fpr-cup-start-20261106` добавил 12 турнирных узлов в другой вкладке
и поменял провода одного турнирного узла. Новый живой sha — `f6fd9f05d29e864000f8b7ca1b41aef4281dbe41821d8114a1011584e3d4e18f`.
Четыре узла бронирования, options и топология побайтно те же. Пин обновлён, слияние пересобрано.

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
  `f6fd9f05…`: `76ed585f54971ab2b9fa7f4c6ffc3b98e7064f42c73fc5969be2bca5879f988a`.

## Проверки (LOCAL)

`scripts/tests/bookedOperationOwnerLiveRebase.test.mjs`, подключён в `test:booked-operation-receiver`.

- Без живой копии (CI): механика слияния, отказы на неизвестное перекрытие, потерю или
  удаление оператора, двойное добавление, привязка канонических sha и base-блобов.
- С живой копией (`LK1_OWNER_LIVE_FLOW_FIXTURE=/private/flows.json`), 32/32:
  - меняются только 4 `func`, остальные узлы побайтно те же;
  - матрица router: 57 живых шагов × 7 контекстов × 21 ответ провайдера — ответы совпадают;
  - prepare, finalize, mongo_error на обычных входах совпадают;
  - граф от `POST /lk/subscription-bookings` по настоящим проводам с фейковыми Viva и Mongo:
    открытая игра (HUB, спорт), турнир, групповая тренировка, скидки, выбор места, release
    (после отмены, с операцией в базе, ещё активная), без авторизации, без ключа
    идемпотентности. Трасса запросов, операций и ответа совпадает;
  - путь записи: продукт вне правил LK1 (legacy-когорта) проходит Viva POST, вставку, чтение
    подтверждения, confirm и 201 CONFIRMED. Управляемый турнир ЦУП проходит runtime-context,
    reserve, bind, Viva POST, entitlement confirm и 201. При частичной цене идёт release. Трасса и
    записи в Mongo совпадают;
  - ожидаемые отличия: тело с `trainingRegistration` → 400 `TRAINING_REGISTRATION_INVALID`
    (раньше бронировалось как обычное); `lk2LegacyJoin` → JOIN recovery только после
    LK1 ingress и product identity; SELF leave закрыт; probe v1/v2/v3 отвечает как раньше.
- Граница покрытия: путь денег LK1 для HUB и спорта (`LK1_MONEY_*`) не доведён до записи.
  Путь split-оплаты проверен матрицей шагов (caller `split`, `split_create_readonly_preflight`),
  а не графом от `/lk/games`. Узлы split в A1 не меняются.

## Независимая проверка (2026-11-06)

Два независимых ревьюера (только чтение): целостность бронирования/слияния и безопасность.

- Безопасность: блокирующих замечаний нет. Поля из тела (`lk2LegacyJoin`, `managedJoinV2`,
  `managedSelfLeave`, `trainingRegistration`) не обходят LK1-гейты и не открывают записи раньше
  identity. Единственный `emit(7)` — живой product identity. Probe не рекламирует 2/3.
- Слияние: потерь нет. Порядок живых операторов сохранён, 160 защищённых операторов не
  изменены, все `emit` в пределах 0–6 плюс живой 7. Блокирующее замечание было одно —
  тесты не доходили до записи. Закрыто тестами пути записи выше.
- Проверено на живом (только чтение): global context в памяти, `functionGlobalContext` задаёт
  только флаг A/B, `os`, `fs`. Ни один узел не ставит `subscriptions_owner_evidence_*` или
  `lkDiagnostics`. Owner evidence и подписант JOIN v2 после установки выключены.
- Известные изменения поведения: тело с `trainingRegistration` → 400 (через split — 202 pending
  до записи). Повтор операции, начатой с `lk2LegacyJoin`, уже без него → 409
  `MANAGED_JOIN_V2_BINDING_CONFLICT`. Probe с заголовком training → 404 с кодом
  `TRAINING_REGISTRATION_OWNER_UNAVAILABLE` вместо `BOOKED_OPERATION_OWNER_PROBE_NOT_FOUND`.

## План выкладки A1 (ничего не выполнено; ⚠ — отдельное согласие владельца)

Механизм: `scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs`. Схема —
как в `scripts/deploy_nodered_lk1_confirmed_replay_guard_147.sh`: stage
`/root/.node-red/.padlhub-reviewed-flow-stage-<stamp>-<pid>`, бэкапы
`/root/.node-red/.padlhub-reviewed-flow-backups/`.

1. Локально, после merge в `main`: `npm run nodered:modular:pull-147 -- /abs/new/workspace`
   (только чтение). Если живой sha ≠ `f6fd9f05…`: если узлы бронирования не менялись, обновить пин
   и пересобрать; иначе — перебазировать слияние заново.
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
- A2: поток подготовки CREATE (LK #273) — см. раздел «A2» ниже.
- A3: перебазирование `patch_nodered_game_create_owner.mjs` на результат A1/A2. Guard
  `ctx.managedCreateBinding !== undefined` нужно поставить раньше живых LK1-обработчиков шагов.
  Ветка quarter-capability в prepare возвращает выход 3: подключить его до включения обёртки.
- Перед apply: подтвердить, что LK2 считает любой 404 probe «недоступно». Split-оплата должна
  трактовать 202 PENDING_CONFIRMATION шага бронирования как неоднозначный результат без списания.

## Состояние живого LK1 на 2026-11-07

- A1 установлен 2026-11-06 в 17:07 MSK (`owner-live-rebase-8f1d15af78c1`, кандидат `76ed585f…`).
- Затем другая задача поставила `fpr-start-bootstrap-20261106`: три узла турнирного старта,
  `76ed585f…` → `6b822364…`.
- P3 (2026-11-07): в pm2 env `node-red` заданы флаги приёмника и исполнения и делегация LK2
  (issuer `https://lk2.padlhub.su`, kid `lk2-beta-2026-11`, SPKI `5196476e…`).
- `LK1_BOOKED_OPERATION_OWNER_BASE_URL` и `LK1_BOOKED_OPERATION_OWNER_TENANT_KEY` не заданы,
  поэтому executor бронирования отвечает 503 без вызова Viva.

## A2 — приватный маршрут подготовки CREATE (LK #273)

Исходники LK #273 (`3678c039`) уже в `main`. A2 добавляет только сборщик пакета под живой граф:
`scripts/prepare_game_create_preparation_live.mjs`. Это чисто аддитивная установка: новая вкладка
и 8 узлов в конце файла, `POST /lk/integrations/v1/game-create-preparations`. Существующие узлы,
провода и маршруты не меняются; контракт — exact-graph с 0 изменений.

Сборщик падает, если на живом графе нарушен любой из фактов:

- whole-flow sha = `6b822364…`;
- `serviceByStation` живого онбординга (`22ee96a6857b3a35`) совпадает с встроенной таблицей
  (8 станций, master/sub);
- есть активный узел `global.set('vivacrm_access_token')` — его использует админское чтение каталога;
- есть активный маршрут приёмника admission;
- ни один существующий POST/ALL-маршрут не перехватывает новый путь (Express нестрогий);
- функции кандидата байт-в-байт равны исходникам `main`; нет узлов Mongo/inject/link.

Тесты: `scripts/tests/gameCreatePreparationLive.test.mjs`.

- 5 синтетических — в CI.
- 3 LIVE — с приватной копией живого flows (`LK1_GAME_CREATE_LIVE_FLOW_FIXTURE`):
  - граф не изменён;
  - все 8 станций проходят только через GET;
  - без флагов, ключа или подписи маршрут закрыт без чтений;
  - без админского токена — только два чтения по токену игрока.

**Важно для установки.** После P3 флаги приёмника и исполнения включены. Значит, маршрут
начнёт работать сразу после apply для запросов, подписанных LK2:

- до 6 ограниченных GET в Viva, в том числе каталог с админским токеном LK1;
- без записи в Mongo и провайдера, без резерва и брони.

Остановить маршрут без отката flow можно только общими флагами, а это остановит и приёмник.
Поэтому быстрый стоп — откат шага 6.

### План установки A2 (⚠ — отдельное согласие владельца)

1. После merge в `main`: свежий pull живого flows только на чтение. Если sha ≠ `6b822364…` —
   обновить пин после проверки, что факты выше не изменились, и пересобрать.
2. `node scripts/prepare_game_create_preparation_live.mjs /abs/workspace /abs/new/out`.
   Затем LIVE-тесты с этой копией.
3. ⚠ Stage на сервере: кандидат, контракт и runner.
4. ⚠ `preflight --deployment-id game-create-preparation-<sha12>`: `ok`, 0 изменений, 8 добавлений.
5. ⚠ `apply --stamp <stamp>`: бэкап, атомарная запись, рестарт `node-red`, lease 15 мин.
6. Проверка:
   - readback = кандидат;
   - `POST /lk/integrations/v1/game-create-preparations` без подписи → 401
     `GAME_CREATE_PREPARATION_DELEGATION_INVALID`;
   - smoke A1 и P3 без изменений;
   - 15 мин логов без ошибок новых узлов.
7. ⚠ Откат: `rollback --deployment-id … --flow-backup … --contract-backup …`.
   Маршрут ничего не пишет, поэтому откат не оставляет состояния.
