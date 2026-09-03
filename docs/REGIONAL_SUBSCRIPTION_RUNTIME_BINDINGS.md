# Региональные подписки: DRAFT-привязки runtime

## Граница этапа

Этот документ фиксирует проверенные station ID и серверные ключи счётчиков.
Он не публикует managed policy, не создаёт продукты Viva, не включает продажи
и не активирует использование подписок в LK.

Исторический машиночитаемый sales/runtime DRAFT находится в
`architecture-workspace/evidence/subscriptions/REGIONAL_SUBSCRIPTION_BINDINGS.draft.json`.
В нём `salesEnabled=false` и `usageEnabled=false`: эти поля означают, что сам
DRAFT-артефакт ничего не включает. Он отражает sales product binding Питера и
ХАБа на 2026-08-20, но не текущее состояние ЦУП. Такой файл нельзя использовать
как опубликованную policy или как основание для provider mutation.

Исторические request body, из которых были созданы DRAFT v1, находятся в
`architecture-workspace/evidence/subscriptions/PITER_HUB_POLICY_DRAFT_PAYLOADS.json`.
Read-only аудит production 2026-08-23 подтвердил в ЦУП оба типа и обе v1 в
статусе `DRAFT`; публикаций, provider mappings и SubscriptionInstance нет.
HUB v1 использует устаревший `ALL_STATIONS` и не подлежит публикации.

Актуальный activation packet и точные v2 source pins находятся в
`architecture-workspace/evidence/subscriptions/PITER_HUB_ACTIVATION_PACKET_20260823.json`
и `docs/PITER_HUB_ACTIVATION_PACKET_20260823.md`. Packet подготовлен, но ничего
не применяет.

Проверенное бизнес-требование для Питера и ХАБ: экземпляр подписки начинает
365-дневный срок при первой подтверждённой записи по подписке; если такой записи
нет, он автоматически активируется `2026-10-01T00:00:00+03:00`. Это не
`effectiveAt` общей policy version. Текущий production release ЦУП поддерживает режим
`FIRST_USE_OR_FIXED_DATE`, `activationWindowDays=0`, фиксированную UTC-дату
`2026-09-30T21:00:00.000Z`, зону `Europe/Moscow` и `validityDays=365`.
Piter/HUB v2 candidate формирует полный capabilities payload, но остаётся
заблокированным до canonical dictionary/type evidence, real canonical target
producer, provider preview и отдельного publication gate.

## Проверенные станции Viva

Источник: read-only каталог
`GET https://api.vivacrm.ru/end-user/api/v1/iSkq6G/studios?size=1000`,
проверка 2026-08-19.

| Витрина | selector | Station ID |
| --- | --- | --- |
| Питер | `STATION_LIST` | `1ea77cbf-bc36-49a1-96d6-f35c216a409b` |
| Котельники | `STATION_LIST` | `3b52e87f-33bb-436b-a1e3-19a3b62b4ed2` |
| Падел.Дружба.ХАБ | `STATION_LIST` | точный 25-ID snapshot Viva, закреплённый в managed policy/router |

Для ХАБ `ALL_STATIONS` больше не является допустимым первым runtime-контрактом:
он не фиксирует состав сети на момент публикации. ЛК принимает только точное
множество из 25 reviewed station ID независимо от порядка; отсутствующий или
добавленный ID блокирует действие до новой policy version. Во всех случаях
станция цели берётся только из server-side Viva exercise read, не из браузера.

## Серверные счётчики

| counterKey | inventoryId | Партии | Цены, minor RUB |
| --- | --- | --- | --- |
| `piter_friendship` | `piter_friendship_12m_2026_v1` | 4 × 100 | `1980000`, `2380000`, `3680000`, `5680000` |
| `kotelniki_friendship` | `kotelniki_friendship_12m_2026_v1` | 4 × 50 | `1980000`, `2380000`, `3680000`, `5680000` |
| `network_friendship` | `network_friendship_12m_2026_v1` | общий остаток 1 × 100; дневное окно 10 | `5680000` |

Для `network_friendship` сохраняется существующий общий inventory и уже проданные
экземпляры. Публичный status показывает не больше 10 доступных продаж за календарный
день `Europe/Moscow`, дополнительно ограничивая окно фактическим общим остатком.
Поля `inventory*` сохраняют наблюдаемость общего лимита, продаж и остатка. Дневное
окно активируется только exact boolean global flag
`summer_subscription_ab_leto_20260903_release_enabled=true`; отсутствие или строковое
значение флага сохраняет предыдущий runtime.

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

- локальная операция LK привязана к конкретной услуге; дневные, недельные,
  месячные, future-booking и active-service лимиты считает только атомарный
  aggregate ЦУП;
- создание и присоединение принимают 60, 90 и 120 минут и передают точную
  server-resolved цель в binding reserve ЦУП;
- только sole blocker `ACTIVE_SERVICES_LIMIT_REACHED` переводит split-flow на
  обычную запись `ON_PLACE` за полную стоимость без удаления уже созданной игры;
- бесплатное решение ЦУП резервируется до Viva write и подтверждается только
  после точного Viva read-back;
- решение с доплатой (включая 30%, тренировку и турнир) освобождает резерв и
  остаётся fail closed с
  `MANAGED_SUBSCRIPTION_PROVIDER_PRICING_NOT_CONFIGURED`, пока exact pricing
  contract Viva не подтверждён;
- `/lk/subscription-bookings` распознаёт Питер и ХАБ, после server-side чтения
  упражнения и exact owned `clientSubscriptionId` запрашивает у ЦУП
  `POST /api/internal/subscriptions/runtime-context`;
- ЦУП возвращает только закреплённые за этим клиентом immutable
  `PUBLISHED` policy/instance; ЛК проверяет действие, длительность, станцию и
  точный lifecycle `FIRST_USE_OR_FIXED_DATE` с дедлайном 1 октября, затем LK
  вызывает `POST /api/internal/subscriptions/entitlements/reserve` с тем же
  Bearer и отдельным integration token;
- ЦУП выполняет quote и CAS aggregate в одной majority-journaled транзакции и
  возвращает binding `operationId`; LK сохраняет его до Viva write, вызывает
  `confirm` после read-back и `release` после точного отказа или подтверждённой
  отмены;
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

LK проверяет структурную совместимость policy (60/90/120, станцию и lifecycle),
но не принимает решение по лимитам из старого in-memory evaluator. Binding quote
и изменения счётчиков принадлежат только ЦУП. Повторный reserve с уже
`CONFIRMED` operation никогда не вызывает второй Viva write и остаётся на
read-back reconciliation.

## Обязательные проверки перед активацией

1. Golden HAR/read-back для создания client subscription и первой активации.
2. 60-минутное создание и join 60/90/120 на разрешённой станции.
3. Отказ чужой станции для Питера и Котельников.
4. ХАБ принимает только точный reviewed 25-station set и server-resolved exercise;
   `ALL_STATIONS`, неполный или расширенный список блокируются.
5. Вторая операция дня получает рассчитанную ЦУП доплату; четвёртая активная
   услуга ещё разрешена, а пятая уходит только в full-price path.
6. 90/120 create/join, group и tournament подтверждают точный minor-RUB quote;
   до wiring Viva pricing ни один доплатный reserve не достигает provider write.
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
subscriptions_runtime_api_base_url=https://padlhub.su/api
subscriptions_runtime_context_integration_token=<secret reference>
subscriptions_activation_integration_token=<separate secret reference>
subscriptions_entitlement_integration_token=<separate mutation secret reference>
```

Это Node-RED globals, а не браузерные переменные. Значения не должны попадать в
flow JSON, Git, Tilda, логи или ответы клиенту. Их provisioning, импорт flow и
включение runtime — отдельные этапы с отдельным подтверждением.
