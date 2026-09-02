# DEV UAT двух подписок по периоду продажи

Пакет сопровождает ручной UAT двух экземпляров одного `subscriptionTypeId`,
купленных по разные стороны `effectiveAt` V2. Runner только читает DEV-состояние,
проверяет immutable policy pin и формирует redacted before/after evidence.

Runner не создаёт игру, не присоединяет игрока, не бронирует Viva, не выполняет
оплату, не списывает entitlement и не меняет feature flags. Разрешены только
`GET`/`HEAD`/`OPTIONS` и два строго ограниченных read-only `POST` endpoint.

## Запуск

```bash
node scripts/dev-uat/subscriptions-sale-period/run.mjs --mode preflight
node scripts/dev-uat/subscriptions-sale-period/run.mjs --mode observe-before
DEV_UAT_RUN_ID=<runId-из-observe-before> \
  node scripts/dev-uat/subscriptions-sale-period/run.mjs --mode observe-after
```

CLI принимает только `--mode`. Идентификаторы и secrets в argv запрещены.

## Приватные входы

Входы задаются environment variables или JSON-файлом через
`DEV_UAT_CONFIG_FILE`. Файл должен быть обычным, не symlink, с правами `0600`:

```bash
cp docs/dev-uat/subscriptions-sale-period/config.example.json /private/tmp/subscription-sale-period-dev-uat.json
chmod 600 /private/tmp/subscription-sale-period-dev-uat.json
export DEV_UAT_CONFIG_FILE=/private/tmp/subscription-sale-period-dev-uat.json
```

Обязательны:

- `DEV_LK_BASE_URL`, `DEV_CUP_BASE_URL`;
- `DEV_TEST_SUBSCRIPTION_A_ID`, `DEV_TEST_SUBSCRIPTION_B_ID` и их exact
  `DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID`, `DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID`;
- `DEV_TEST_AUTH_A`, `DEV_TEST_AUTH_B`, `DEV_CUP_INTEGRATION_TOKEN`;
- `EXPECTED_SUBSCRIPTION_TYPE_ID`, `EXPECTED_PRODUCT_ID`;
- `EXPECTED_RULE_A_VERSION=V1`, `EXPECTED_RULE_B_VERSION=V2`;
- обязательный контроль: `DEV_CONTROL_SUBSCRIPTION_ID`,
  `DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID`, `DEV_CONTROL_AUTH`;
- exact `DEV_UAT_ALLOWED_DEV_ORIGINS_JSON` с обоими origin;
- frozen `DEV_UAT_EXPECTED_LK_RELEASE_JSON` и
  `DEV_UAT_EXPECTED_CUP_RELEASE_JSON`, каждый с exact `sourceSha`,
  `candidateSha`, `readbackSha`, `servedSha`.

Опциональны:

- `DEV_UAT_REDACTION_HMAC_KEY` — HMAC-ссылки вместо redacted suffix;
- `DEV_UAT_PRODUCTION_ORIGINS_JSON` — дополнение, но не замена built-in denylist;
- `DEV_UAT_TIMEOUT_MS` — 100–60000, default 8000;
- `DEV_UAT_MAX_EVIDENCE_AGE_MS` — 1000–3600000, default 5 минут;
- `DEV_UAT_BEFORE_MAX_AGE_MS` — 60000–86400000, default 1 час;
- `DEV_UAT_EXPECTED_DELTA_JSON`, `DEV_UAT_ARTIFACT_ROOT`, `DEV_UAT_RUN_ID`.

Base URL обязан быть чистым origin без credentials/path/query/fragment.
Production origins блокируются до сети. Любой DEV origin, включая localhost и
hostname с `dev`/`test`, обязан быть точно внесён в allowlist. Имя хоста само по
себе никогда не считается доказательством DEV и не разрешает передачу credentials.

## Read-only endpoint contract

GET-пути переопределяются только в приватном `endpoints`. Для POST безопасны
лишь перечисленные ниже `runtime-context` и `dev-uat/observability` пути (также
поддерживаются варианты без `/api`); произвольный override будет заблокирован.

| Назначение | Метод | Default path |
|---|---:|---|
| LK release identity | GET | `/lk/release-dev.json` |
| CUP release identity | GET | `/api/system/release` |
| CUP system evidence | GET | `/api/internal/subscriptions/dev-uat/system-evidence` |
| instance runtime context | POST | `/api/internal/subscriptions/runtime-context` |
| run-scoped observability | POST | `/api/internal/subscriptions/dev-uat/observability` |

Сначала без auth читаются три metadata endpoint. Только подтверждённые DEV
environment, frozen release bindings, DEV-only flags, unchanged production state,
indexes и fresh evidence разрешают отправить user-scoped credentials.

Каждый release response обязан содержать четыре 40-hex SHA и точно совпасть с
заранее frozen expected tuple из приватной конфигурации:

```json
{
  "sourceSha": "1111111111111111111111111111111111111111",
  "candidateSha": "1111111111111111111111111111111111111111",
  "readbackSha": "1111111111111111111111111111111111111111",
  "servedSha": "1111111111111111111111111111111111111111"
}
```

Runner сравнивает каждое поле с frozen значением; взаимного равенства полей без
внешней frozen привязки недостаточно.

### Runtime context

Request body содержит только `clientSubscriptionId`; заголовки — auth тестера и
integration token. Минимальный ответ:

```json
{
  "schemaVersion": 1,
  "clientSubscriptionId": "private-exact-id",
  "subscriptionInstanceId": "private-instance-id",
  "productId": "expected-product-id",
  "tenantId": "dev-tenant",
  "authoritativePurchasedAt": "2026-09-09T23:59:59.999Z",
  "policyDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "policy": { "subscriptionTypeId": "expected-type-id", "policyVersion": 1 },
  "instance": {
    "subscriptionInstanceId": "private-instance-id",
    "subscriptionTypeId": "expected-type-id",
    "productId": "expected-product-id",
    "policyVersion": 1,
    "policyDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "state": "ACTIVE",
    "tenantId": "dev-tenant"
  },
  "evidence": {
    "instanceRevision": 7,
    "publicationHistory": [
      {
        "version": 1,
        "subscriptionTypeId": "expected-type-id",
        "effectiveAt": "2026-09-01T00:00:00.000Z",
        "status": "SUPERSEDED",
        "policyDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      {
        "version": 2,
        "subscriptionTypeId": "expected-type-id",
        "effectiveAt": "2026-09-10T00:00:00.000Z",
        "status": "PUBLISHED",
        "policyDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    ]
  }
}
```

`authoritativePurchasedAt` — строгий RFC 3339 instant с `Z`/offset из
server/provider projection. Date-only, timezone-less, browser-supplied и
противоречивые значения блокируются. Digest — 64 hex символа. Дублирующие
server-owned поля обязаны совпадать.

### System evidence

DEV producer отдаёт агрегат без user data:

```json
{
  "environment": "DEV",
  "tenantId": "dev-tenant",
  "runtimeFlags": { "enabled": true, "devOnly": true, "productionEnabled": false },
  "productionState": { "unchanged": true, "runtimeFlagsEnabled": false },
  "indexes": {
    "required": ["instance-pin", "entitlement-scope"],
    "present": ["instance-pin", "entitlement-scope"],
    "missing": []
  },
  "projectionCheckpoint": { "current": true, "observedAt": "2026-09-02T12:00:00.000Z" },
  "canaryEvidence": {
    "current": true,
    "observedAt": "2026-09-02T12:00:00.000Z",
    "subscriptionInstanceIds": ["private-instance-a", "private-instance-b"]
  },
  "noWriteEvidence": {
    "current": true,
    "observedAt": "2026-09-02T12:00:00.000Z",
    "createJoinWritesAbsent": true,
    "providerBookingWritesAbsent": true,
    "paymentWritesAbsent": true,
    "entitlementMutationsAbsent": true,
    "rollbackWritesAbsent": true
  },
  "managedRange": {
    "startsAt": "2026-09-01T00:00:00.000Z",
    "endsAt": "2026-09-30T23:59:59.999Z"
  }
}
```

Runner не читает production user data. Если DEV producer не доказывает
неизменность production, exact-two instance allowlist или любую no-write
dimension, включая payment и rollback, preflight блокируется. Отсутствующее или
unknown значение — `FAIL`, не `PASS`. Caller-provided `canaryAllowed` игнорируется.

### Observability

Request содержит `clientSubscriptionId` и exact scope
`subscription-sale-period:<runId>:A|B`. Ручной DEV tooling обязан маркировать
каждый шаг этим scope и безопасным enum `step`. До UAT scope должен быть пуст.
Все run-scoped operation/ledger/outbox/provider и safety counters до UAT должны
быть абсолютным нулём; ненулевой baseline не маскируется проверкой delta.

```json
{
  "clientSubscriptionId": "private-exact-id",
  "subscriptionInstanceId": "private-instance-id",
  "correlationScope": "subscription-sale-period:20260902T120000000Z:A",
  "selectedPolicyVersion": 1,
  "selectedPolicyDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "instanceRevision": 7,
  "instanceState": "ACTIVE",
  "metrics": {
    "entitlementAggregateRevision": 4,
    "dailyUsage": 0,
    "activeUsage": 0,
    "operations": 0,
    "ledgerEntries": 0,
    "outboxEntries": 0,
    "testerGames": 0,
    "providerWriteCounter": 0,
    "paymentWriteCounter": 0,
    "entitlementMutationCounter": 0,
    "rollbackWriteCounter": 0,
    "orphanReserves": 0,
    "fallbackCounter": 0,
    "productionCupCalls": 0,
    "unrelatedUserChanges": 0
  },
  "logicalResults": [],
  "evidenceHmac": "64-hex-hmac-over-the-exact-normalized-response"
}
```

`evidenceHmac` вычисляется DEV producer как HMAC-SHA256 с integration token по
exact `clientSubscriptionId`, `subscriptionInstanceId`, correlation scope,
policy pin, instance state/revision, всем metrics и logical rows. Несовпадение
любого поля, scope или instance ID блокирует evidence.

После ручного шага `logicalResults` содержит по одной строке на ожидаемую
logical operation:

```json
{
  "step": "A_CREATE",
  "action": "CREATE_GAME",
  "result": "CONFIRMED",
  "policyVersion": 1,
  "policyDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "logicalOperationCount": 1,
  "providerCalls": 1,
  "ledgerEntries": 1,
  "outboxEntries": 1,
  "orphanReserve": false,
  "fallback": false,
  "productionCupCalls": 0
}
```

`step/action/result` — только uppercase enum. Суммы logical rows обязаны точно
совпасть с aggregate operation/provider/ledger/outbox delta. Raw provider
payload, ФИО, телефон и списки пользователей не принимаются и не сохраняются.

## Preflight gates

Runner проверяет:

1. distinct exact-allowlisted LK/CUP DEV origins и frozen release bindings;
2. один exact product/type, разные exact subscription и instance IDs, authoritative dates;
3. обе даты в managed range и `purchasedAt(A) < effectiveAt(V2) <= purchasedAt(B)`;
4. unique `effectiveAt`, monotonic versions, immutable/active selected publication;
5. A→V1, B→V2 и exact version/digest instance pins;
6. exact-two A/B instance canary allowlist; обязательный exact контрольный
   client/instance ID, tenant и type исключён;
7. DEV-only flags, unchanged production, required indexes, fresh checkpoints;
8. exact tenant equality между A, B и system evidence.

Любая неоднозначность, отсутствие evidence или fallback даёт `BLOCKED`.

## Ручной UAT

1. Запустить `preflight`; продолжать только с `READY`.
2. Запустить `observe-before`; сохранить `runId`. Snapshot подписан HMAC,
   привязан full HMAC к exact client/instance IDs A/B/control, origins, frozen
   releases и policy pins и действует ограниченно.
3. Указать exact `expectedDelta` для выбранных шагов.
4. Убедиться визуально, что открыты только DEV origins.
5. Выполнить согласованные ручные действия. Runner их не запускает.
6. После unknown/timeout результата не повторять действие: сначала scoped readback.
7. Запустить `observe-after` с тем же `runId`.

Final after-report тоже подписан HMAC и привязан к integrity HMAC before,
exact subject bindings и frozen release bindings. `setupNoWrites=true` означает
только доказанный read-only контракт setup/default runner: все шесть `writeSafety`
dimensions включают локальную блокировку mutation methods, create/join, provider
booking, payment, entitlement и rollback.

Глобальное `noWrites=true` появляется только в final after-report, когда signed
before/after evidence для exact A/B и exact `runId` дополнительно доказывает нулевые
delta `providerWriteCounter`, `paymentWriteCounter`,
`entitlementMutationCounter` и `rollbackWriteCounter`. Любая положительная delta
делает глобальное `noWrites=false`, даже если ожидаемая ручная операция и общий
UAT reconciliation получили `PASS`. Missing, unsigned, unbound или decreasing
counter также не может дать no-write PASS.

До ручного UAT каждый из четырёх mutation counters обязан быть absolute zero.
Неизменившийся положительный baseline (например, `7→7`) блокирует before-snapshot
и повторно отклоняется final proof; одной нулевой delta недостаточно.

### Подписка A — V1

- Открыть профиль и сверить exact A оператором.
- Создать тестовую игру в разрешённом DEV-слоте.
- Присоединиться к отдельно подготовленной DEV-игре, если шаг согласован.
- Проверить лимит V1 и ожидаемый отказ на границе.
- После reload подтвердить тот же immutable V1 pin.
- Duplicate click обязан дать одну logical operation и не более одной записи
  provider/ledger/outbox.

### Подписка B — V2

- Повторить профиль, CREATE/JOIN только в DEV.
- Подтвердить V2, а не latest-by-now или fallback V1.
- Проверить отличающуюся границу лимита V2.
- Проверить ожидаемый quote/отказ; не переходить к реальной оплате.
- После reload и duplicate click должна остаться одна logical result.

### Общие негативные шаги

- CUP timeout эмулировать только DEV fault injection; решение fail closed.
- Повторный запрос использует тот же idempotency/correlation context.
- Смена вкладки и браузерная дата не меняют policy.
- Reload между decision и подтверждением не меняет instance pin.
- Отказ не создаёт Viva booking, ledger reserve или orphan outbox.
- Неканареечная подписка не входит в managed path.
- Production CUP calls и unrelated-user delta равны zero.

## Expected delta и отчёты

Для A/B обязательны `policyVersion`, `instanceRevisionDelta`, итоговый
`instanceState`, все одиннадцать mutable metrics и `logicalResults`. Пример —
`config.example.json`; оператор корректирует его под фактический сценарий.

Runner создаёт private каталог `0700` и JSON/Markdown `0600`:

```text
artifacts/subscription-sale-period-dev-uat/<timestamp>/before.json
artifacts/subscription-sale-period-dev-uat/<timestamp>/before.md
artifacts/subscription-sale-period-dev-uat/<timestamp>/report.json
artifacts/subscription-sale-period-dev-uat/<timestamp>/report.md
```

Идентификаторы маскируются suffix/HMAC, secrets и PII заменяются. `artifacts/`
не коммитить; перед commit проверить staged diff.

## Локальные fixtures

```bash
node --test scripts/dev-uat/subscriptions-sale-period/test.mjs
```

Тесты используют только local fixtures и не выполняют сеть или runtime writes.
