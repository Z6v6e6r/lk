# LK1: исключение станции Сириус для «Лето.Падел.Дружба» (2026-09-18)

## Что случилось

Обращение поддержки: в Сириусе клиенты записываются на турнир по абонементу
«Дружба», и запись требует доплаты 50 %.

Причина не в самой продаже, а в покрытии LK1-контура:

- страница Сириуса продаёт **тот же** Viva-продукт, что и базовая «Лето.Падел.Дружба»
  (`b2e6a9d4-53b5-4f79-87ec-3fb076381e9b`): `readSiriusFriendshipConfig` при отсутствии
  глобала `summer_subscription_sirius_friendship_product_id` берёт productId базового
  плана (`scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js`);
- этот продукт входит в `subscriptions_lk1_plan_rules` с `enforceFrom = "2026-09-01"` и
  `tournamentDiscountPercent = 50`, поэтому сентябрьская продажа Сириуса попадает в
  контур: турнир считается скидкой 50 % (то есть доплата), посещение не списывается;
- годовой «Падел.Дружба.ХАБ» (`db7a5250-…`) в контуре всегда, без гейта по дате продажи;
- в `LK1_FREE_FIRST_EVENT_PRODUCTS` ни «Дружбы», ни ХАБ нет, поэтому «первое событие дня
  бесплатно» на них не распространяется.

При этом пункт 7 контракта запуска («sirius … не трогаем, остаётся legacy») и карточка
плана Сириуса (`SIRIUS_FRIENDSHIP_FEATURES`: «участие в турнирах ПадлхАБ» — включено)
говорят обратное. В legacy-таблице `PLAN_CATEGORIES` для `friendship` разрешены
`open_game` и `tournament`, то есть до контура турнир по этой подписке проходил со
списанием посещения и без доплаты.

## Решение владельца (2026-09-18)

Исключение **по станции**: пара «станция Сириус × продукт Лето.Падел.Дружба» остаётся на
legacy-пути, остальные продукты и остальные станции не меняются.

- Станция: `233c1405-1eac-40de-8ec6-1cf7e24c9276` («Сочи», пгт Сириус) — единственная
  станция Сириуса в реестре (`scripts/nodered_onboarding_nodes/fn_onboarding_stations.js`).
- Продукт: `b2e6a9d4-53b5-4f79-87ec-3fb076381e9b` («Лето.Падел.Дружба»).
- Годовой ХАБ и промо-«Дружба» в исключение **не** входят: у ХАБ legacy-категории пусты
  (`network_friendship: []`), поэтому исключение не сделало бы турнир бесплатным, а
  заблокировало бы его.

## Механика

Новый глобал `subscriptions_lk1_station_exclusions` (форма заморожена, fail-closed):

```json
{ "formatVersion": 1,
  "exclusions": [ { "stationId": "<uuid>", "productIds": ["<uuid>", "..."] } ] }
```

- пустой/отсутствующий глобал = исключений нет (контур работает как раньше), не ошибка;
- нечитаемый или неверной формы глобал = `LK1_STATION_EXCLUSIONS_INVALID` (fail-closed);
- исключение срабатывает **только** для продукта, у которого уже есть правило, и только
  по станции цели записи; продукт без правила остаётся `matched: false`;
- вердикт исключения — тот же `legacy`, что даёт дата продажи: `{ matched: true,
  legacy: true, stationLegacy: true, stationId, productId, source, planKey }`, без `rule`;
- дата продажи для исключённой пары не запрашивается: инстанс без разбираемой даты
  остаётся legacy, а не уходит в `SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED`/202;
- механика единая для HUB и plan-правил (сейчас исключён только plan-продукт «Дружбы»).

Реализация: `scripts/lib/lk1PlanRules.mjs` (`normalizeStationExclusions`,
`resolveLk1Rule({ …, stationId, stationExclusions })`, `lk1ReadStationExclusions`) и
`scripts/lib/lk1StationExclusionsTransition.mjs` (desired-полезная нагрузка и
guarded-запись с readback для `initialize` узла).

Станция обязана доезжать до **каждого** решения о контуре, иначе превью и запись
разойдутся:

| Точка решения | Где | Станция |
|---|---|---|
| Quote записи | `scripts/nodered_lk1_hub_nodes/gateway.js` (`lk1Quote`) | `exercise.studio.id` / `studioId` |
| Денежный мандат | там же (`lk1_money_owned_subscriptions`) | то же |
| Переразрешение правила на checkout | там же | `ctx.lk1.target.stationId` / `ctx.studioId` |
| Проекция product identity | `scripts/nodered_subscription_product_nodes/gateway.js` (`identityMoneyOwned`) | `exercise.studio.id` / `studioId` |
| Превью: шаг metadata и цена инстанса | `scripts/nodered_subscription_price_preview_nodes/router.js` (`previewRule`) | `ctx.target.stationId` |

Композиция превью публикует reader через `PREVIEW_INJECTED_EXPORTS`
(`scripts/patch_nodered_subscription_price_preview.mjs`), а `hubGatewaySource()`
(`scripts/lib/eventPaymentSources.mjs`) проверяет, что модуль объявляет новые символы
ровно один раз.

## Что осталось до прода

Правка source сама по себе продакшн не меняет. Нужен штатный релизный поезд:

1. свежий pull живого флоу 147 в приватный внешний workspace (`nodered:modular:pull-147`);
2. пересборка поколения: `initialize` узла `lk_subscription_booking_router_20260804`
   должен дописать writer `subscriptions_lk1_station_exclusions`; пере-пины
   `PLAN_RULES_MODULE_SHA256` / `PLAN_RULES_CONFIG_FRAGMENT_SHA256` и постимиджей
   (gateway func+initialize, preview) в `scripts/patch_live_lk1_plan_rules.mjs`;
   проверка exact-graph контракта;
3. rebind `candidate_binding` / `custody_identity` / активационного манифеста (5 sha);
4. apply на 147 под CONFIRM_147 с бэкапами, readback и авто-rollback, затем приёмка:
   турнир в Сириусе по «Дружбе» проходит без доплаты, турнир вне Сириуса по той же
   подписке остаётся со скидкой 50 %, РА/Академия/Спорт в Сириусе не изменились.

## Проверки (локально)

- `node --test scripts/tests/lk1SiriusStationLegacy.test.mjs` — 10/10;
- `node --test scripts/tests/lk1PlanRulesResolver.test.mjs` — 16/16;
- `node --test scripts/tests/lk1PlanRulesPreview.test.mjs scripts/tests/lk1PlanRulesMatrix.test.mjs
  scripts/tests/lk1PlanRulesEvaluator.test.mjs` — 46/46 (матрица читает committed `HEAD`,
  поэтому зелёная только после коммита);
- новый тест зарегистрирован в `check_10` workflow
  `.github/workflows/lk1-subscription-enforcement.yml`.

## Остаточный риск

- исключение по станции действует на все категории этой пары, а не только на турниры:
  открытые игры по «Дружбе» в Сириусе возвращаются к legacy-механике (дневной лимит
  механизма A), как было до контура — это соответствует пункту 7 контракта;
- клиенты Сириуса с **годовым ХАБ** по-прежнему получают 50 % на турнир (ХАБ вне
  исключения); их legacy-путь турнир не разрешает вовсе, поэтому решение владельца —
  оставить правило;
- карточка турнира для внеконтурной подписки показывает «Скидка 0 %» на разовом тарифе
  (косметика того же класса, что чинили для групповых в #111): запись по абонементу
  при этом остаётся отдельной кнопкой и работает без доплаты.
