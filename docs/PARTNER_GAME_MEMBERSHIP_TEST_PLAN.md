# План тестирования Partner Game Membership API

## Уровни доказательств

| Уровень | Что доказывает | Что не доказывает |
| --- | --- | --- |
| Pure unit | Канонизация, HMAC, timestamp, schema, route parsing | Mongo atomicity, Node-RED, Viva |
| Service + in-memory repository | State machine, ownership, idempotency, synthetic provider | Реальная replica transaction и provider contract |
| Source-only flow fixture | Отдельные routes, default-off config, exact-source builder | Совместимость с актуальным live flow |
| Mongo replica integration | unique/TTL/index options, write conflict, transaction/outbox | Viva и ingress |
| Local Node-RED + loopback Mongo | HTTP headers, params, response, restart | Shared/prod topology |
| Viva sandbox | Реальный add/read/remove технического клиента | Production payment/notification effects |
| Limited pilot | Ingress/mTLS/rate limit/observability/reconciliation | Масштабная нагрузка |

Ни один уровень не подменяет следующий. Локальные green tests не разрешают import,
secret change, migration, deploy, activation или real provider mutation.

## Автоматизированная матрица v0.1

| Категория | Сценарий | Ожидание |
| --- | --- | --- |
| Happy path | Подписанный POST в открытую игру | `201`, membership `ACTIVE`, payment `PAID/EXTERNAL_PARTNER` |
| Replay | Тот же request второй раз | `409 REQUEST_REPLAY_DETECTED`, Viva calls остаются 1 |
| Tamper | Изменить method/path/body после подписи | `401 INVALID_SIGNATURE`, Viva calls 0 |
| Freshness | Timestamp за пределами 90 секунд | `401 REQUEST_EXPIRED`, nonce не расходуется |
| Retry | Новый nonce/signature, тот же idempotency/body | Сохранённый response, Viva calls остаются 1 |
| Concurrent retry | Два запроса одновременно с одним idempotency | Только создатель operation вызывает Viva; дубль получает `202` |
| Conflict | Тот же idempotency, другой body | `409 IDEMPOTENCY_CONFLICT` |
| Payment claim | Один payment reference для двух игроков | `409 PAYMENT_REFERENCE_ALREADY_CLAIMED`, Viva calls остаются 1 |
| ACL | Нет scope add/remove/read | `403 SCOPE_DENIED` |
| Tenant | Игра другой station | `403 STATION_ACCESS_DENIED` |
| Ownership | DELETE чужого/LK/Viva membership | `403 MEMBERSHIP_NOT_OWNED`, Viva calls 0 |
| Provider ambiguity | Timeout/неверный read-back | `202 UNKNOWN`, автоматического повтора нет |
| Lost ACK/local commit | Provider мог изменить state либо Mongo commit не подтверждён | `202 UNKNOWN`, reservation сохраняется |
| Schema | Caller передаёт `paid/source/vivaBookingId/clientId` | `400 UNKNOWN_REQUEST_FIELD` |
| Privacy | Audit после request | Нет raw nonce/IP/body/name/payment ref |
| Runtime gate | Real provider в v0.1 | `503 VIVA_RUNTIME_NOT_CONFIGURED` |
| Synthetic isolation | Не-loopback или production env/DB | Synthetic provider запрещён |
| Flow provenance | Неверный live SHA/in-place/collision | Candidate builder падает |

Команда:

```bash
npm run test:partner-game-membership-api
```

## Обязательные дополнительные тесты до shared sandbox

1. Mongo replica set:
   - два конкурентных add на последнее место;
   - duplicate nonce под нагрузкой;
   - duplicate idempotency с одинаковым и разным request hash;
   - transaction transient retry без duplicate audit/outbox;
   - commit result unknown и majority read-back;
   - ослабленные `unique/sparse/TTL` indexes отклоняются.
2. Local Node-RED:
   - route params и exact path за reverse proxy;
   - body size/content-type limits;
   - restart между provider ACK и local commit;
   - audit DB outage до provider call;
   - enabled/key/scopes/station revoke без restart либо с документированным reload.
3. Viva sandbox после ответов P0:
   - technical user add + exact booking read-back;
   - повтор provider create с одним operation ID;
   - delete exact booking, already absent, exercise closed;
   - timeout до/после provider commit;
   - подтверждение отсутствия чеков, debt, notifications, subscription debit и rating.
4. Ingress:
   - mTLS/allowlist positive and negative;
   - rate limit по client/IP;
   - header/body size, malformed encoding, duplicate headers;
   - trusted proxy и source IP hashing;
   - TLS policy scan.

## Exit criteria ограниченного пилота

- все P0 вопросы закрыты и подписаны владельцами;
- fresh `LK Games` snapshot и source SHA зафиксированы;
- custom node package и candidate hashes воспроизводимы;
- Mongo replica tests green, backup/rollback/reconciliation rehearsed;
- Viva sandbox matrix green с exact before/after evidence;
- mTLS либо утверждённый IP allowlist включён;
- dashboards/alerts видят replay, auth failures, provider errors и `UNKNOWN` age;
- kill switch, client revoke и key rotation отрепетированы;
- ни одного production user/payment/booking в тестовых доказательствах.
