# Threat model: Partner Game Membership API v0.1

Дата: 2026-09-01. Scope: новый M2M namespace, кастомный Node-RED runtime, Mongo
ownership/idempotency/audit ledgers, синтетический Viva adapter и source-only flow
builder. Не входят: production ingress, реальный Viva provider, secret provisioning,
Mongo production migration, deploy и activation.

## 1. Системная модель

### Активы

| Актив | Почему важен |
| --- | --- |
| HMAC client secrets и audit HMAC key | Компрометация позволяет подписывать команды либо сопоставлять audit fingerprints |
| Open game capacity/roster | Ошибка создаёт oversubscription или удаляет реального игрока |
| Canonical membership ownership | Единственное доказательство, кого API вправе удалить |
| Viva technical booking binding | Ошибка отменяет чужой booking или оставляет orphan |
| External payment assertion | Нельзя смешивать с банковским/Viva settlement |
| Nonce/idempotency/operation ledgers | Защищают от replay, duplicate provider writes и неоднозначных ACK |
| Audit/outbox | Нужны для расследования и reconciliation |
| PII: displayName/externalPlayerId/payment reference | Требует минимизации, RBAC и retention |

### Доверительные границы и поток

```text
[Partner/KMS]
      | TLS + optional mTLS, HMAC proof
      v
[Ingress: allowlist/rate-limit]        -- вне v0.1
      |
      v
[Node-RED custom API node]
      |-- verify exact method/path/body/time/key/scope
      |-- consume nonce + durable ingress audit
      v
[Mongo replica: operations/memberships/lk_games/audit/outbox]
      |
      | exact server-side binding only
      v
[Viva technical user adapter]         -- real adapter отсутствует в v0.1
      |
      `-- exact booking read-back -> local transactional projection
```

Partner request полностью недоверенный. Keyring/env и technical Viva client ID
server-only. Mongo является authority для ownership, но не authority для банковского
settlement. Viva является authority только для существования exact technical booking.

## 2. Source evidence

- Каноническая подпись включает версию, client/key, timestamp, nonce, method, exact path,
  body hash, idempotency и correlation; секрет используется только для HMAC
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs:106-131`).
- Timestamp, UUID, key state, minimum secret length и constant-time HMAC comparison
  проверяются до атомарного consume nonce
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs:226-286`).
- Scope проверяется после proof, а durable ingress audit пишется до mutation; audit
  сохраняет HMAC fingerprints вместо raw nonce/IP/body
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs:340-411`).
- Idempotency связывается с method/path/body hash; повтор завершённой операции возвращает
  сохранённый response, а иной request даёт conflict
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs:414-441`).
- Add и remove требуют exact Viva read-back; неоднозначность переходит в `UNKNOWN`, а не
  вызывает слепой retry
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs:442-565`).
- Real provider в v0.1 явно disabled; synthetic adapter отделён
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs:578-619`).
- Индексы фиксируют client idempotency, active ownership, nonce TTL и outbox identity;
  runtime отклоняет missing/weakened prerequisites
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs:14-35`,
  `node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs:125-162`).
- Nonce создаётся majority insert с уникальным `_id`; duplicate переводится в
  `REQUEST_REPLAY_DETECTED`
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs:164-183`).
- Open/station/exercise/capacity gate fail-closed: archived, terminal/unknown lifecycle,
  ended or schedule-less games and any explicit private/conflicting visibility signal
  are rejected; canonical `PAID`/`PAYMENT_PENDING` records remain supported. Transaction
  uses snapshot, majority and primary
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs`).
- Delete проверяет exact `_id + membershipId + clientId + gameId + ACTIVE`, затем текущий
  station allowlist по сохранённому `membership.stationId` до provider. Failure до
  `VIVA_PENDING` меняет только operation/audit и не может изменить угаданный membership
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs`,
  `node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs`).
- Локальное удаление использует `$pull` только по canonical membership ID, а operation,
  membership, audit и outbox завершаются в одной transaction
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs:435-505`).
- Kill switch default-off, secrets только env; synthetic provider разрешён лишь в
  изолированном loopback runtime, иначе выбирается disabled provider
  (`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-node.cjs:18-91`).
- Flow candidate требует отдельный namespace, exact source SHA и запрещает in-place
  mutation; manifest явно фиксирует отсутствие deploy/activation
  (`scripts/patch_partner_game_membership_api_flow.mjs:32-124`,
  `scripts/patch_partner_game_membership_api_flow.mjs:126-171`).

## 3. Threat register

### T1. Replay перехваченного запроса

- Атакующий: наблюдатель в proxy/log/client host.
- Путь: повторить тот же signed POST/DELETE.
- Влияние: duplicate player, двойная техническая запись или повторное удаление.
- Контроли: HMAC покрывает весь request identity; окно 90 секунд; majority-backed unique
  nonce до операции; idempotency отдельно блокирует duplicate business command.
- Остаток: real-time relay до первого consume не устраняется HMAC. До пилота нужен mTLS
  или минимум IP allowlist, rate limit и trusted-proxy review.
- Риск после v0.1 controls: medium; до ingress controls: high.

### T2. Подмена body/path/method

- Путь: заменить game, membership, amount, payment reference или POST на DELETE.
- Контроли: exact path/method/body hash входят в HMAC; query запрещён; JSON canonical;
  closed schema запрещает caller-controlled `source/paid/Viva IDs`.
- Остаток: обе стороны должны реализовать один canonical JSON; нужны golden vectors.
- Риск: low после contract tests.

### T3. Компрометация client secret

- Путь: атакующий подписывает новые валидные команды — anti-replay не помогает.
- Контроли: отдельные client/key, scopes, station allowlist, kill switch, key rotation,
  audit/alerts.
- Отсутствует: KMS attestation, expiry, mTLS second factor, automated revocation.
- Риск: high до утверждённой key custody и mTLS.

### T4. Удаление игрока LK/Viva/админки или другого партнёра

- Путь: передать guessed participant/Viva booking/user ID.
- Контроли: DELETE принимает только membershipId; canonical row должна точно совпасть по
  client/game/state и текущему station allowlist; provider вызывается после этой
  проверки; pre-authorization failure не меняет referenced membership; projection source
  не даёт права удаления.
- Остаток: Mongo RBAC должен запрещать клиенту прямой доступ к ownership collection.
- Риск: low в API, high при чрезмерных DB credentials.

### T5. Provider timeout/ambiguous ACK и duplicate Viva booking

- Путь: Viva commit выполнен, HTTP response потерян; автоматический retry создаёт дубль.
- Контроли: operation ledger, exact provider read-back, `UNKNOWN`, сохранённый idempotent
  response и отсутствие blind retry.
- Отсутствует: реальный provider contract, reconciliation worker/runbook и доказательство
  Viva idempotency.
- Риск: high; именно поэтому real provider в v0.1 disabled.

### T6. Oversubscription при конкурентном LK/Viva/partner add

- Путь: место занято между reservation, provider add и local commit.
- Контроли: capacity check, pending count, partner reservation revision как transaction
  write fence, финальная capacity recheck; после provider ACK локальный конфликт становится
  `UNKNOWN`, а не silent overwrite.
- Остаток: существующие LK/Viva writers могут не учитывать partner reservation. Нужна
  fresh writer inventory и cross-writer concurrency test.
- Риск: high до live-flow reconciliation; medium после общего capacity invariant.

### T7. Audit bypass, log injection или утечка PII/секретов

- Путь: invalid request, control chars, огромный body, raw secret/nonce/IP в logs.
- Контроли: строгие token/display validation, no-store response, HMAC fingerprints,
  durable ingress и transactional operation audit, generic internal error.
- Остаток: ingress body/header size limit отсутствует в v0.1; unauthenticated audit при
  Mongo outage может существовать только как fallback node event; retention/RBAC/SIEM не
  настроены.
- Риск: medium до ingress/RBAC/retention.

### T8. Ослабленные или отсутствующие Mongo indexes

- Путь: duplicate nonce/idempotency/active membership либо outbox duplicate.
- Контроли: named exact specs; shared runtime только verifies и fail-closed; auto-create
  разрешён лишь synthetic isolated runtime.
- Остаток: production migration/rollback и replica test не выполнены.
- Риск: high до migration rehearsal, low после verify/postcheck.

### T9. Synthetic mode попадает в shared/prod

- Путь: ошибочная env-конфигурация.
- Контроли: environment `local|test|dev`, loopback host и test-like DB name должны
  выполняться одновременно; глобальный flag default-off; flow comment предупреждает.
- Остаток: process env может быть намеренно подделан operator с host access.
- Риск: low при обычной RBAC, high при компрометации host operator.

### T10. Путаница внешнего `PAID` с банковским settlement

- Путь: downstream считает partner assertion реальной PadlHub/Viva оплатой и делает
  чек/refund/financial report.
- Контроли: отдельный `settlementSource=EXTERNAL_PARTNER`, closed field, документация.
- Отсутствует: downstream inventory и payment/reporting compatibility review.
- Риск: high до ответов payment owners и downstream tests.

### T11. Source-flow drift и небезопасный import

- Путь: candidate строится из устаревшего `LK Games`, затирает live changes или создаёт
  route collision.
- Контроли: внешний fresh snapshot, exact SHA, exact tab label, namespace/id collision,
  no in-place, source-only manifest.
- Текущее состояние: live pull 2026-09-01 завершился `scp: Connection closed`; candidate
  не строился и import не выполнялся.
- Риск: high до свежей read-only выгрузки; отсутствует runtime exposure сейчас.

## 4. Обязательные gates

### До shared sandbox

1. Закрыть все P0 вопросы из external-team document.
2. Получить fresh `LK Games`, проверить writers/field shapes и построить source-only
   candidate по exact SHA.
3. Добавить real Viva adapter только из подтверждённой OpenAPI; отдельный security,
   payment-safety и reliability review.
4. Прогнать Mongo replica/concurrency/ambiguous-commit tests.
5. Настроить mTLS предпочтительно; минимум ingress IP allowlist, TLS, rate/body limits.
6. Создать отдельные sandbox key/technical client/Mongo DB без production данных.

### До production

1. Отдельное разрешение на schema migration, secret provisioning, route import, deploy и
   activation.
2. Reconciliation worker/runbook + rehearsed UNKNOWN cases.
3. Audit RBAC/retention/SIEM alerts и key rotation/revocation rehearsal.
4. Downstream compatibility для payment, roster sync, reporting, rating/notifications.
5. Limited pilot с одной station/client, expiring access и проверенным kill switch.

## 5. Review status

Формальный diff scan `751503a0-1a8a-40e6-9df4-7d7ec3f47d59` нашёл два Medium/P2:
DELETE не повторял station ACL, а POST использовал неполный open-game predicate. Оба
attack path закрыты corrective patch и негативными тестами. Отдельный bypass/regression
pass дополнительно обнаружил, что общий pre-authorization error path мог изменить
referenced membership; теперь REMOVE меняет membership state только после успешного
перехода в `VIVA_PENDING`.

После исправления 35/35 focused tests, full lint без errors, production+dev build,
syntax checks, Draw.io XML validation и diff-check прошли. Реальный Mongo replica,
shared ingress и Viva sandbox остаются отдельными gates. Перед добавлением real Viva
adapter и первой внешней публикацией требуется свежий security review, а перед
активацией — payment-safety/reliability review. Текущий v0.1 не активирован и не способен
выполнить реальную Viva mutation.
