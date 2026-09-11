# CUP: удаление игрока без Viva-брони — релизный пакет

Owner: current task. Audience: release operator for `lk-primary-147` and ph-admin (ЦУП).
Route: CRITICAL / R3. Статус: **LK применён и проверен; ph-admin выложен через env-переключение MAX-backend**.

Пакет не выполняет импорт Node-RED, рестарт, деплой и любые live-мутации. Для
применения нужно отдельное разрешение, называющее source, scope, target, порядок
операций, проверки, stop signal и recovery.

## Источник

| Репозиторий | Ветка | Коммит | PR |
| --- | --- | --- | --- |
| `lk` | `codex/cup-bookingless-removal-20260911` | `fe4cacd` | Z6v6e6r/lk#36 |
| `ph-admin` | `codex/cup-bookingless-removal-20260911` | `fc6e470` | Z6v6e6r/ph-admin#15 |

## Что меняется

LK, только тела трёх function-нод (function-only candidate):

- `lk_staff_player_leave_prepare_20260812` — `target.bookingId` необязателен; без брони только `visitAction=NO_RETURN`;
- `lk_staff_player_leave_authorize_20260812` — local-only `vivaTargetMode=NONE`, fail-closed при активной брони или запросе возврата посещения;
- `lk_split_leave_game_update_build_20260801` — обнуление слота уходящего в `metadata.teamSlots`.

ph-admin: `GamesService.resolvePlayerRemovalTarget` + DTO/клиент (`bookingId: string | null`).

## Preimage и кандидат (построено, не применено)

Свежий preimage с 147 и function-only кандидат:

- preimage: `sourceSha256=2ace2b60d0e246e84d5b9a542f6022ea1f7788c945dd855339e0ff0e47c09438`, nodes `4799`, routes `219`;
- candidate: `candidateSha256=2edad045b7d22d1f5f28d5e5f45050790a5aa383aea577550011d814d9f8ff46`, nodes `4799`, routes `219`, `brokenWires=0`, `brokenLinks=0`;
- contract: `contractSha256=2715889b04edd8160a89d57727ca15a96314a90a1aa2504860fecd8767945835`;
- изменены ровно 3 ноды и только поле `func`; reverse-контракт PASS; `deploymentPerformed=false`;
- builder: `scripts/prepare_cup_bookingless_staff_leave_candidate.mjs`.

Read-only pre-flight 147 на момент подготовки: активный `flows.json` SHA совпадает с preimage
(`2ace2b60…`), `pm2` `node-red` online (restart count 136), `CUP_LK_PLAYER_LEAVE_TOKEN`
присутствует в env процесса (значение не читалось).

## Порядок операций (LK, сначала)

1. Свежий preimage в новый приватный внешний workspace:
   `bash scripts/pull_nodered_source_from_147.sh /private/tmp/lk-cup-bookingless-<stamp>`,
   затем `node scripts/verify_nodered_source_origin.mjs --workspace <ws>`.
   Если `sourceSha256` отличается от `2ace2b60…` — **stop**, пересмотр и новый review.
2. Пересборка кандидата: `node scripts/prepare_cup_bookingless_staff_leave_candidate.mjs --workspace <ws>`.
   Ожидаемо тот же `candidateSha256=2edad045…`; иначе — **stop**.
3. Публикация tooling и артефактов на 147 в приватный каталог (`0700`, файлы `0600`):
   `candidate.flow.json`, `contract.json`, `scripts/nodered_reviewed_flow_deploy/`.
4. Preflight: `node deploy_reviewed_flow_147_remote.mjs preflight --candidate <candidate.flow.json> --contract <contract.json> --deployment-id cup-bookingless-staff-leave-20260911`.
5. Apply: то же с `apply --stamp <YYYYMMDDTHHMMSS+ZZZZ>` (атомарная публикация, backup, PM2 restart, soak).
6. Проверки после применения (см. ниже). При провале — rollback (см. ниже).

## Проверки после применения

- active `flows.json` SHA == `2edad045…`; nodes `4799`; routes `219`;
- `pm2` `node-red` online, restart count ровно `+1`, без цикла рестартов; RSS в обычном коридоре;
- `GET https://padlhub.su/lk/games/viva_6e7c314e-d078-4682-b3eb-845a1182effc` → 200 и participants без удалённого игрока;
- `POST /lk/internal/staff/games/<id>/player-leaves` без токена → 401 (роут жив, мутации нет);
- `GET /lk/games/by-phone?phone=79104310415` → 0 для этой игры (негативный postcheck прошлого удаления не сломан);
- function-only contract read-back: изменены ровно 3 ноды, поле `func`.

## Stop signal

- preimage SHA/node count/route count drift против пинов;
- `candidateSha256` ≠ `2edad045…`;
- preflight/apply fail-closed (lease, lock, contract, modes);
- PM2 restart loop или `node-red` не online в течение soak;
- любой 5xx на публичном `/lk/games/...` или регресс roster/`by-phone`.

## Recovery

- Штатный `deploy_reviewed_flow_147_remote.mjs rollback --deployment-id cup-bookingless-staff-leave-20260911 --flow-backup <stamp> --contract-backup <stamp>`;
- дополнительно создаётся timestamped backup `flows.json` (как в `apply`) — восстановление файла + `pm2 restart node-red`;
- изменение function-only, поэтому reverse-контракт возвращает живые тела байт-в-байт без миграций данных.

## ph-admin (после LK)

1. Собрать артефакт на релизном toolchain (`node v22.13.1`, `npm 11.1.0`):
   `npm run backend:release-attestation:build -- --source <checkout> --output <private dir> --expected-head <sha> --expected-tree <sha> --trusted-ref <ref>`.
   Локальная машина не подходит: `BACKEND_RELEASE_TOOLCHAIN_MISMATCH` (fail-closed).
2. Опубликовать релиз в сервис ЦУП по его штатной процедуре, затем проверить:
   `POST /games/:id/players/:playerId/removal-requests` с `refundPolicy=NO_RETURN` для игрока без платежей → операция создана, LK приняла local-only удаление;
   `refundPolicy=RETURN_VISIT` для такого игрока → 409 с понятным текстом.

Порядок обязателен: LK первым, иначе ЦУП получит 400/409 от старого контракта.

## Ограничения этого пакета

Пакет не авторизует и не выполняет: импорт Node-RED, рестарт сервисов, деплой,
live-мутации данных, merge PR. Контракт и кандидат действительны только для preimage
`2ace2b60…`; при дрейфе живого flow пакет пересобирается заново.

## Ход применения (2026-09-11)

### LK — применено и проверено

- свежий preimage подтвердил `2ace2b60…` (4799 nodes / 219 routes), пересборка дала тот же
  `candidateSha256=2edad045…` и `contractSha256=2715889b…`;
- stage `/root/.node-red/.padlhub-reviewed-flow-stage-20260911T154743+0300-3541` (0700/0600);
- `preflight` → `ok:true`; `apply --stamp 20260911T154800+0300` → `activeFlowSha256=2edad045…`,
  `node-red` restart count `136 → 137`, lease `soaking` до `2026-09-11T13:03:12Z`;
- backups: `flows-pre-cup-bookingless-staff-leave-20260911-20260911T154800+0300.json`,
  `contract-…json`, `candidate-….flow.json` в `/root/.node-red/.padlhub-reviewed-flow-backups/`;
- postchecks: nodes 4799 / routes 219; `pm2` online, restart count без роста; RSS в норме;
  новый ошибок в логах нет; `GET /lk/games/viva_6e7c314e-…` → 200, удалённого игрока нет,
  snapshot чистый; `by-phone?phone=79104310415` → 0; `/lk/games` по identity-контракту → 400
  («phone or clientId or … required»), `?public=true` → 200;
- staff-роут внутренний: публично nginx отдаёт 404, напрямую `127.0.0.1:1880` → **401
  UNAUTHORIZED** (auth работает, мутации нет).

### ph-admin — заблокировано, откат выполнен

Релиз собран на 147 релизным toolchain (`node v22.13.1`, `npm 11.1.0`):
`archiveSha256=80a55336161fa292a83e9ee20b7fe7d1018a59ff8fb74a96eb9f54378839cd8b`,
`runtimeFileCount=9336`, манифест записан.

Выкладка нового релиза упала на старте: `MONGO_INDEX_READINESS_CHECK_FAILED:support_clients`
(`mongo-index.guard.js` → `listIndexes()` на БД `support_max`). Unit автоматически откатился на
предыдущий релиз, прод проверен: `/api/health` → 200, сервис active.

Причина не связана с этой задачей: guard введён коммитом `ebe0961` («fix: verify Mongo indexes in
production»), которого нет в работающем p34 (`d2a4787`): в p34 `mongo-index.guard.js` отсутствует и
`ensureMongoIndex` не вызывается. То есть **любой релиз из текущего main не поднимается на 147**,
пока Mongo-пользователю не доступны индексные операции на `support_max`. Env-переключателя у guard
нет (`isProductionRuntime` + безусловная проверка).

Минимальное условие продолжения: выдать Mongo-пользователю права на `listIndexes`/`createIndexes`
для `support_max` (или отдельно одобренное изменение поведения max-backend readiness), после чего
повторить выкладку того же артефакта.

Новый релиз-каталог `/opt/ph-admin-releases/ph-admin-backend-fc6e470be35d` остаётся на диске как
неактивный (unit на него не ссылается), predeploy-бэкап —
`/opt/ph-admin-release-backups/ph-admin-backend-fc6e470-predeploy/`.

## Развязка по ph-admin (2026-09-11, продолжение)

Блокер: `MONGO_INDEX_READINESS_CHECK_FAILED:support_clients` при `listIndexes` на `support_max`.
Поиск по проекту: 13 env-файлов (`/opt/ph-admin`, `/opt/phab-subscriptions-dev`,
`/root/.codex-backups`, `/root/.ph-admin-deploy`) содержат **одну** Mongo-учётку
(`gen_user@admin`, `readWrite` на 5 БД) — отдельного логина/URI для `support_max` нет
(ключ `SUPPORT_MAX_MONGODB_URI` существует в коде, но не задан нигде). Обе доступные
учётки (`gen_user`, `zver`) на `grantRolesToUser` получают `error 13 Unauthorized`.

Решение (согласовано): перевести MAX-backend на доступную БД с **отдельными** коллекциями,
чтобы не смешать данные с основной поддержкой:

- созданы коллекции `dialog.max_support_{clients,dialogs,messages,service_messages,response_metrics,outbox}` с 19 индексами, идентичными `ensureIndexes` (`missing_after_create: 0`);
- в `/opt/ph-admin/.env` заданы `SUPPORT_MAX_MONGODB_DB=dialog` и шесть `SUPPORT_MAX_*_COLLECTION=max_support_*` (`SUPPORT_MAX_MONGODB_URI` не задан → используется основной `MONGODB_URI`);
- бэкап env: `/opt/ph-admin-release-backups/ph-admin-backend-fc6e470-predeploy/env.pre` (sha256 `2d99eaec327e5e7e1d3683e486a1e9a6a48df3ba8a70187223fc620b7791255b`), unit-бэкап рядом.

Выкладка и проверки:

- unit переключён на `/opt/ph-admin-releases/ph-admin-backend-fc6e470be35d` (`PHAB_RELEASE_SHA=fc6e470be35d169ff2df2209ddeedd9355b55f01`), `daemon-reload` + restart;
- `/api/health` → 200; `NRestarts=0`; `service active`; в журнале `MongoDB support persistence enabled. backend=max db=dialog` (LOG, не ERROR); `MONGO_INDEX_*` ошибок 0; в `dist/games/games.service.js` присутствует новый маркер `no paid visit to return`;
- публично: `/api/health` 200, `/api/client-script/admin-panel.js` 200, `/admin` 302, LK-игра 200;
- данные `support_max` остаются невостребованными (прочитать их было нельзя — `listCollections` Unauthorized); MAX-backend до этого фактически не работал, т.к. индекс-операции там были запрещены.

## Параллельная выкладка на 147

Во время работ другой оператор/автоматика выложил ещё два reviewed-релиза:
`subscription-hub-daily-limit` (16:09 MSK) и `split-leave-active-viva-demotion-20260911`
(16:30 MSK). Активный `flows.json` теперь `e5d64351…` (их кандидат), lease принадлежит
`split-leave-active-viva-demotion-20260911`. Все три тела из этого пакета сохранены без
изменений (`302b4c29…`, `21b49b99…`, `e1bce1a4…`), поэтому LK-фикс продолжает действовать;
рестарты Node-RED 137 → 139 — это рестарты тех выкладок, `unstable restarts: 0`.
