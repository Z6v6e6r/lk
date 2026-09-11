# CUP: удаление игрока без Viva-брони — релизный пакет

Owner: current task. Audience: release operator for `lk-primary-147` and ph-admin (ЦУП).
Route: CRITICAL / R3. Статус: **пакет подготовлен, применение НЕ авторизовано**.

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
