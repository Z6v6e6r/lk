# Вопросы внешней команде: Partner Game Membership API

Ответы фиксируются письменно с владельцем решения, датой и примером payload/read-back.
Ниже порядок не по удобству, а по риску. Неразрешённый P0 блокирует shared test с Viva;
P1 блокирует ограниченный пилот; P2 можно согласовать до масштабирования.

## P0 — блокирует любой реальный вызов Viva

### 1. Кто является сторонами и владельцем данных?

- Кто потребитель API: Viva, отдельная касса/агрегатор или наша прослойка?
- Какой legal/tenant/station соответствует каждому `clientId`?
- Кто вправе утверждать, что внешний платёж завершён, отменён или возвращён?
- Кто отвечает за ошибочно добавленного игрока и ручную reconciliation?

**Нужно получить:** RACI, список tenant/station, технического и бизнес-владельца,
канал экстренной блокировки.

### 2. Точный Viva контракт технического пользователя

- Какой Admin API endpoint создаёт booking технического клиента в уже существующем
  exercise? Метод, path, body, auth scope и допустимые status codes.
- Можно ли одному техническому Viva client иметь несколько активных booking в одном
  exercise? Если нет, требуется пул технических клиентов или иная модель.
- Возвращается ли уникальный booking ID в подтверждённом response? Как выполнить exact
  read-back по `exerciseId + bookingId + clientId`?
- Какие поля/states однозначно означают active и cancelled booking? Как доказать, что
  booking отсутствует: `last`, `totalPages/totalElements`, отдельный GET-by-ID? Может ли
  нужная запись оказаться за пределами первой страницы `size=200`?
- Как удалить именно эту запись без refund/возврата/затрагивания других booking?
- Как Viva отвечает на повтор create/delete, timeout после commit, already cancelled,
  exercise closed и capacity conflict?
- Поддерживает ли каждый mutation endpoint header `Idempotency-Key`? Какова область
  уникальности (tenant/client/endpoint), TTL записи, поведение при том же key+body и при
  том же key с другим body? Сохраняется ли тот же booking ID после lost response?
- Прокидывается/возвращается ли `X-Correlation-ID`, есть ли provider request ID для
  разбора неоднозначного timeout/`5xx`?
- Подтверждает ли команда точные provisional paths/body v0.2: Admin API v1 create,
  list read-back, cancellation probe и PUT `{refundMethod:"NONE",cancelExercise:false}`?
- Создаёт ли технический booking задолженность, оплату, чек, уведомление, абонементное
  списание, статистику посещения или рейтинг?

**Нужно получить:** актуальная OpenAPI-схема, sandbox examples и таблица семантики всех
2xx/4xx/5xx/timeout, отдельное письменное подтверждение `Idempotency-Key` и `ON_PLACE`.
Пока этого нет, реализованный v0.2 adapter остаётся default-off: четыре real-mutation
gate нельзя включать по предположению или только по успешному единичному запросу.

### 3. Что означает «оплачено»?

- `PAID` — деньги реально settled, только authorized или внутреннее обещание партнёра?
- Валюта и amount берутся из партнёра или сверяются с ценой слота в PadlHub/Viva?
- Может ли сумма быть 0; допустимы скидки, промокоды, частичная оплата?
- Где источник истины для refund/chargeback? Нужен ли отдельный reversal event?
- Подтверждает ли команда v0.2 правило: payment reference уникален и неизменяем в рамках
  integration client? Если один платёж покрывает нескольких игроков, нужен отдельный
  group-payment контракт, а не переиспользование reference.

**Нужно получить:** payment state diagram, правило amount/currency validation,
refund/chargeback policy и примеры reconciliation. Без этого отметка остаётся только
`settlementSource=EXTERNAL_PARTNER`, не банковским подтверждением PadlHub.

### 4. Стабильная идентичность игрока

- `externalPlayerId` уникален в рамках client, tenant или глобально?
- Может ли ID перейти другому человеку или измениться после merge аккаунтов?
- Какой displayName допустимо передавать и хранить; нужен ли телефон? В v0.2 телефон
  намеренно запрещён.
- Нужно ли связывать внешнего игрока с существующим LK/Viva профилем? Если да, кто и по
  какому доказательству выполняет mapping?

**Нужно получить:** lifecycle ID, retention/erasure policy и запрет на переиспользование.

### 5. Криптография и хранение ключей на стороне клиента

- Где хранится HMAC secret: KMS/secret manager/HSM, кто имеет read/use права?
- Может ли клиент выполнить HMAC без вывода секрета в логи?
- Синхронизированы ли часы через NTP и каков максимальный drift?
- Может ли клиент генерировать 192+ bit random nonce и новый correlation ID на попытку?
- Подтверждает ли клиент exact canonical JSON и golden test vectors?
- Как отзывается скомпрометированный key и кто круглосуточно выполняет rotation?

**Нужно получить:** owner key custody, rotation/revocation runbook и успешные golden
signature vectors. Передача секрета в request или ticket запрещена.

### 6. Сетевая защита

- Есть ли стабильные egress IP/CIDR клиента?
- Поддерживает ли клиент mTLS и ротацию client certificate?
- Где завершается TLS, какие proxy переписывают path/headers и какой path фактически
  подписывает клиент?
- Кто устанавливает rate limit и максимальный body size?

**Нужно получить:** mTLS предпочтительно; иначе exact IP allowlist, TLS policy,
trusted-proxy схема и DDoS/rate-limit значения. HMAC не предотвращает real-time relay.

### 7. Retry и неоднозначный результат

- Подтверждает ли клиент: старый HTTP request нельзя повторять; retry создаёт новый
  timestamp/nonce/correlation/signature при прежнем idempotency key и неизменном body?
- Как долго клиент хранит idempotency key и результат?
- Что клиент делает при `202 UNKNOWN`, `409`, `429`, `5xx` и connection reset?
- Запрещён ли автоматический DELETE после неясного POST?

**Нужно получить:** retry matrix с max attempts/backoff и отдельный manual path для
`UNKNOWN`.

### 8. Конкуренция и ёмкость игры

- Кто ещё одновременно добавляет игроков: LK, Viva-оператор, админ, другие партнёры?
- Какая величина является capacity и что делать, если место занято между Viva add и
  local commit?
- Разрешён ли waitlist через эту интеграцию? В v0.1 — нет.
- Какие exact поля и значения являются каноническими для public/private, archived и
  lifecycle? Локальный v0.1 принимает `PAID`, `PAYMENT_PENDING` и перечисленные legacy
  open statuses, но конфликтующие visibility flags отклоняет.
- Какой момент закрывает игру для новых участников: start, end либо отдельный join
  cutoff? Какой server clock/timezone является authority?

**Нужно получить:** единый joinability/capacity invariant с примерами реальных payload,
authority времени и согласованный compensation/manual reconciliation сценарий.

## P1 — блокирует ограниченный пилот

### 9. SLA/SLO и эксплуатация

- Ожидаемые RPS, burst, timeout и дневной объём?
- SLO ответа и максимальное время `UNKNOWN` до разбирательства?
- Кто получает алерты и имеет read-only доступ к operation/audit?
- Окно поддержки и эскалация P1/P2 incident?

### 10. Audit, PII и retention

- Какие поля обязаны быть в журнале для спора, а какие запрещены?
- Срок хранения membership/payment/audit/nonce/outbox?
- Требуются ли data residency, consent, DPA, право на удаление и legal hold?
- Как выдавать клиенту audit evidence без раскрытия другого tenant?

### 11. Sandbox и приёмочные данные

- Есть ли отдельные Viva tenant/station/exercise/technical client, не связанные с
  реальными клиентами и деньгами?
- Кто создаёт 2/4, 3/4, 4/4, closed/cancelled test games?
- Как очищать sandbox без переиспользования production IDs?
- Какие before/after provider read-back считаются доказательством?

### 12. Reconciliation и поддержка

- Нужен ли webhook от партнёра/Viva или достаточно polling operation?
- Как выявлять orphan booking, orphan local membership, duplicate external payment?
- Кто подтверждает ручной repair и какой four-eyes контроль требуется?
- Как клиент узнаёт о принудительном disable/revocation?

### 13. Версионирование и совместимость

- Срок уведомления о breaking change?
- Какие поля клиент обязан игнорировать в response?
- Нужен ли `problem+json` или текущий `{error:{code,message}}`?
- Требуется ли контрактная OpenAPI и consumer-driven tests в CI обеих сторон?

## P2 — до масштабирования

### 14. Массовые операции

- Нужен ли batch add/remove? Без отдельного дизайна v0.2 остаётся one request — one
  membership, чтобы сохранять понятную idempotency и ownership.
- Нужен ли atomic group booking или допустим частичный результат?

### 15. События и отчётность

- Нужны ли signed webhook о `COMPLETED/UNKNOWN/REMOVED`?
- Как подтверждать доставку webhook и защищать его от replay?
- Какие ежедневные settlement/reconciliation отчёты требуются?

### 16. Масштаб ключей и tenancy

- Отдельный client/key на юридическое лицо, среду и station либо общий?
- Нужны ли разные scopes на add/remove/read и operator-level approvals?
- Как проводится регулярный access review и автоматическое истечение тестового доступа?

## Минимальный пакет ответов для открытия shared sandbox

1. Подписанный P0 decision log.
2. Viva OpenAPI + sandbox technical client + exact add/read/delete examples + письменная
   гарантия provider idempotency и `ON_PLACE` semantics.
3. Golden HMAC vectors, NTP proof и retry matrix.
4. mTLS certificate либо утверждённые CIDR/TLS/rate limits.
5. Payment semantics и запрет нежелательных Viva side effects.
6. Test data plan без реальных пользователей и денег.
7. Owners для incident, key revocation и `UNKNOWN` reconciliation.
