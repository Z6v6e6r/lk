# Partner API: установка dedicated sidecar (2026-09-11)

Статус: **sidecar установлен, запущен и остаётся default-off**. Активация не выполнялась.
Ingress на общем 443 замкнут со sidecar: валидный запрос получает
`503 PARTNER_API_DISABLED`.

## Что установлено

| Элемент | Значение |
| --- | --- |
| Release | `/opt/padlhub/partner-game-membership/releases/v02-20260911` |
| Alias | `/opt/padlhub/partner-game-membership/current` → release |
| Состояние | `/var/lib/padlhub/partner-game-membership` (user `partner-game-api`, mode `0700`) |
| Сервисный пользователь | `partner-game-api` (system, uid 995, без shell) |
| Unit | `/etc/systemd/system/partner-game-membership-sidecar.service` (`3abbb557…`) |
| Drop-in | `…service.d/bound.conf` (`f2be5853…`): `STARTUP_MODE=BOUND_DEFAULT_OFF`, `AUDIENCE=padlhub-partner-game-prod` |
| Anchor | `/etc/padlhub/partner-game-membership/approved-startup.json` (`c3131d0f…`, `0640 root:partner-game-api`) |
| Candidate flow | `5a5aefe3dd19a8e6687222c80b229a40f924174359c181be7caaa6997134e965` |
| Packet manifest | `3ed3720ee0d9817c918c598b796a05d69ba7543c015a9342b36b0433f321de03` |
| Runtime | Node-RED `5.0.6`, Node `22.23.2`, установлен `npm ci --ignore-scripts --no-fund --no-audit` |
| Listener | только `127.0.0.1:18894` |

Anchor привязан к `approvedCommit=fdc9f14feaace6566aa237f21c14d6877ca1e9ba` и
`approvedTree=95d5063a0ab04c3635b45aaa5fb578515276e122`, `deployAuthorized=false`,
`activationAuthorized=false`.

## Как ставилось

1. `useradd --system` для `partner-game-api`; созданы `/opt/padlhub/partner-game-membership/releases` и state-каталог `0700`.
2. Packet из `nodered:partner-game-membership:v02-packet` загружен целиком (37 файлов manifest), AppleDouble `._*` удалены.
3. Владелец файлов приведён к `root:partner-game-api`, каталоги `0750`, файлы `0640`; `node_modules` намеренно не трогали, чтобы не сломать `.bin/node-red`.
4. `npm ci --ignore-scripts --no-fund --no-audit` в `runtime/`; проверены Node-RED `5.0.6` и симлинк `node_modules/@padlhub/node-red-partner-game-membership-api → ../../partner-package`.
5. Установлен unit, `systemctl enable --now`, затем включён `BOUND_DEFAULT_OFF` через drop-in и anchor.

Отдельно потребовалось исправить `anchor` с `0600 root:root` на `0640 root:partner-game-api`:
guarded startup читает его от лица сервисного пользователя, и `0600` давал отказ
`PARTNER_GUARDED_STARTUP_REFUSED`.

## Проверки

| Проверка | Результат |
| --- | --- |
| `systemctl is-active` / `is-enabled` | `active` / `enabled` |
| Listener | `127.0.0.1:18894` (только loopback) |
| Напрямую на sidecar (`Host: unbound.invalid`) | `503 PARTNER_API_DISABLED` |
| Через ingress, валидный маршрут + mTLS + proof-заголовки | `503 PARTNER_API_DISABLED` |
| Через ingress, `GET` операции | `503` |
| Без клиентского сертификата | `400` |
| Чужой `Host` | `421` |
| Маршрут вне allowlist | `404` |
| TLS 1.1 | отказ |
| `padlhub.su` / `score.padlhub.su` / `kozlovatv.ru` | `302` / `410` / `200` — без изменений |

Private evidence: `/private/tmp/partner-canary-mtls-20260911/` (вне Git).

## Rollback

1. `systemctl disable --now partner-game-membership-sidecar`.
2. Убрать `/etc/nginx/conf.d/partner-game-membership-api-v02.conf`, `nginx -t`, `reload`.
3. `current` можно вернуть на предыдущий release или удалить каталог releases.
4. `ledgers`/audit в state-каталоге **не удалять** до завершения reconciliation.

## Остаточные риски

- Activation **не выполнена**: `LK_PARTNER_GAME_API_ENABLED=false`, provider `disabled`.
  Это осознанное состояние, а не «готово к бою».
- Keyring, Mongo и Viva-техклиент не настроены; реального вызова Viva не было.
- Клиентский mTLS-сертификат и allowlist источника — **канареечные** (наш CA + IP
  `89.108.64.209`, `109.173.114.67`); перед передачей партнёру заменить на его CSR/адреса
  и перегенерировать overlay.
- Anchor привязан к task-branch commit; для реального релиза нужен packet с релизного
  коммита и новый anchor.
- Продление сертификата `partner-api.padlhub.su` идёт через `authenticator=nginx`
  (временная правка конфига + `reload`).

## Keyring и окружение (2026-09-11)

Добавлено:

- `/etc/padlhub/partner-game-membership/service.env` (`0640 root:partner-game-api`) с
  `LK_PARTNER_GAME_API_KEYRING_JSON`, `LK_PARTNER_GAME_API_AUDIENCE=padlhub-partner-game-prod`,
  `LK_PARTNER_GAME_API_ENVIRONMENT=production`, `LK_PARTNER_GAME_API_AUDIT_HMAC_KEY`;
- drop-in `…service.d/credentials.conf` с `EnvironmentFile=/etc/padlhub/partner-game-membership/service.env`.

Keyring (server-only) содержит канареечного клиента `padlhub-canary`: `enabled: true`,
scopes `members:add`/`members:remove`/`operations:read`, `keyId` `canary-2026-09` со
случайным секретом 32 байта. `stationIds` и `games` **пока пустые** — тестовая игра и
станция в репозитории не зафиксированы (`canaryGameIds: []`, `"<allowed-station-id>"`),
поэтому allowlist надо заполнить перед активацией.

Секреты сгенерированы на операторской машине и лежат приватно (`/private/tmp/partner-canary-mtls-20260911/`,
`0600`), в репозиторий не попадают. `AUDIT_HMAC_KEY` — 32 случайных байта в base64url.

Проверено после перезапуска: сервис `active`, listener `127.0.0.1:18894`, в окружении
процесса присутствуют `LK_PARTNER_GAME_API_{KEYRING_JSON,AUDIENCE,ENVIRONMENT,AUDIT_HMAC_KEY}`,
флаги остаются `ENABLED=false`, `PROVIDER_MODE=disabled`, `VIVA_MUTATIONS_ENABLED=false`,
`STARTUP_MODE=BOUND_DEFAULT_OFF`. Запрос через ingress по-прежнему возвращает
`503 PARTNER_API_DISABLED`; `padlhub.su` `302`, `score.padlhub.su` `410` без изменений.

**Важно про «ключ проходит».** При `ENABLED=false` проверка ключа и подписи **не
выполняется вообще**: `getRuntime()` возвращает `PARTNER_API_DISABLED`/`503` раньше, чем
читается keyring (`partner-game-membership-node.cjs:70`). Поэтому состояние «503, но
подпись уже проверена» одновременно недостижимо: keyring валидируется только при сборке
runtime, то есть после активации. Сейчас корректно говорить: keyring **настроен**, но
ещё не задействован.

## Боевая Mongo: факты и блокеры (2026-09-11)

Владелец подтвердил боевую Mongo. Что установлено read-only пробником через драйвер
рантайма (секреты не печатались):

- хост `147.45.254.160:27017`, БД `games`, replica set `mongodb-510979`, primary
  `192.168.0.4:27017` (внутренний адрес в `hello.hosts`);
- боевой Node-RED подключается как `mongodb://…@147.45.254.160:27017/games?authSource=admin&directConnection=true&retryWrites=false`,
  то есть **через `directConnection` к primary**, минуя discovery — sidecar должен
  повторять этот режим, иначе внутренний `192.168.0.4` недостижим;
- пользователь LK имеет роли `readWrite` на `PadlhUBScore`, `dialog`, `events`, `games`,
  `games_chat` и **не имеет `userAdmin`**;
- коллекций `lk_partner_*` в БД нет; в `lk_games` индексы только `_id_`,
  `schedule_station_date_time_v1`, `lk_games_payment_booking_lookup_wildcard_v1`.

**Блокер A — создать Mongo-пользователя я не могу.** Ролей приложения недостаточно для
`createUser` (нужен `userAdmin`/`userAdminAnyDatabase`), а других креденшелов у меня нет.
Нужно, чтобы пользователя создал владелец БД (или выдал административный доступ не через
чат). Целевые роли — минимальные:

```js
db.getSiblingDB("games").createUser({
  user: "partner-game-api",
  pwd: passwordPrompt(),
  roles: [
    { role: "readWrite", db: "games", collection: "lk_games" },
    { role: "readWrite", db: "games", collection: "lk_partner_api_nonces" },
    { role: "readWrite", db: "games", collection: "lk_partner_game_operations" },
    { role: "readWrite", db: "games", collection: "lk_partner_game_memberships" },
    { role: "readWrite", db: "games", collection: "lk_partner_api_audit" },
    { role: "readWrite", db: "games", collection: "lk_partner_game_outbox" }
  ]
})
```

**Блокер B — миграция индексов, и её нельзя делать ad-hoc.** В репозитории
production-путь только **проверяет** индексы (`verifyRequiredIndexes`); создаёт их лишь
`ensureIndexesForIsolatedTest()` для изолированного режима.

Read-only pre-check боевой БД (`games`):

- `lk_games`: **18 013** документов, без `id` — 0, с пустым `id` — 0;
- **есть 1 группа дубликатов** `{tenantKey, id}`:
  `{tenantKey: null, id: "pay_3a8aa2de-365d-45ce-827c-0094ea344e6a"}` — 2 документа
  (`…75ea` CANCELLED, обновлён 2026-05-23, 4 участника; `…75eb` PAID, не обновлялся с
  создания 2026-05-11, 1 участник; вставки различаются на 12 мс — гонка двойной вставки);
- существующие индексы `lk_games`: `_id_`, `schedule_station_date_time_v1`,
  `lk_games_payment_booking_lookup_wildcard_v1`; `uniq_tenant_game_id` **отсутствует**;
- коллекций `lk_partner_*` нет.

Уникальный индекс `uniq_tenant_game_id` на такой коллекции **не построится** — дубликат
его блокирует, и этот дубликат нужно сначала отремонтировать по решению владельца
(какой документ канонический: отменённый с поздним апдейтом или оплаченный с создания).

Кроме того, `uniq_tenant_game_id` на `lk_games` **уже принадлежит другой управляемой
production-миграции** — legacy game command
(`LEGACY_COMMAND_INDEX_SPECS.games` в `node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs`),
а у неё есть режимы `audit`/`dry-run`/`apply`/`postcheck`/`rollback-plan`, аудит дубликатов
по `["tenantKey","id"]` и подписанный production-approval с trust anchor
(`scripts/run_legacy_game_command_production_migration.mjs`). Значит создавать этот индекс
вручную нельзя: правильный путь — эта миграция либо отдельное явное решение владельца.

Индексы пяти коллекций `lk_partner_*` — отдельная, партнёрская миграция; готового
инструмента в репозитории нет, его нужно добавить. Индексы additive, откат — drop
созданного.

**Блокер A (обновление).** Переданные креденшелы `partner-game-api` **не проходят
аутентификацию** ни с `authSource=admin`, ни с `authSource=games` (`AuthenticationFailed`),
то есть пользователь, судя по всему, ещё не создан. Пароль передан в чате — после
корректного создания пользователя его стоит ротировать.

## Дальше

1. Владелец создаёт Mongo-пользователя `partner-game-api` с ролями выше; пароль попадает
   сразу в `/etc/padlhub/partner-game-membership/service.env` (не в чат).
2. С отдельного разрешения: pre-check дубликатов и миграция индексов.
3. Обновить `service.env`: `MONGO_URI` (directConnection, `authSource=admin`), `MONGO_DB=games`,
   `LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID`; egress уже сужен до `147.45.254.160/32`.
4. Viva-техклиент и token source, четыре mutation-gate — сейчас `disabled`.
5. **Активация** канареечного клиента — отдельное разрешение; после неё запрос впервые
   пройдёт проверку подписи.

Канареечный keyring уже заполнен: `stationIds=["6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1"]`,
`games={"pay_adff32ae-3cca-425d-a31a-36942a75c8f7": {tenantKey: null, capacity: 4}}`.
Игра проверена: `archived=false`, `status=PAID`, `settings.isPrivate=false`,
`invite.maxPlayers=4`, бронь 2026-09-22 07:00–08:30, `booking.studioId` = station.

## Журнал: креденшелы и ремонт дубликата (2026-09-11)

**Креденшелы.** `partner-game-api` (создан в `admin`) **аутентифицируется**. Роли:
`readWrite` на `PadlhUBScore`, `dialog`, `events`, `games`, `games_chat` — те же широкие
database-level роли, что у боевого Node-RED, а не минимальные collection-level, которые я
рекомендовал. Функционально достаточно, но для нового сервиса стоит сузить до `readWrite`
на `lk_games` и пять `lk_partner_*`. `MONGO_URI` и `MONGO_DB` прописаны в
`/etc/padlhub/partner-game-membership/service.env`; повторно пароль в чат не передавался.

**Ремонт дубликата.** Перед изменением оба документа выгружены целиком в приватный
`duplicate-backup.json` (8 457 байт, содержит PII участников — лежит только в
`/private/tmp/partner-canary-mtls-20260911/` и подлежит удалению после стабилизации).
Проверка 25 game-связанных коллекций не нашла ссылок на удаляемый `_id` или `gameId` вне
`lk_games`. Удалён ровно один документ — `…75eb` (`PAID`, вставка гонки); остался `…75ea`
(`CANCELLED`, поздний апдейт 2026-05-23, 4 участника). Итог: `deletedCount=1`, у игры один
документ, **групп дубликатов `{tenantKey,id}` — 0**. Временные файлы на хосте удалены.

**Блокер B (уточнение): управляемая legacy-миграция сейчас не запускается.** Trust anchor
`scripts/legacy_game_command_production_trust_anchor.json` имеет `status: "UNBOUND"`,
`keyId: "UNBOUND"`, `publicKeySpkiSha256: "UNBOUND"`, а
`assertProductionApprovalTrustAnchorBound()` бросает
`Production approval trust anchor is not bound in source` для любого статуса кроме
`BOUND`. Раннер дополнительно требует execution packet, подписанный approval, backup
manifest, quiescence attestation и runtime compatibility evidence.

Чтобы пойти этим путём, сначала нужно отдельно поднять governance legacy game command:
root-ACL custody (`build_legacy_game_command_root_acl_bootstrap.mjs`,
`legacy_game_command_root_acl_bootstrap.c`), привязать Ed25519 trust anchor (`BOUND`),
собрать пакет и подписать approval. Это самостоятельный процесс, не часть партнёрского
пилота.

Альтернатива для пилота — scoped-исключение: отдельная партнёрская миграция, создающая
`uniq_tenant_game_id` на `lk_games` (дубликатов больше нет) и пять коллекций
`lk_partner_*` с индексами, с явным решением владельца вне legacy-governance. Индексы
additive, откат — drop созданного.

## Журнал: индексы применены scoped-миграцией (2026-09-11)

Владелец выбрал scoped-исключение. Миграция
`scripts/migrate_partner_game_membership_indexes.mjs` (режимы
`audit`/`dry-run`/`apply`/`postcheck`/`rollback-plan`) прогнана на боевой БД `games`:

- перед `apply` dry-run подтвердил `missing: 11`, `conflicts: []`, `duplicates: []`;
- `apply --confirm-apply` создал 11 индексов:

```text
lk_partner_api_nonces:ttl_partner_nonce_expiry                        (TTL)
lk_partner_game_operations:uniq_partner_client_idempotency            (unique)
lk_partner_game_operations:partner_client_correlation
lk_partner_game_memberships:uniq_partner_active_membership            (unique, sparse)
lk_partner_game_memberships:uniq_partner_payment_reference            (unique)
lk_partner_game_memberships:partner_owner_history
lk_partner_api_audit:partner_audit_time_client
lk_partner_api_audit:partner_audit_correlation
lk_partner_game_outbox:uniq_partner_outbox_event                      (unique)
lk_partner_game_outbox:partner_outbox_delivery
lk_games:uniq_tenant_game_id                                          (unique)
```

- `postcheck`: `ok: true`, `missing: 0`, `conflicts: 0`; `rollback-plan` — 11 `dropIndex`.

Миграция только создаёт отсутствующие индексы: ни одного `dropIndex`, ни одной записи в
документы. Она является **пилотным исключением вне legacy-governance** и должна быть
выведена из эксплуатации или заменена управляемым путём, когда trust anchor legacy game
command будет привязан (`status: BOUND`). Уникальность `{tenantKey, id}` на `lk_games`
теперь обеспечена — предусловие `verifyRequiredIndexes()` для активации выполнено.

Откат: `node scripts/migrate_partner_game_membership_indexes.mjs --mode rollback-plan`
даёт точный список; сами `dropIndex` выполняются вручную после отдельного решения.

## Журнал: проверка после миграции (2026-09-11)

Сквозной путь подтверждён **с резервного хоста `89.108.64.209`** (он стабильно в
allowlist): `POST` на валидный маршрут вернул `503 PARTNER_API_DISABLED`, как и должно
быть при выключенном API. `padlhub.su` `302`, `score.padlhub.su` `410` — без изменений.

Отдельно зафиксировано операционное неудобство: IP этой рабочей машины **ротируется**
(наблюдались `194.71.130.27` и `109.173.114.67`), поэтому пробы прямо с неё дают `403` от
`deny all`, когда адрес не совпал с allowlist. Для повторяемых канареечных проб
используйте резервный хост, а не рабочую машину.

Канареечные клиентские `client.pem`/`client.key` временно размещены на резервном хосте
(`/tmp/partner-canary-client.*`, `0600`) для этих проб. Это **временный** материал: перед
активацией его нужно удалить либо заменить сертификатом партнёра, иначе приватный ключ
канарейки остаётся на чужом хосте.

## Журнал: release v02-20260912 и Viva-креды (2026-09-12)

По решению владельца лимит `expires_in` ослаблен в коде до
`PARTNER_VIVA_TOKEN_MAX_TTL_SECONDS = 604800` (правка custom node, коммит `1e0bc57`), после
чего runtime evidence перевыпущен и packet пересобран.

- Свежий live-pull: `e5d64351…`, 4799 узлов. `candidateSha256` не изменился
  (`5a5aefe3…`) — sidecar-кандидат строится из синтетического однотабового preimage и от
  живого flow не зависит; живой flow нужен только как collision-evidence.
- Установлен release `v02-20260912`: 38 файлов, `npm ci` → 291 пакет, Node-RED `5.0.6`,
  симлинк custom node на месте, `current` переключён.
- Новый anchor: `packetManifestSha256=7680eed9…`, `approvedCommit=1e0bc57…`,
  `approvedTree=d4413ab3…`, release-каталог `v02-20260912`.
- В `service.env` добавлены Viva-переменные: `VIVA_TOKEN_SOURCE=password-grant`,
  `VIVA_SERVICE_CLIENT_ID=React-auth-dev`, сервисный аккаунт `test_match_point@padlhub.ru`
  и технический клиент `a46217b4-d1c0-4363-a848-a9b05d8aa648`.
- Egress расширен: `147.45.254.160/32` (Mongo) + `91.219.191.8/32` (api и kc Viva) +
  localhost.
- Сервис `active`, listener только `127.0.0.1:18894`.

Проверка **боевого резолвера из установленного кода**: модуль сообщает
`max ttl: 604800`, реальный password grant прошёл (`RESOLVER OK token_len=3289`). То есть
ослабленный лимит действует именно в том коде, который развёрнут.

API при этом остаётся **выключенным**: запрос через ingress с резервного хоста
(`89.108.64.209`) по-прежнему получает `503 PARTNER_API_DISABLED`; `padlhub.su` `302`,
`score.padlhub.su` `410` — без изменений. Временные файлы на хосте удалены; пароль Viva
хранится только в `service.env` (`0640 root:partner-game-api`).

Остаётся активация (`ENABLED=true`, `PROVIDER_MODE=viva`, четыре provider-gate) и затем
выдача доступа партнёру — отдельные разрешения.

## Журнал: активация канареечного клиента (2026-09-12)

Активация выполнена по разрешению владельца. Сначала код `BOUND_ACTIVE`
(коммит `6a87f5a`), затем пакет v03 из свежего live-pull (`f6c6c9e2…`, 4799 узлов;
манифест `5e527cba…`, commit `9d809f8c`, tree `1a0af7f6`, `candidateSha256` прежний
`5a5aefe3…`), релиз `v03-20260912` (37 файлов сверено по байтам, `npm ci` → 291 пакет,
Node-RED `5.0.6`, Node `22.23.2`), ACTIVE-анкор (`activationAuthorized:true`,
`padlhub-canary`, игра `pay_adff32ae-…`) и drop-in `zz-activation.conf` с семью гейтами.
Эффективное окружение проверено **до** переключения `current`.

Результат: гвард принял `BOUND_ACTIVE`, слушатель только `127.0.0.1:18894`. С резервного
хоста через общий 443 подписанный `GET` вернул **404 `OPERATION_NOT_FOUND`** вместо
`503` — то есть ingress, mTLS, HMAC v2, маршрут, allowlist и аудит работают. Подписанный
`POST` на тестовую игру вернул `202` и **создал корректную бронь** `6af8c23f`:
`client=a46217b4` (технический), `paymentType=ON_PLACE`, `isCancelled=false`.

**Найденный блокер.** Операция осталась `UNKNOWN` с `VIVA_READBACK_BINDING_MISMATCH`.
Живая строка списка броней не содержит ни `exerciseId`, ни `exercise`, ни `service`, а
`readBooking` требовал один из них; флаги отмены в проде — `isCancelled` и
`cancellationDate`, тогда как `bookingIsActive` знал только
`active`/`cancelled`/`canceled`/`status`/`state`. Итог: ни одну мутацию нельзя
подтвердить, компенсации нет, бронь осталась активной, игра в ЦУП не обновлена
(`participants` без изменений), membership `65bce39c` и операция `d3230cf5` — `UNKNOWN`.
Тесты кодировали предполагаемую форму payload и с живым API не сверялись.

Фикс в коммите `aaca892`: привязка упражнения берётся из scope запроса (путь адресует
коллекцию одного упражнения), отсутствующий alias подтверждает запрошенное упражнение,
присутствующий но другой — по-прежнему фатален, `client` обязателен, а `paymentType`
(если есть) обязан быть `ON_PLACE`. Живая страница сохранена как фикстура
`scripts/tests/fixtures/partner-viva-bookings-list.live-20260912.json`.

Остаётся: перевыпуск runtime evidence и пакета под изменённый custom node, установка
релиза, повторная активация, живая проверка ADD и удаление осиротевшей брони `6af8c23f`
через исправленный `DELETE`.

## Журнал: повторная активация с фиксом (2026-09-12)

Пакет v04 собран из свежего live-pull (тот же `f6c6c9e2…`, 4799 узлов; манифест
`0ac4f3f2…`, commit `72e0be1`, tree `3c7ce69a`), `customNodeReleaseSha256` теперь
`15361530…`. Релиз `v04-20260912`: 37/37 файлов сверено, aggregate совпал, `npm ci` →
291 пакет, установленный `partner-game-membership-viva.mjs` = `d9434ce0…`. Новый
ACTIVE-анкор привязан к v04, `current` переключён, сервис поднялся.

Живой прогон через общий 443 с резервного хоста:

| Шаг | Результат |
| --- | --- |
| Подписанный `GET` операции | `404 OPERATION_NOT_FOUND` (API обслуживает) |
| Подписанный `POST` (новый игрок) | **`201`**, membership `57ff95f1`, `state ACTIVE`, операция `cec1cb2c` `COMPLETED` |
| Бронь в Viva | `c2b01878`, `client=a46217b4`, `paymentType=ON_PLACE` — read-back прошёл |
| Подписанный `DELETE` | **`200`**, membership `state REMOVED`, операция `c0506990` `COMPLETED` |
| Бронь после `DELETE` | `isCancelled=true`, `cancellationDate=2026-09-12T06:31:26` |

Побочный факт: вторая бронь на того же технического клиента и то же упражнение принята
Viva, то есть несколько участников одной игры не конфликтуют на стороне провайдера.

Отдельно подтверждена вторая половина продуктового обещания — ростер в ЦУП. Пока
membership активен, в документе игры появляется участник
`id="partner:<membershipId>"`, `source="PARTNER_API"`, `status="CONFIRMED"` с
`vivaBookingId`; после `DELETE` он исчезает, и в `participants` остаётся только исходный
организатор. Проверялось на третьем цикле (`d8680112-64da-4975-9d70-135f78eef986`,
booking `784c89c6-5f58-438e-a2a3-11da6183b4b6`).

Осиротевшая бронь `6af8c23f` от прогона до фикса отменена отдельным операторским
действием тем же контрактом (`GET …/cancel` probe → `PUT {refundMethod:"NONE",
cancelExercise:false}`); запись membership `65bce39c` осталась в `UNKNOWN` без `bookingId`
как след дефекта и не переписывалась. Игра в ЦУП не загрязнена: `participants` содержит
только исходного организатора, оба партнёрских membership доведены до `REMOVED`.

Итог по состояниям: операций 3 (`UNKNOWN` — только до-фиксовый прогон, два `COMPLETED`),
membership 2 (`UNKNOWN` и `REMOVED`), audit 14, nonces 8. Публичные хосты без изменений
(`padlhub.su` `302`, `score.padlhub.su` `410`, `kozlovatv.ru` `200`).

Остаётся: выдача доступа партнёру (отдельное разрешение), сужение ролей Mongo для
`partner-game-api`, удаление канареечного приватного ключа с резервного хоста и
англоязычная версия гайда. Уникальность `activeKey` для `canary-player-20260912-01`
занята записью `UNKNOWN` — реальные идентификаторы партнёра с ней не пересекаются.
