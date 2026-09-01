# Тестовый Partner Game Membership API

Статус документа: **deployable pilot v0.2, default-off, live gates UNBOUND**. Контур,
строгий Viva adapter и генератор приватного deployment packet реализованы локально,
но маршрут не импортирован в Node-RED, реальные вызовы Viva не выполнялись, ключи не
создавались, Mongo/shared ingress/production не менялись. Наличие deployable artifacts
не является разрешением на deploy или activation.

## 1. Назначение и жёсткие границы

API позволяет доверенному M2M-клиенту:

1. добавить одного внешнего игрока в открытую игру;
2. создать в Viva запись строго на серверного технического клиента;
3. сохранить в PadlHub локальную проекцию оплаты как `PAID` с источником
   `EXTERNAL_PARTNER`;
4. удалить только тот membership, который ранее создал тот же integration client;
5. прочитать состояние своей операции.

API **не позволяет** передать `source`, `paid`, Viva client/booking ID, произвольный
PadlHub user ID, телефон или массив участников. Игрок из LK, Viva, админки либо другого
integration client не имеет canonical ownership-записи этого клиента, поэтому его
удаление завершается `MEMBERSHIP_NOT_OWNED` до вызова Viva.

`PAID` означает только подтверждение внешнего расчёта доверенным партнёром. Это не
подтверждение банковской транзакции PadlHub, не фискальный чек и не Viva payment.

## 2. Маршруты

| Метод | Путь | Scope | Результат |
| --- | --- | --- | --- |
| `POST` | `/lk/integrations/v1/open-games/{gameId}/members` | `members:add` | Добавить оплаченного внешнего игрока |
| `DELETE` | `/lk/integrations/v1/open-games/{gameId}/members/{membershipId}` | `members:remove` | Удалить только собственный membership |
| `GET` | `/lk/integrations/v1/operations/{operationId}` | `operations:read` | Прочитать только собственную операцию |

Query string и fragment запрещены. Namespace отделён от общего `/lk/games` и не
использует широкий `PATCH`.

### POST body

```json
{
  "externalPlayerId": "stable-id-from-partner",
  "displayName": "Тестовый игрок",
  "payment": {
    "reference": "unique-payment-reference",
    "paidAt": "2026-09-01T08:59:00.000Z",
    "amountMinor": 250000,
    "currency": "RUB"
  }
}
```

Схема закрытая: неизвестное поле даёт `UNKNOWN_REQUEST_FIELD`. Денежная сумма —
безопасное целое число в минимальных единицах валюты. `paidAt` — канонический UTC ISO
timestamp с миллисекундами. `externalPlayerId` должен быть стабилен и не переиспользоваться
для другого человека. `payment.reference` в v0.2 одноразовый в рамках integration client:
одна внешняя платёжная ссылка не может пометить оплаченными два membership.

### Успешный POST response

```json
{
  "operationId": "<uuid>",
  "membership": {
    "membershipId": "<uuid>",
    "gameId": "<game-id>",
    "externalPlayerId": "stable-id-from-partner",
    "state": "ACTIVE",
    "paymentStatus": "PAID",
    "settlementSource": "EXTERNAL_PARTNER"
  }
}
```

`201` — первая успешная обработка. `200` — легальный idempotent retry уже завершённой
операции. `202` означает `UNKNOWN`/незавершённое состояние и требует чтения operation,
а не слепого повтора Viva.

`DELETE` отправляется с пустым JSON body `{}`. В body нельзя передавать идентификатор
игрока или Viva: единственный объект удаления задаётся `membershipId` из успешного POST.

## 3. Защита от перехвата и повторения

TLS обязателен, но сам TLS не является прикладной защитой от утечки запроса после
терминации. Каждый запрос дополнительно содержит:

| Header | Требование |
| --- | --- |
| `X-PadlHub-Client-Id` | Выданный M2M client ID |
| `X-PadlHub-Key-Id` | Версия ключа для ротации |
| `X-PadlHub-Timestamp` | Unix seconds, окно по умолчанию ±90 секунд |
| `X-PadlHub-Nonce` | Новый криптографически случайный base64url, 22–128 символов |
| `X-PadlHub-Signature` | `v1=<base64url HMAC-SHA256>` |
| `Idempotency-Key` | Новый lowercase UUID для новой бизнес-команды |
| `X-Correlation-ID` | Новый lowercase UUID для трассировки попытки |

Каноническая строка:

```text
PADLHUB-PARTNER-GAME-V1
<client-id>
<key-id>
<unix-seconds>
<nonce>
<UPPERCASE-METHOD>
<exact-path-without-query>
<sha256(canonical-json-body)>
<idempotency-key>
<correlation-id>
```

Подпись: `base64url(HMAC-SHA256(secret, canonical-string))`. Секрет минимум 32 байта,
передаётся партнёру вне API и никогда не включается в request/flow/repository.
Сравнение подписи выполняется constant-time.

После проверки подписи сервер атомарно вставляет nonce в `lk_partner_api_nonces`.
Повтор того же перехваченного запроса получает `409 REQUEST_REPLAY_DETECTED` и не
доходит до game/Viva. Timestamp ограничивает срок полезности утечки. Изменение метода,
пути, body, idempotency или correlation ломает HMAC.

Это защищает от **повторения** перехваченного запроса. Защита от real-time relay, когда
злоумышленник успевает переслать оригинал раньше легитимного клиента, требует сетевого
слоя: mTLS предпочтителен; минимум — TLS 1.2+, ingress IP allowlist, корректная работа
за trusted proxy и rate limit. Эти настройки являются gate ограниченного пилота.

### Публичный golden vector

Ключ ниже намеренно публичный и допустим **только для contract test**:
`public-test-vector-key-32-bytes!!`.

```text
clientId: partner-test
keyId: key-2026-09
timestamp: 1788253200
nonce: MDEyMzQ1Njc4OWFiY2RlZjAxMjM0
method: POST
path: /lk/integrations/v1/open-games/game-001/members
bodySha256: 38e85283a47d9c00aab3a4dbda49757cbd3f031c32f524376420e245d9ca6d66
idempotency: 11111111-1111-4111-8111-111111111111
correlation: 22222222-2222-4222-8222-222222222222
signature: v1=4KBpuvfSZVlFUjufjfL3fNYcxENPjQ1bBIE0WnFrE6A
```

Body vector: `externalPlayerId=player-001`, `displayName=Test Player`, payment
`reference=pay-001`, `paidAt=2026-09-01T08:59:00.000Z`, `amountMinor=250000`,
`currency=RUB`. Любое отличие должно менять signature.

### Replay и idempotency — разные механизмы

- повторить старый HTTP request нельзя: nonce уже использован;
- после сетевого обрыва партнёр создаёт **новые** timestamp, nonce, correlation и HMAC,
  но сохраняет прежний `Idempotency-Key` и тот же бизнес body;
- сервер возвращает сохранённый результат без второго вызова Viva;
- тот же `Idempotency-Key` с другим method/path/body даёт `IDEMPOTENCY_CONFLICT`.

## 4. Авторизация и ограничение доступа

Server-only keyring задаёт для каждого клиента:

```json
{
  "partner-test": {
    "enabled": true,
    "scopes": ["members:add", "members:remove", "operations:read"],
    "stationIds": ["<allowed-station-id>"],
    "keys": {
      "key-2026-09": "<base64url-secret-from-secret-store>"
    }
  }
}
```

Это пример структуры, не готовая конфигурация. Значения хранятся в secret manager/env,
не в Git и не в Node-RED flow. Ограничения применяются вместе:

- глобальный kill switch `LK_PARTNER_GAME_API_ENABLED` должен быть ровно `true`;
- client и key должны быть включены;
- для маршрута нужен отдельный scope;
- station игры должна входить в `stationIds` как при POST, так и при DELETE; DELETE
  повторно сверяет текущий allowlist с `stationId` canonical membership внутри Mongo
  transaction до любого provider-вызова;
- POST принимает только неархивную игру с непротиворечивой public/private видимостью,
  известным joinable status (`PAID`, `PAYMENT_PENDING` или поддерживаемый legacy open
  status) и каноническим `booking.endTs`, либо `booking.startTs`, не ранее server time;
- Mongo prerequisites должны совпасть без ослабленных индексов;
- mode `viva` содержит real adapter, но mutation fail-closed, пока независимо не
  подтверждены все server-only gate из следующего раздела;
- synthetic provider разрешён только для `local|test|dev`, loopback Mongo и имени БД с
  `local|test|dev`.

Ротация без разрыва: добавить новый `keyId`, перевести клиента, отключить старый key,
затем удалить его после максимального окна request и согласованного grace period.

### 4.1. Отдельные gate реального Viva adapter

Одного общего `enabled=true` недостаточно. До любой operation/reservation adapter
проверяет token и все значения ниже; любое несовпадение создаёт durable rejected ingress
audit и возвращает `503`, не создавая operation, membership или Viva request.

| Переменная | Единственное активирующее значение | Назначение |
| --- | --- | --- |
| `LK_PARTNER_GAME_API_PROVIDER_MODE` | `viva` | Выбрать real adapter вместо `disabled`/isolated `synthetic` |
| `LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED` | `true` | Отдельный mutation kill switch |
| `LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION` | `padlhub-viva-technical-booking-v1` | Привязать runtime к reviewed contract |
| `LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED` | `true` | Подтвердить письменный ответ Viva об `Idempotency-Key` |
| `LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED` | `true` | Подтвердить отсутствие нежелательных payment-side effects |

Bearer берётся только из server-side Node-RED global context
`vivacrm_access_token` и принимается лишь когда `vivacrm_token_expires_at` остаётся
больше чем на 30 секунд вперед. Caller не может передать token, Viva client ID, booking ID,
`paymentType` или API base. Base pinned к `https://api.vivacrm.ru/api/v1`; redirect
запрещён, timeout ограничен 1–30 секундами, mutation не повторяется автоматически.

Текущий provider contract основан на существующих repository integrations и остаётся
**provisional до письменного подтверждения Viva**:

| Действие | Pinned request | Обязательный ответ/read-back |
| --- | --- | --- |
| Add | `POST /exercises/{exerciseId}/bookings`, server body `clientId`, `paymentType=ON_PLACE`, empty `familyMemberId/customFields` | Один exact `bookingId`; если response содержит binding, он обязан совпасть с exercise/client |
| Read | `GET /exercises/{exerciseId}/bookings?showCancelled=true&page=0&size=200` | Ровно одна exact-bound запись; отсутствие принимается только при доказанно последней/полной странице, иначе `UNKNOWN` |
| Remove probe | `GET /clients/{clientId}/bookings/{bookingId}/cancel` | Явное `cancellationOptions.cancellationOnly.available=true` |
| Remove | `PUT` того же path, body `refundMethod=NONE`, `cancelExercise=false` | Затем read-back обязан показать booking неактивным/отсутствующим |

`Idempotency-Key` и `X-Correlation-ID` пересылаются в Viva. Однако само наличие header
не доказывает server-side idempotency: до ответа Viva gate обязан оставаться `false`.
Network error, timeout, `5xx`, слишком большой/невалидный mutation response или binding
mismatch дают `202 UNKNOWN`; blind retry и автоматическая компенсация запрещены.

## 5. Владение и удаление

Авторитетная запись `lk_partner_game_memberships` содержит:

```text
membershipId + clientId + gameId + externalPlayerId + generation
exerciseId + technicalVivaClientId + bookingId + state + operationId
```

Источник в массиве `game.participants` — только проекция, а не разрешение на удаление.
Перед Viva DELETE транзакция требует точного совпадения `membershipId`, `clientId`,
`gameId`, состояния `ACTIVE`, текущего разрешения на сохранённый `stationId` и полной
Viva binding. При любом несовпадении provider не вызывается, а pre-authorization failure
не меняет состояние даже угаданного чужого membership. После подтверждённого Viva
read-back локальный `$pull` использует только `membershipId`; телефон, имя и
caller-supplied Viva ID не участвуют.

## 6. Состояния и неоднозначные результаты

```text
ADD:    provider READY -> RECEIVED -> SLOT_RESERVED -> Viva add -> exact read-back -> COMPLETED
REMOVE: provider READY -> RECEIVED -> VIVA_PENDING  -> Viva remove -> exact read-back -> COMPLETED
                           \-> UNKNOWN (timeout/ambiguous ACK/read-back mismatch)
                           \-> FAILED  (definite pre-mutation failure)
```

После подтверждения Viva, но ошибки локального commit, операция становится `UNKNOWN`.
Система не создаёт и не отменяет Viva booking вслепую. Нужна reconciliation-процедура,
которая читает exact `exerciseId + bookingId + technicalVivaClientId`, затем принимает
одно из решений: завершить локальный commit, подтвердить отсутствие, либо передать
оператору.

## 7. Mongo и атомарность

| Collection | Назначение | Главный fence |
| --- | --- | --- |
| `lk_partner_api_nonces` | anti-replay ledger | уникальный `_id`, TTL только после истечения request window |
| `lk_partner_game_operations` | idempotency и state machine | unique `(clientId, idempotencyKey)` |
| `lk_partner_game_memberships` | canonical ownership и payment claim | unique sparse `activeKey`; unique `(clientId, payment.reference)` |
| `lk_partner_api_audit` | ingress и operation audit | correlation/time indexes |
| `lk_partner_game_outbox` | атомарный event intent | unique `(operationId, eventType)` |
| `lk_games` | roster/payment projection | Mongo transaction + reservation revision |

Membership, game projection, operation, audit и outbox завершаются в одной Mongo
transaction с `snapshot`/`majority`. Provider и Mongo не образуют общей транзакции,
поэтому между ними используется state machine, exact read-back и `UNKNOWN` fence.

## 8. Логирование и приватность

Каждая попытка создаёт ingress event. После авторизации отсутствие durable ingress audit
останавливает mutation. Operation transitions пишутся в той же транзакции, что и
локальная бизнес-операция. Node-RED пишет минимальный fallback event с code, correlation
и новым trace ID.

Никогда не логируются signature, HMAC secret, raw nonce, raw IP, целый body, displayName
или payment reference. Nonce, IP и body представлены HMAC-fingerprint отдельным audit
key. Доступ к audit collection нужен отдельной read-only роли; retention и экспорт в
SIEM согласуются до пилота.

Минимальные алерты:

- всплеск `INVALID_SIGNATURE`, `REQUEST_REPLAY_DETECTED`, `SCOPE_DENIED`;
- любой `UNKNOWN` старше reconciliation SLO;
- `AUDIT_UNAVAILABLE`, `MONGO_PREREQUISITES_MISSING`;
- рост `GAME_FULL_AFTER_PROVIDER`/локальных CAS конфликтов;
- попытка synthetic mode вне изолированного окружения.

## 9. Изолированная проверка

```bash
npm run test:partner-game-membership-api
```

Тесты не обращаются в Viva и production Mongo. Они проверяют happy path, PAID projection,
replay, tamper, expired timestamp, idempotent retry, idempotency conflict, scopes,
station allowlist на POST и DELETE, archived/ended/private/conflicting/missing-lifecycle
game states, запрет удаления LK/Viva/другого клиента, отсутствие mutation при
pre-authorization failure, `UNKNOWN`, audit redaction, closed schema, default-off
provider readiness до operation, точные Viva path/body/headers/read-back/cancel gates,
отсутствие mutation retry, additions-only exact-graph contract, Mongo rehearsal guard и
приватный v0.2 deployment packet.

## 10. Подготовка deployment packet

Только после свежей read-only выгрузки `LK Games`:

```bash
npm run nodered:modular:audit-147 -- /absolute/external/workspace --source-tab-label "LK Games"
npm run nodered:partner-game-membership:v02-packet -- \
  --workspace /absolute/external/workspace \
  --out /absolute/new-private-partner-v02-packet
```

Генератор принимает только свежий приватный workspace с доказанным origin
`lk-primary-147:/root/.node-red/flows.json`, чистый exact task-branch commit и новый
output вне repository. Он создаёт файлы с mode `0600` внутри directory `0700`:

- `candidate.flow.json` — свежий flow плюс ровно семь pinned nodes;
- `reviewed-flow.contract.json` — source/candidate SHA и hash каждого addition;
- `custom-node/` + `custom-node.release.json` — exact source/package-lock bytes/hashes;
- `deployment-plan.json` — `liveMutationAuthorized=false`,
  `deploymentPerformed=false`, `activationPerformed=false` и список незакрытых gates.

Nested package pins MongoDB `7.2.0`, включает свой lockfile в release identity и должен
устанавливаться через `npm ci --ignore-scripts`; фактическая Node/npm/Linux совместимость
и offline/immutable dependency closure всё равно репетируются до deploy.

Расширенный reviewed-flow contract разрешает additions-only deploy, включая новые
`http in`, только когда каждый ID и полный node hash явно pinned. Все существующие
routes/nodes обязаны остаться неизменными. Сам packet ничего не импортирует, не
устанавливает и не активирует.

### Изолированная Mongo replica rehearsal

После отдельного разрешения и только на disposable replica-set:

```bash
LK_PARTNER_GAME_API_MONGO_URI='mongodb://127.0.0.1:27018/?replicaSet=partner-test' \
LK_PARTNER_GAME_API_MONGO_DB='lk_partner_rehearsal_<unique>' \
npm run mongo:partner-game-membership:rehearse -- \
  --ack-disposable-db 'lk_partner_rehearsal_<unique>'
```

Guard отклоняет non-loopback seed/advertised replica member, отсутствие exact
`replicaSet`, `directConnection=true`, любое имя вне `lk_partner_rehearsal_*`,
неожиданную collection/non-empty DB и несовпадающее acknowledgement. Rehearsal создаёт только
индексы в disposable DB, проверяет exact specs, выполняет transaction sentinel и abort,
затем доказывает отсутствие sentinel. Это не production migration и не разрешение на
production Mongo.

## 11. Rollback/disable

Первое действие при инциденте — выключить client или глобальный kill switch на ingress,
не удаляя ledgers. Не удалять `operations`, `memberships`, `nonces`, `audit`, `outbox` и
не уменьшать game revision: они нужны для расследования и reconciliation. Route/node
можно убрать только после остановки входящего трафика и сверки всех `UNKNOWN`/
`VIVA_PENDING` операций. Автоматическая обратная provider mutation запрещена.

См. также:

- [Threat model](./PARTNER_GAME_MEMBERSHIP_THREAT_MODEL.md)
- [Вопросы внешней команде](./PARTNER_GAME_MEMBERSHIP_EXTERNAL_TEAM_QUESTIONS.md)
- [План и матрица тестирования](./PARTNER_GAME_MEMBERSHIP_TEST_PLAN.md)
- [Редактируемая инфографика безопасности](./assets/partner-game-membership-security.drawio)
