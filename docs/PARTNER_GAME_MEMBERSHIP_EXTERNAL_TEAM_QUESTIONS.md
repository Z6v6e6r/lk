# Вопросы внешней команде: Partner Game Membership API

Ответы фиксируются письменно с владельцем решения, датой и примером payload/read-back.
Ниже порядок не по удобству, а по риску. Неразрешённый P0 блокирует shared test с Viva;
P1 блокирует ограниченный пилот; P2 можно согласовать до масштабирования.

## Лист согласования P0 — 2026-09-06

Статус: **AWAITING_OWNERS_AND_EXTERNAL_EVIDENCE**, не «согласовано».
Это рабочий лист к существующим вопросам ниже, не новый контракт или разрешение
на подключение. Сверены API, guarded-release и offline kit на checkpoint `ffcbe3a`.
В этих документах письменные ответы сторон не обнаружены; если они уже получены,
нужно указать существующий документ, а не проводить согласование заново.

«Зафиксировано» ниже означает требование локального контракта, не фактическое
согласие внешней команды, настройку сервера или результат live-проверки.
Владельцы указаны **ролями для назначения**, конкретные ответственные ещё не заданы.
Все восемь строк имеют статус `AWAITING_CONFIRMATION`; номер соответствует вопросу.

| ID | Зафиксировано в текущем контракте | Что требуется для согласования | Ответственные роли |
| --- | --- | --- | --- |
| P0-01 | Отдельный M2M client, scopes add/remove/read и server-owned tenant/station/game allowlist; удаление только своего membership | Название потребителя API (Viva или отдельный партнёр), границы доступа, технический/бизнес-владелец и канал экстренной блокировки | Партнёр + владелец интеграции PadlHub |
| P0-02 | Технический Viva client; exact booking binding/read-back; ON_PLACE и cancel без refund пока provisional; реальные mutations default-off | Официальный add/read/cancel и least-privilege token contract; поддержка нескольких мест на технического клиента; idempotency, полнота read-back и отсутствие побочных списаний/уведомлений | Владелец Viva API + backend PadlHub |
| P0-03 | PAID — только EXTERNAL_PARTNER, не банковское/Viva подтверждение; один payment.reference на membership в рамках client | Когда расчёт считается завершённым; проверка суммы/валюты, нулевая/частичная оплата; refund/chargeback и ручная сверка | Бизнес-владельцы оплаты партнёра и PadlHub |
| P0-04 | Стабильный externalPlayerId, без телефона и произвольного LK/Viva ID; mapping профиля не входит в API | Область уникальности, запрет передачи ID другому человеку, lifecycle/displayName и правила хранения/удаления данных | Владелец клиентских данных партнёра + PadlHub |
| P0-05 | HMAC v2 с exact audience, timestamp/nonce и подписанным idempotency; offline kit содержит только публичный demo key | Результаты пяти vectors собственной реализации; key custody, синхронизация часов, random nonce и отзыв/ротация | Технический владелец и security партнёра + security PadlHub |
| P0-06 | Выбран Nginx; mTLS обязателен, IP allowlist дополнительный; test/production identities разделены | Поддержка mTLS, владелец выдачи/отзыва cert, egress CIDR, exact Host/SNI/audience и proxy path; значения лимитов | Инфраструктура/security PadlHub + партнёр |
| P0-07 | На retry новый proof при прежней команде/Idempotency-Key; UNKNOWN требует reconciliation, без слепого provider retry/DELETE | Retry matrix для 202/409/429/5xx/reset, хранение ключей/результатов, backoff/max attempts и ответственный за UNKNOWN | Технический владелец партнёра + эксплуатация PadlHub |
| P0-08 | Только допустимая открытая игра с проверенной capacity; waitlist не входит в интеграцию | Все параллельные writers, canonical capacity/joinability/cutoff и действия при конфликте между Viva и локальной записью | Владелец игр PadlHub + Viva/партнёр |

### Формат ответа по каждой строке

```text
DECISION_ID=P0-01 … P0-08 (один ID на запись)
STATUS=CONFIRMED | CHANGE_REQUESTED | NEEDS_PROVIDER_EVIDENCE
DECISION=точное принятое правило или требуемое отличие
OWNER_ROLE=назначенная ответственная роль
APPROVED_AT_UTC=дата письменного решения
EVIDENCE_REFERENCE=ссылка/идентификатор согласованного документа и его версия
OPEN_ITEMS=что ещё не подтверждено, либо NONE
```

Не прикладывать passwords, tokens, HMAC secrets, private keys, персональные данные
или raw request dumps. Личные контакты, реальные client/game/provider IDs и
эксплуатационные настройки фиксируются в отдельном согласованном приватном реестре;
в публичный kit и репозиторий они не переносятся. Ответ «да» на начало этого этапа
не заполняет восемь строк статусом CONFIRMED.

### Что можно сделать сейчас и что остаётся отдельно

1. Назначить потребителя API и технического владельца с его стороны; определить,
   кто может дать официальный ответ Viva. Сначала собрать имеющиеся ответы P0-01/02,
   поскольку они определяют остальных участников согласования.
2. Передать через отдельно согласованный канал [офлайн-комплект](partner-game-membership-kit/README.md)
   и этот лист; получить результаты реализации клиента и ответы по всем восьми P0.
   Внешняя отправка этим документом не выполняется и не авторизуется.
3. Разобрать отличия как CHANGE_REQUESTED: не менять текущий контракт, безопасность
   или provider adapter автоматически ради неподтверждённого ответа.
4. После подтверждений сверить P1/приёмку и отдельные
   [release gates](PARTNER_GAME_MEMBERSHIP_GUARDED_RELEASE.md). Согласованный P0 сам
   по себе не означает готовность к deploy, выдаче боевых credentials или Viva write.

Ссылка на тестовую игру уже дана пользователем в этой задаче; повторное создание
не требуется. Её актуальные IDs, ownership/joinability/capacity и отсутствие влияния
на реальных игроков/расчёты должны быть проверены перед разрешённым live-тестом;
в этом этапе серверная проверка и изменения игры не выполнялись.

Native Nginx application rehearsal и Docker install остаются
`DEFERRED_BY_USER / NOT_RUN`; прежние FAILED observations сохранены. Выбор Nginx
не пересматривается. Live ingress/custody и default-off startup остаются отдельными
незакрытыми gates, включая требуемое подтверждение работающего audit и запрета
обхода ingress. Подготовка/подпись листа не заменяет runtime-проверку.

## P0 — блокирует любой реальный вызов Viva

### 1. Кто является сторонами и владельцем данных?

- Кто потребитель API: Viva, отдельная касса/агрегатор или наша прослойка?
- Какой legal/tenant/station соответствует каждому `clientId`?
- Кто вправе утверждать, что внешний платёж завершён, отменён или возвращён?
- Кто отвечает за ошибочно добавленного игрока и ручную reconciliation?

**Нужно получить:** RACI, список tenant/station, технического и бизнес-владельца,
канал экстренной блокировки.

### 2. Точный Viva контракт технического пользователя

- Как отдельный Partner sidecar получает Viva access token без общего Node-RED global
  context: OAuth client credentials, service account или иной серверный grant?
- Какие exact token endpoint, audience/scope, TTL, refresh/reissue и revocation
  semantics? Разрешён ли отдельный least-privilege credential только для
  add/read/cancel технического booking?
- Как отличить token expiry/revocation от provider outage и доказать, что новый token
  не расширяет tenant/station scope? Кто владелец ротации и экстренного отзыва?
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

**Нужно получить:** актуальная OpenAPI-схема, sandbox examples, отдельный
least-privilege token/grant contract и таблица семантики всех 2xx/4xx/5xx/timeout,
отдельное письменное подтверждение `Idempotency-Key` и `ON_PLACE`.
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
- Может ли клиент конфигурировать и подписывать отдельный exact audience для test и
  production и fail-closed отклонять неизвестную среду?
- Синхронизированы ли часы через NTP и каков максимальный drift?
- Может ли клиент генерировать 192+ bit random nonce и новый correlation ID на попытку?
- Подтверждает ли клиент exact canonical JSON и golden test vectors?
- Как отзывается скомпрометированный key и кто круглосуточно выполняет rotation?

**Нужно получить:** owner key custody, rotation/revocation runbook и успешные golden
signature vectors. Передача секрета в request или ticket запрещена.

### 6. Сетевая защита

- Есть ли стабильные egress IP/CIDR клиента как дополнительное ограничение?
- Поддерживает ли клиент обязательный mTLS, отдельные test/production certificates и
  их ротацию без повторного использования ключевого материала?
- Где завершается TLS, какие proxy переписывают path/headers и какой path фактически
  подписывает клиент?
- Кто устанавливает rate limit и максимальный body size?

**Нужно получить:** обязательный mTLS, разные test/production client ID, HMAC key и
certificate, exact audience/Host/SNI, дополнительный IP allowlist, TLS policy,
socket-peer/trusted-proxy схема и DDoS/rate-limit значения. CIDR без mTLS не допускается:
HMAC не предотвращает real-time relay, а `X-Forwarded-For` не является identity.

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
   гарантия provider idempotency и `ON_PLACE` semantics + отдельный least-privilege
   sidecar token grant с TTL/refresh/revocation runbook.
3. Golden HMAC vectors, NTP proof и retry matrix.
4. Отдельный test mTLS certificate + exact test audience; production certificate,
   client ID и HMAC key выпускаются отдельно и не переиспользуют test material.
5. Payment semantics и запрет нежелательных Viva side effects.
6. Test data plan без реальных пользователей и денег.
7. Owners для incident, key revocation и `UNKNOWN` reconciliation.
