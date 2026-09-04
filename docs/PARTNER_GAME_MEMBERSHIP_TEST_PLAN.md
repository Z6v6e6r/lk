# План тестирования Partner Game Membership API

## Уровни доказательств

| Уровень | Что доказывает | Что не доказывает |
| --- | --- | --- |
| Pure unit | Канонизация, HMAC, timestamp, schema, route parsing | Mongo atomicity, Node-RED, Viva |
| Service + in-memory repository | State machine, ownership, idempotency, synthetic provider | Реальная replica transaction и provider contract |
| Flow/packet fixture | Отдельные routes, default-off config, exact source/candidate/added-node/package hashes | Что source ещё совпадает с production в момент deploy |
| Mongo replica integration | unique/TTL/index options, write conflict, transaction/outbox | Viva и ingress |
| Local Node-RED + loopback Mongo | HTTP headers, params, response, restart | Shared/prod topology |
| Viva sandbox | Реальный add/read/remove технического клиента | Production payment/notification effects |
| Limited pilot | Ingress/mTLS/rate limit/observability/reconciliation | Масштабная нагрузка |

Ни один уровень не подменяет следующий. Локальные green tests не разрешают import,
secret change, migration, deploy, activation или real provider mutation.

## Автоматизированная матрица v0.2

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
| Tenant revoke | Station удалена из allowlist после POST, затем DELETE | `403 STATION_ACCESS_DENIED`, Viva calls 0, membership остаётся `ACTIVE` |
| Open-game state | Игра archived/ended/private либо visibility fields конфликтуют | `409 GAME_NOT_OPEN`, Viva calls 0 |
| Open-game lifecycle | Нет status или канонического `booking.endTs/startTs` | `409 GAME_NOT_OPEN/GAME_SCHEDULE_UNKNOWN`, Viva calls 0 |
| Compatibility | Реальная форма `PAID`/`PAYMENT_PENDING`, public, future end | POST остаётся разрешённым |
| Ownership | DELETE чужого/LK/Viva membership | `403 MEMBERSHIP_NOT_OWNED`, Viva calls 0 |
| Persisted Viva binding | После POST runtime technical client изменён, затем DELETE | Cancel/read-back получают сохранённый client ID; новый runtime ID не используется |
| Failed DELETE isolation | Pre-authorization failure с существующим чужим membershipId | Меняется только operation/audit; membership и roster не меняются |
| Provider ambiguity | Timeout/неверный read-back | `202 UNKNOWN`, автоматического повтора нет |
| Lost ACK/local commit | Provider мог изменить state либо Mongo commit не подтверждён | `202 UNKNOWN`, reservation сохраняется |
| Schema | Caller передаёт `paid/source/vivaBookingId/clientId` | `400 UNKNOWN_REQUEST_FIELD` |
| Privacy | Audit после request | Нет raw nonce/IP/body/name/payment ref |
| Runtime readiness | Любой Viva gate/token отсутствует | `503` до operation/membership/provider call + durable rejected audit |
| Viva create contract | Готовый adapter получает add | Один POST, pinned base/path/body, auth/idempotency/correlation headers |
| Viva ambiguity | Network/timeout/5xx/invalid binding | `202 UNKNOWN`, ровно один mutation call, без retry |
| Viva removal | Cancel probe не подтверждает cancellation-only | PUT не вызывается; definite contract mismatch |
| Viva read-back | Duplicate/противоречивые identity, state или collection aliases | `VIVA_READBACK_AMBIGUOUS`, local completion запрещён |
| Synthetic isolation | Не-loopback или production env/DB | Synthetic provider запрещён |
| Flow provenance | Неверный live SHA/in-place/collision | Candidate builder падает |
| Additions-only deploy | Новый pinned HTTP route/package bytes | Contract pins все seven nodes; live prefix/order неизменен; additions только suffix |
| Private packet | Fresh external workspace + exact repository identity | read-once validated runtime bytes, source/candidate contract, semantic cross-links, sibling temp + fsync + final manifest + atomic rename; injected failure не оставляет partial packet |
| Production controls | Route/upstream/CORS/admin/limits/custody/runtime/activation mutation | Любое widening или binding в source template отклоняется |
| Runtime compatibility | Node `22.23.2` + Node-RED `4.1.14` + exact custom package | exact custom-node load/default-off/removal: `503/404`; не доказывает следующий fresh flow candidate; production calls `0` |
| Runtime audit | Exact Node-RED `4.1.14` production closure | `0 critical / 15 high / 9 moderate / 1 low`; gate остаётся `AUDIT_BLOCKED` |
| Private binding declaration | controls/runtime/functional/ingress/custody/packet semantics/identity mutation | packet/host custody проверяется фактически; ingress/readback/audit decision остаются `DECLARED_EVIDENCE_UNVERIFIED`, authorization всегда false |
| Mongo rehearsal guard | Non-loopback/shared name/mixed-case direct connection/duplicate topology option/bad ack | Отказ до Mongo import/connect |

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
   - выполнить `mongo:partner-game-membership:rehearse` только для exact
     `lk_partner_rehearsal_*`; сохранить replica/index/abort/no-sentinel evidence.
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
   - provider-side duplicate request с одинаковым `Idempotency-Key` возвращает тот же
     booking identity либо документированный безопасный эквивалент без второго booking.
4. Ingress:
   - обязательный mTLS + дополнительный allowlist positive and negative;
   - wrong audience/Host/SNI, shared hostname и direct Node-RED дают отказ;
   - входные `Forwarded`/`X-Forwarded-*` стираются; source строится из socket peer;
   - rate limit по client/IP;
   - header/body size, malformed encoding, duplicate headers;
   - trusted proxy и source IP hashing;
   - TLS policy scan.
   - только три exact method/path, без Node-RED editor/admin и OPTIONS;
   - upstream CORS скрыт; browser CORS preflight не открывает M2M API;
   - proxy retry равен нулю, raw path и canonical JSON semantics доходят до HMAC без
     rewrite; duplicate JSON keys отклоняются ingress до Node-RED parser.

## Exit criteria ограниченного пилота

- все P0 вопросы закрыты и подписаны владельцами;
- fresh `LK Games` snapshot и source SHA зафиксированы;
- custom node package и candidate hashes воспроизводимы;
- additions-only reviewed-flow apply и exact rollback/restart отрепетированы на
  изолированной копии Node-RED; production packet получен только из clean pushed SHA;
- exact runtime audit не содержит unresolved partner-reachable critical/high advisory;
- production-controls SHA совпадает в packet/plan, private ingress/custody overlays
  заполнены владельцами и проверены на target host против root-owned realpath,
  hostname, machine identity и exact packet bytes/semantics;
- отдельный live verifier прочитал ingress config/readback/certificate/CA и подписанный
  audit reachability artifact, повторил negative probes и снял декларативный
  `UNVERIFIED` status без ослабления `AUDIT_BLOCKED`;
- Mongo replica tests green, backup/rollback/reconciliation rehearsed;
- Viva sandbox matrix green с exact before/after evidence;
- mTLS включён; test/production client ID, HMAC key, certificate и audience различны;
- exclusive exact-host ingress закрывает shared-host и direct Node-RED обход;
- dashboards/alerts видят replay, auth failures, provider errors и `UNKNOWN` age;
- kill switch, client revoke и key rotation отрепетированы;
- ни одного production user/payment/booking в тестовых доказательствах.
