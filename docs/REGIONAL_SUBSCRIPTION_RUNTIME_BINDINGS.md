# Региональные подписки: DRAFT-привязки runtime

## Граница этапа

Этот документ фиксирует проверенные station ID и серверные ключи счётчиков.
Он не публикует managed policy, не создаёт продукты Viva, не включает продажи
и не активирует использование подписок в LK.

Машиночитаемый DRAFT находится в
`architecture-workspace/evidence/subscriptions/REGIONAL_SUBSCRIPTION_BINDINGS.draft.json`.
В нём `salesEnabled=false` и `usageEnabled=false`: эти поля означают, что сам
DRAFT-артефакт ничего не включает. После read-only проверки production
2026-08-20 в нём отражены действующие sales product binding Питера и ХАБ, но
`subscriptionTypeId` остаётся `null`. Такой файл нельзя использовать как
опубликованную policy или как основание для provider mutation.

Точные request body для создания только DRAFT type/policy находятся в
`architecture-workspace/evidence/subscriptions/PITER_HUB_POLICY_DRAFT_PAYLOADS.json`.
Они ещё не отправлялись в ЦУП и не содержат publish/activate request.

Проверенное бизнес-требование для Питера и ХАБ: экземпляр подписки начинает
365-дневный срок при первой подтверждённой записи по подписке; если такой записи
нет, он автоматически активируется `2026-10-01T00:00:00+03:00`. Это не
`effectiveAt` общей policy version. Изолированный кандидат ЦУП добавляет режим
`FIRST_USE_OR_FIXED_DATE`, `activationWindowDays=0`, фиксированную UTC-дату
`2026-09-30T21:00:00.000Z`, зону `Europe/Moscow` и `validityDays=365`.
Опубликованный контракт пока этого режима не содержит, а полный capabilities
payload нельзя формировать до утверждения cancellation/commerce defaults.

## Проверенные станции Viva

Источник: read-only каталог
`GET https://api.vivacrm.ru/end-user/api/v1/iSkq6G/studios?size=1000`,
проверка 2026-08-19.

| Витрина | selector | Station ID |
| --- | --- | --- |
| Питер | `STATION_LIST` | `1ea77cbf-bc36-49a1-96d6-f35c216a409b` |
| Котельники | `STATION_LIST` | `3b52e87f-33bb-436b-a1e3-19a3b62b4ed2` |
| Падел.Дружба.ХАБ | `ALL_STATIONS` | список пуст; цель всегда резолвится сервером |

`ALL_STATIONS` не разрешает доверять `stationId` из браузера. Перед решением
managed-policy станция должна быть получена из server-side Viva exercise read.

## Серверные счётчики

| counterKey | inventoryId | Партии | Цены, minor RUB |
| --- | --- | --- | --- |
| `piter_friendship` | `piter_friendship_12m_2026_v1` | 4 × 100 | `1980000`, `2380000`, `3680000`, `5680000` |
| `kotelniki_friendship` | `kotelniki_friendship_12m_2026_v1` | 4 × 50 | `1980000`, `2380000`, `3680000`, `5680000` |
| `network_friendship` | `network_friendship_12m_2026_v1` | 1 × 100 | `5680000` |

Production-витрины Питера и ХАБ используют по одному подтверждённому годовому
Viva product ID; цена партии задаётся серверной скидкой от его базовой цены.
Tier-specific product ID остаётся разрешённым override, если позже для партии
будет подтверждён отдельный продукт:

```text
summer_subscription_<counterKey>_tier_<N>_product_id
summer_subscription_<counterKey>_tier_<N>_product_name   # optional
summer_subscription_<counterKey>_inventory_id            # optional override
```

Проверенные активные bindings на 2026-08-20:

| counterKey | Viva product ID | Состояние продаж |
| --- | --- | --- |
| `piter_friendship` | `8bf334ba-3050-4017-b40a-7eef2db1eb16` | `bindingReady=true` |
| `network_friendship` | `db7a5250-7369-4f43-8ac5-9111be24bc74` | `bindingReady=true` |
| `kotelniki_friendship` | — | fail closed |

Пока ID активной партии отсутствует, status возвращает
`bindingReady=false`, `canPurchase=false`; purchase отвечает fail closed и не
делает Viva-запрос.

## Реализованный fail-closed маршрут правил

- общий дневной лимит: одна операция `CREATE_GAME` или `JOIN_GAME`;
- создание: только 60 минут;
- присоединение: 60, 90 или 120 минут;
- add-on для создания 90/120 минут не задан и остаётся заблокированным;
- скидки на групповые тренировки и турниры не заданы и остаются
  заблокированными;
- `/lk/subscription-bookings` распознаёт Питер и ХАБ, после server-side чтения
  упражнения и exact owned `clientSubscriptionId` запрашивает у ЦУП
  `POST /api/internal/subscriptions/runtime-context`;
- ЦУП возвращает только закреплённые за этим клиентом immutable
  `PUBLISHED` policy/instance; ЛК проверяет действие, длительность, станцию и
  точный lifecycle `FIRST_USE_OR_FIXED_DATE` с дедлайном 1 октября, дневной
  лимит, затем сохраняет `policyVersion`, `policyDigest` и
  `subscriptionInstanceId` в атомарной операции;
- Котельники отвечают `MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED` и не переходят
  к Viva mutation;
- ЛК1 и ЛК2 используют тот же split create/join router и один шлюз
  `/lk/subscription-bookings`, поэтому отдельной клиентской реализации правил
  нет.

Код маршрута готов, но использование остаётся выключенным до отдельного этапа:
нужно создать проверенные provider mappings/instances из Viva read-back,
опубликовать immutable policies Питера и ХАБ и включить runtime feature flags.
До этого `usageEnabled=false` и запросы завершаются fail closed.

Изолированный кандидат маршрута выполняет переход
`PENDING_ACTIVATION -> ACTIVE` только после того, как точная запись появилась в
Viva read-back. До любой Viva mutation он требует отдельный server-side global
`subscriptions_activation_integration_token`. После read-back ЛК передаёт в ЦУП
точные `subscriptionInstanceId`, `clientSubscriptionId`, `providerBookingId` и
ожидаемую ревизию экземпляра; ЦУП выполняет CAS и атомарно пишет operation,
ledger и outbox. Если ЦУП временно недоступен, запись Viva не повторяется:
локальная операция остаётся с `activationState=PENDING`, а следующий запрос по
той же подтверждённой записи повторяет только активацию.

Автоматическая активация 1 октября реализована отдельным выключенным по
умолчанию воркером ЦУП. Он требует provider-instance evidence и read-back,
актуальный на момент дедлайна; без них экземпляр остаётся
`PENDING_ACTIVATION`, а ошибка попадает только в агрегированную метрику. Ни
публикация policy, ни создание/изменение Viva-подписок, ни включение флагов в
этот кандидат не входят.

Продажа годовых Питера и ХАБа дополнительно должна останавливаться до Viva
transaction, если точная карточка продукта допускает автоактивацию раньше
1 октября 2026 года или не подтверждает строгие `365` дней / `365` визитов.
Контракт и dry-run коррекции уже активированного экземпляра описаны в
`docs/REGIONAL_SUBSCRIPTION_LIFECYCLE_CORRECTION.md`.

Поддерживаемая первая версия policy ограничена безопасным счётчиком: одна
единица на 60/90/120 минут, `dailyUsageLimit=1`, без weekly/monthly/future и
active-service ограничений. Если ЦУП опубликует пока неподдерживаемый счётчик,
ЛК ответит `MANAGED_SUBSCRIPTION_POLICY_UNSUPPORTED` до Viva/Mongo mutation.

## Обязательные проверки перед активацией

1. Golden HAR/read-back для создания client subscription и первой активации.
2. 60-минутное создание и join 60/90/120 на разрешённой станции.
3. Отказ чужой станции для Питера и Котельников.
4. Network selector только по server-resolved exercise.
5. Вторая create/join операция в тот же локальный день блокируется.
6. 90/120 create без add-on, group и tournament без benefit rule блокируются.
7. Граница партии при конкурентных purchase-reservation не перепродаётся.
8. Отмена, неоплата, refund и возврат визита подтверждены provider read-back.
9. Недоступность ЦУП после Viva read-back возвращает retryable `202`, а повтор
   не создаёт вторую запись Viva.
10. На дедлайне воркер активирует только экземпляр с read-back не старше
    дедлайна; отсутствующее доказательство оставляет экземпляр pending.
11. `activationDays=0`, отсутствующие lifecycle-поля или строковые числа в
    карточке регионального Viva-продукта блокируют checkout до создания
    транзакции.

## Candidate-only globals LK

```text
subscriptions_runtime_api_base_url=https://<cup-host>/api
subscriptions_runtime_context_integration_token=<secret reference>
subscriptions_activation_integration_token=<separate secret reference>
```

Это Node-RED globals, а не браузерные переменные. Значения не должны попадать в
flow JSON, Git, Tilda, логи или ответы клиенту. Их provisioning, импорт flow и
включение runtime — отдельные этапы с отдельным подтверждением.
