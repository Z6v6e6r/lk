# Региональные подписки: DRAFT-привязки runtime

## Граница этапа

Этот документ фиксирует проверенные station ID и серверные ключи счётчиков.
Он не публикует managed policy, не создаёт продукты Viva, не включает продажи
и не активирует использование подписок в LK.

Машиночитаемый DRAFT находится в
`architecture-workspace/evidence/subscriptions/REGIONAL_SUBSCRIPTION_BINDINGS.draft.json`.
В нём `salesEnabled=false`, `usageEnabled=false`, все `providerProductIds=null`
и `subscriptionTypeId=null`. Такой файл нельзя использовать как опубликованную
policy или как основание для provider mutation.

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
| `network_friendship` | `network_friendship_12m_2026_v1` | 1 × 50 | `5680000` |

Для каждой партии требуется отдельный подтверждённый Viva product ID:

```text
summer_subscription_<counterKey>_tier_<N>_product_id
summer_subscription_<counterKey>_tier_<N>_product_name   # optional
summer_subscription_<counterKey>_inventory_id            # optional override
```

Пока ID активной партии отсутствует, status возвращает
`bindingReady=false`, `canPurchase=false`; purchase отвечает fail closed и не
делает Viva-запрос.

## DRAFT правил использования

- общий дневной лимит: одна операция `CREATE_GAME` или `JOIN_GAME`;
- создание: только 60 минут;
- присоединение: 60, 90 или 120 минут;
- add-on для создания 90/120 минут не задан и остаётся заблокированным;
- скидки на групповые тренировки и турниры не заданы и остаются
  заблокированными;
- legacy `/lk/subscription-bookings` распознаёт все три региональных плана и
  отвечает `MANAGED_SUBSCRIPTION_POLICY_REQUIRED`, а не применяет правила
  обычной «Дружбы».

Чтобы включить использование, ЦУП должен опубликовать immutable policy version
с точным `subscriptionTypeId`, station selector и benefit/add-on rules; LK затем
должен связать actor-owned `clientSubscriptionId` с этой версией и подключить
существующий evaluator к claim/state-machine. До этого `usageEnabled=false`.

## Обязательные проверки перед активацией

1. Golden HAR/read-back для создания client subscription и первой активации.
2. 60-минутное создание и join 60/90/120 на разрешённой станции.
3. Отказ чужой станции для Питера и Котельников.
4. Network selector только по server-resolved exercise.
5. Вторая create/join операция в тот же локальный день блокируется.
6. 90/120 create без add-on, group и tournament без benefit rule блокируются.
7. Граница партии при конкурентных purchase-reservation не перепродаётся.
8. Отмена, неоплата, refund и возврат визита подтверждены provider read-back.
