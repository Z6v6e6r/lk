# ADR 0003: Управляемые годовые подписки и единый контур их использования

Date: 2026-08-11

## Status

Proposed — contract and evidence checkpoint for user verification.

Этот ADR разрешает только фиксацию архитектуры и провайдерных контрактов. Он не
разрешает изменение runtime, интеграцию в `main`, push, deploy или операции с
реальными подписками и бронированиями.

## Контекст

Годовая подписка должна одновременно поддерживать:

- отдельные предложения и ценовые партии для разных станций;
- разовые массовые выбросы, ежедневные порции и ценовые лестницы;
- управляемое создание и присоединение к играм длительностью 60–120 минут;
- общий лимит активных услуг и настраиваемое окно бронирования;
- скидки или фиксированную цену на игры, групповые занятия и турниры;
- применение новых правил к действующим и/или только новым контрактам;
- список покупателей, историю использования, возвраты и LTV;
- надёжное завершение create/join/leave/remove/cancel/attendance/refund/unpaid
  сценариев во всех проекциях ЛК и Viva;
- один и тот же контракт для текущего и нового ЛК.

Текущая реализация решает отдельные launch-сценарии, но не образует общий
продуктовый контур:

- product ids и допустимые категории подписки находятся в
  `scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js`;
- фазы `ab_leto` находятся в
  `scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js`;
- покупательский лимит вычисляется подсчётом `PAID`/`PAYMENT_PENDING` в
  `scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js`;
- длительность от 90 минут в split-контуре по умолчанию преобразуется в два
  посещения Viva;
- отмена распределена между Viva, Node-RED, Mongo, roster, платежами и
  публикациями;
- успешный HTTP-ответ Viva сам по себе не доказывает итоговое состояние.

## Трассировка требований

| Требование | Архитектурный элемент | Проверка |
|---|---|---|
| Партии, цены, станции, 100 сразу и 7/day | `release_program` + atomic `release_phase` | `E2E-REL-*` |
| Create/join 60/90/120 и глобальный toggle | Versioned entitlement policy | `E2E-POL-001..003` + duration HAR |
| Не более трёх активных услуг | `maxActiveServices` + verified terminal state | `E2E-POL-004..005` |
| Окно 3/4/5 дней | Station-local `bookingWindowDays` | `E2E-POL-006..007` |
| Покупатели и LTV | Purchase/contract/ledger + cohort report | Buyers/LTV API |
| Категории, типы, станции и скидки | Priority-based `benefitRules` | `E2E-BEN-*` |
| Полный cancel/refund/unpaid lifecycle | Durable parent/child operations + outbox | `E2E-LIFE-*` + cancellation HAR |
| Действующие Viva-подписки | Discovery/mapping/dry-run/import links | `E2E-REL-008..009` |
| Перенос в новый ЛК | Shared OpenAPI + server-side policy | Contract/E2E обоих клиентов |

## Решение

### 1. Граница владения

ЦУП является control plane, но не вторым writer бронирований.

- **Subscription Control Plane** хранит типы, станции, партии, policy versions,
  RBAC и audit.
- **Subscription Core** атомарно управляет inventory, contracts, entitlement
  claims, operations и ledger.
- **Booking Service / Viva Adapter** является единственной точкой записи в Viva
  для мигрированных сценариев.
- **VivaCRM** остаётся текущим upstream source of truth для booking, exercise,
  visit balance и refund outcome до отдельного cutover ADR.
- **Games/Groups/Tournaments** владеют своими событиями и roster, но получают
  entitlement/price decision только через Subscription Core.
- **Текущий и новый ЛК** являются клиентами одного `/api/v1` контракта и не
  рассчитывают лимиты, цену или право на действие самостоятельно.

Request-path dual-write запрещён. Внешние и локальные проекции обновляются
идемпотентными operation steps и transactional outbox. Частичный результат
остаётся видимым как операция, требующая reconciliation.

### 2. Канонические сущности

| Сущность | Назначение | Ключевые инварианты |
|---|---|---|
| `subscription_type` | Управляемый тип подписки | Стабильный id; immutable identity; архивирование вместо удаления |
| `subscription_policy_version` | Версия правил | После публикации immutable; `effectiveAt`; `applyTo` |
| `station_offer` | Продажа типа на станции | Station-scoped; Viva product mapping с evidence status |
| `release_program` | План выкладки | Один часовой пояс; draft/published lifecycle |
| `release_phase` | Порция и цена | Неотрицательные counters; price snapshot; упорядоченные фазы |
| `purchase_reservation` | Атомарный резерв | TTL; один terminal outcome; idempotency key |
| `subscription_contract` | Купленная подписка | Ссылка на клиента, тип, станцию, provider contract и policy baseline |
| `entitlement_claim` | Дневной/активный лимит | Уникальный scope key; lease; release только после verified cancellation |
| `subscription_operation` | Сквозная команда | Durable state machine; correlation id; upstream evidence |
| `subscription_ledger_entry` | Деньги и использование | Append-only; reversal ссылается на исходную запись |
| `projection_outbox` | ЛК/roster/publication/analytics | Retry, attempt count, dead-letter, last error |
| `reconciliation_case` | Несовпадение контуров | Причина, observed states, operator decision и audit |

Денежные суммы хранятся в minor units и валюте. Идентификаторы Viva хранятся
как внешние ссылки, а не как канонические id домена.

### 3. Policy version

Policy version содержит как минимум:

```json
{
  "validityDays": 365,
  "createGame": { "enabled": true, "durationsMinutes": [60, 90, 120] },
  "joinGame": { "enabled": true, "minDurationMinutes": 60, "maxDurationMinutes": 120 },
  "maxActiveServices": 3,
  "bookingWindowDays": 3,
  "dailyUsageLimit": 1,
  "activeServiceScope": "SUBSCRIPTION_BENEFIT_ONLY",
  "benefitRules": [],
  "applyTo": "ACTIVE_AND_NEW"
}
```

`bookingWindowDays` трактуется как календарное окно станции: при значении `3`
доступны сегодня, завтра и послезавтра. Сервер сравнивает локальные даты в
таймзоне станции, а не `24 * N` часов.

Изменение policy не пересчитывает уже подтверждённые бронирования. Оно влияет на
новые команды после `effectiveAt`. Массовая отмена существующих броней является
отдельной административной операцией и не может быть побочным эффектом publish.

### 4. Entitlement и ценовая льгота — разные правила

Право создать или присоединиться к подписной игре не смешивается со скидкой на
коммерческое событие.

`entitlementRules` определяют CREATE/JOIN и расходование посещений.
`benefitRules` определяют цену для категорий:

- `GAME`;
- `GROUP_TRAINING`;
- `TOURNAMENT`.

Внутри категории используются канонические external type ids и station ids.
Текстовое сравнение названий запрещено. Типы льгот:

- `FREE_ENTITLEMENT`;
- `FIXED_PRICE`;
- `PERCENT_DISCOUNT`;
- `FIXED_DISCOUNT`;
- `DISABLED`.

В первой версии скидки не складываются. Побеждает одна enabled rule с наибольшим
priority; одинаковый priority пересекающихся правил блокирует publish. Скидка на
обычные игры по умолчанию отсутствует, при этом subscription create/join может
оставаться включённым.

### 5. Программы выкладки

`release_phase.mode`:

- `BULK` — единоразово открыть заданное количество;
- `DAILY_DROP` — ежедневно добавлять лимит до `totalQuantity`;
- `MANUAL` — оператор вручную активирует следующую порцию.

Пример лестницы Котельников:

| Order | Mode | Quantity | Price RUB | Activation |
|---:|---|---:|---:|---|
| 1 | `BULK` | 50 | 19 800 | manual/scheduled |
| 2 | `BULK` | 50 | 23 800 | previous sold out |
| 3 | `BULK` | 50 | 36 000 | previous sold out |
| 4 | `BULK` | 50 | 48 000 | previous sold out |

Сценарий «100 сразу, затем 7 в день» задаётся двумя фазами. Countdown строится
из серверного `nextReleaseAt`; браузерный таймер не является источником истины.

Покупка использует атомарный переход:

```text
AVAILABLE -> RESERVED -> PAYMENT_PENDING -> PAID_PENDING_CONTRACT -> ACTIVE
             |                  |                    |
             +-> EXPIRED        +-> FAILED           +-> PENDING_RECONCILIATION
```

Reservation имеет TTL. Confirm всегда делает readback транзакции и provider
contract. Price, currency, phase id, policy version и station фиксируются в
purchase snapshot. Возврат после активации по умолчанию не возвращает единицу в
продажу; это отдельная `returnToInventoryPolicy`.

### 6. Операции использования

Каждая mutation-команда получает:

- `Idempotency-Key`;
- `X-Correlation-Id`;
- actor и station из доверенного auth context;
- `quoteId` и ожидаемую policy version;
- конкретный target id и command type.

Для существующего события клиент передаёт только opaque target id; station,
category, type, duration, price и startsAt сервер повторно получает из
авторитетного read model/provider. Для создания новой игры клиентские поля
считаются intent и проходят полную серверную валидацию.

Базовая state machine:

```text
REQUESTED
  -> ELIGIBILITY_CONFIRMED
  -> CLAIM_RESERVED
  -> UPSTREAM_PENDING
  -> UPSTREAM_CONFIRMED
  -> LOCAL_CONFIRMED
  -> PROJECTIONS_PENDING
  -> COMPLETED
```

Terminal/exception states:

- `REJECTED` — доменное правило не выполнено до внешней мутации;
- `PENDING_RECONCILIATION` — исход внешней мутации неоднозначен;
- `REPAIR_REQUIRED` — автоматическое восстановление исчерпано;
- `CANCELLED` — команда отменена до внешней мутации.

Сетевой timeout после отправки Viva mutation не запускает слепой повтор.
Сначала выполняется readback по exact booking/exercise/transaction id.

### 7. Семантика отмены и удаления

Одна универсальная команда `DELETE` запрещена. Используются отдельные команды:

- `LEAVE_BOOKING`;
- `REMOVE_PARTICIPANT`;
- `CANCEL_GAME`;
- `UNPUBLISH`;
- `HIDE_FROM_CABINET`;
- `ARCHIVE`;
- `EXPIRE_UNPAID`.

Освобождение entitlement claim возможно только после подтверждения, что exact
booking больше не активен и ожидаемый refund/visit return доказан. Для
subscription-return текущим кандидатом является `SERVICE`, но его request и
response shape остаются evidence-gated до утверждения Golden HAR-паспорта.

Полная отмена игры выполняется как durable parent operation с отдельным child
operation на каждого участника. Игра сначала закрывается для новых join, затем
отменяются booking/refund, после чего обновляются roster, cabinet и publication.
Partial failure сохраняет игру закрытой и создаёт reconciliation case.

### 8. Active services и daily usage

`maxActiveServices` и `dailyUsageLimit` — независимые ограничения.

Рекомендуемый initial scope active service: только booking, в котором применена
эта подписка или её benefit. Услуга становится terminal только после provider
readback состояния `completed/attended/cancelled` и завершения ожидаемого
refund/return. UI-скрытие или локальное удаление не освобождает лимит.

До Golden HAR не фиксируется, сколько Viva visits должна расходовать игра на
90/120 минут. Policy хранит явную таблицу `usageUnitsByDuration`, а Viva adapter
проверяет provider balance до/после. Дневной claim и число provider visits не
обязаны быть одной величиной.

### 9. LTV и audit

Ledger фиксирует:

- purchase gross amount;
- refund/chargeback;
- applied benefit и subsidy amount;
- entitlement usage/reversal;
- contract renewal/expiration;
- provider и local operation ids.

Отчёт показывает отдельно:

- offer LTV по type/station/phase/cohort;
- customer LTV по всем продуктам;
- gross и net revenue;
- D30/D90/D180/D365 и lifetime;
- utilisation, renewal и refund rate.

Прибыль не выводится без подтверждённой модели затрат. Сырые телефоны и provider
tokens в analytics/audit не сохраняются.

### 10. ЦУП и RBAC

ЦУП получает разделы Types, Policies, Release Programs, Buyers, Usage, LTV,
Reconciliation и Audit. Изменения выполняются через draft и impact preview.

Минимальные permissions:

- `subscriptions:read`;
- `subscriptions:catalog:write`;
- `subscriptions:release:write`;
- `subscriptions:refund`;
- `subscriptions:reconcile`;
- `subscriptions:analytics:read`.

Permissions station-scoped. Publish для `ACTIVE_AND_NEW`, refund и ручной repair
требуют reason и отдельной elevated role.

### 11. Подключение существующих подписок

Импорт существующих подписок выполняется как отдельный migration workflow:

```text
READ_ONLY_DISCOVERY
  -> MAPPING_APPROVED
  -> DRY_RUN
  -> APPLY_LOCAL_LINKS
  -> RECONCILED
```

Discovery группирует provider products/contracts по exact external ids и
станциям. Оператор связывает candidate с `subscription_type`; name-scoring не
создаёт mapping автоматически. Apply создаёт только локальные contract links и
baseline policy snapshot, но не изменяет Viva contract. Неизвестные и
неоднозначные продукты остаются quarantined и видны в ЦУП.

После импорта новая версия с `ACTIVE_AND_NEW` может менять право на будущие
действия у действующего контракта. Его срок, исторические покупки и уже
подтверждённые бронирования не переписываются.

## Провайдерные evidence gates

До runtime implementation должны быть подтверждены обезличенными Golden HAR:

1. purchase/activation годового provider product;
2. create и join на 60/90/120 минут с балансом visits до/после;
3. cancellation options и возврат subscription visit;
4. organizer remove и whole-game cancel;
5. group/tournament fixed price или discount;
6. attendance/no-show/write-off;
7. currency/deposit refund и transaction/receipt readback;
8. unpaid expiration и late payment.

Неподтверждённые request fields, endpoint variants и retry semantics не входят в
accepted runtime contract. Подробный паспорт находится в
`architecture-workspace/evidence/subscriptions/GOLDEN_HAR_PASSPORT.md`.

## API boundary

Source contract для текущего и нового ЛК:

`architecture-workspace/openapi/subscriptions/v1/openapi.yaml`.

Frontend сначала запрашивает quote, затем отправляет command. Execute повторно
проверяет действующую policy и возвращает operation. HTTP `202` означает только
принятую durable operation, а не успешную бронь или возврат.

`/subscription-operations` является application-orchestration boundary, а не
владельцем game/group/tournament aggregate. Он резервирует entitlement и
делегирует доменную мутацию соответствующему сервису; Subscription Core не
редактирует `lk_games`, tournament roster или publication напрямую. Полный
game-specific payload остаётся в `/api/v1/games` contract, а subscription
operation связывает его через target/correlation ids.

## Rollout gates

1. Golden HAR-паспорт заполнен и проверен для всех P0 lifecycle-сценариев.
2. Бизнес-решения по usage units, active-service terminal state, discount
   stacking и late payment приняты явно.
3. CUP schema/RBAC/policy publish реализованы без включения runtime enforcement.
4. Inventory concurrency test не допускает oversell последней единицы.
5. Current LK adapter проходит contract tests без frontend business decisions.
6. Cancellation/refund saga проходит active/history/balance readback.
7. Reconciliation dashboard показывает все partial/ambiguous operations.
8. Новый ЛК использует тот же OpenAPI contract.
9. Staging E2E выполняется несколькими tester identities и фиксирует evidence.
10. Отдельные approvals получены для integration, push и deploy.

## Consequences

Положительные:

- цены, партии и права меняются без новых hardcoded plan branches;
- действующие подписки получают управляемые версии правил;
- конкурентные покупки не создают oversell;
- каждая потеря посещения или возврата объяснима по operation/ledger;
- текущий и новый ЛК не расходятся по бизнес-правилам.

Tradeoffs:

- потребуется transactional core и reconciliation worker;
- до миграции сохраняется сложность Viva adapter и legacy projections;
- часть продуктовых правил нельзя завершить без контролируемых HAR-сценариев;
- CUP становится критичным control plane и требует строгого RBAC/audit.

## Rejected alternatives

1. **Продолжать добавлять plan ids и лимиты в Node-RED globals.** Не решает
   версионирование, атомарные партии, station scope и перенос в новый ЛК.
2. **Проверять лимиты только в React.** Обходится прямым API-вызовом и создаёт
   race conditions.
3. **Сделать ЦУП вторым writer Viva/Mongo.** Увеличивает dual-write и число
   частичных состояний.
4. **Считать любой Viva 2xx успехом.** Не доказывает booking/history/balance и
   финансовый outcome.
5. **Автоматически отменять старые брони при policy publish.** Превращает
   конфигурационное действие в массовую внешнюю мутацию.
