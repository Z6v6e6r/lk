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

## Дальше

Порядок перед активацией:

1. **Mongo.** На хосте нет локального Mongo (нет listener и unit), а unit разрешает
   egress только на localhost. Нужны Mongo replica-set с индексами и расширение сетевой
   политики unit — это отдельное изменение стадии активации.
2. **Игра и станция.** Заполнить `stationIds` и `games[{gameId: {tenantKey, capacity}}]`
   канареечного клиента выбранной тестовой игрой (capacity строго `2` или `4`).
3. **Viva-техклиент** и token source, четыре mutation-gate — по-прежнему `disabled`.
4. **Активация** канареечного клиента — отдельное разрешение; после неё запрос впервые
   пройдёт проверку подписи.
