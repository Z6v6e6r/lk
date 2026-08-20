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
  дневной лимит, затем сохраняет `policyVersion`, `policyDigest` и
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
