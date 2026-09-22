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

## Релизный поезд

Поколение собрано и проверено против **свежего живого флоу** (read-only pull 2026-09-18,
`3ecadce7…`, 4804 узла; тело booking-узла — генерация после `lk1-confirmed-replay-guard`,
`3920bb21…`):

- `scripts/patch_live_lk1_station_exclusions_hotfix.mjs` — focused-генерация
  (`lk1-station-exclusions`): ровно 2 узла / 3 поля — `booking.func`
  (`lk1_subscription_booking_router_20260804`), `booking.initialize` и `preview.func`
  (`lk_subscription_price_preview_20260908_router`). Дельты: смена embedded-модуля и
  `lk1Config`-фрагмента на reviewed-версии, станция во всех шести решениях о контуре
  плюс `exercise` в проекции product identity, writer нового глобала в `initialize`;
  превью пересобирается композицией `previewSources()` на уже пропатченном теле.
  Кандидат: `1b3a77de…`, contract exact-graph принят, узлов не добавлено.
- `scripts/deploy_nodered_lk1_station_exclusions_147.sh` +
  `npm run nodered:lk1-station-exclusions:deploy-147` — guarded apply под
  `NODE_RED_LK1_STATION_EXCLUSIONS_DEPLOY=CONFIRM_147`, чистый main, exact-graph
  контракт, бэкапы, readback, авто-rollback. Постчек (review F6) дополнительно читает
  установленный `initialize` и требует наличие writer’а и ровно reviewed-пары —
  установка без активации больше не может выглядеть зелёной.

Осталось (требует явной авторизации владельца): apply из чистого main и приёмка —
турнир в Сириусе по «Дружбе» без доплаты, турнир вне Сириуса по той же подписке со
скидкой 50 %, РА/Академия/Спорт/ХАБ в Сириусе без изменений. Отдельно: после apply
пины `custody_identity` / активационного манифеста, описывающие установленное
поколение, становятся историческими — их надо перепривязать, если этот пакет ещё
используется.

## Проверки (локально)

- `node --test scripts/tests/lk1SiriusStationLegacy.test.mjs` — 11/11 (вердикт пары, изоляция
  станции и продукта, отсутствие/битый/чужой глобал, форма payload, guarded-запись с readback
  и отказ на чужом prior, проводка всех call-site, writer глобала в генерации, паритет
  gateway↔preview);
- `lk1PlanRulesResolver` 16/16, `lk1PlanRulesPreview` 24/24 (включая новый прогон composed
  роутера: исключённая станция отдаёт pre-rollout тариф, обычная — managed-вердикт),
  `lk1PlanRulesMatrix` / `lk1PlanRulesEvaluator` / `lk1PlanRulesRelease` — 0 fail
  (матрица читает committed `HEAD`, поэтому зелёная только после коммита);
- сводный прогон 32 наборов LK1/preview/событийной оплаты и генераций (с живым
  снапшотом в `LK1_STATION_EXCLUSIONS_LIVE_SNAPSHOT`): **384 pass / 0 fail / 43 skipped**
  (скипы — приватные live-фикстуры, которых нет на этой машине);
- генерация против живого снапшота: `lk1StationExclusionsHotfix` 4/4 — кандидат
  `1b3a77de…`, ровно 2 узла / 3 поля, 0 добавленных, contract exact-graph принят,
  повторное применение отказано по имени;
- ESLint по изменённым файлам — 0 ошибок, `git diff --check` чист;
- новый тест зарегистрирован в `check_10` workflow
  `.github/workflows/lk1-subscription-enforcement.yml`.

## Приёмка и условия GO (независимое ревью 2026-09-18)

Ревью payment-safety (read-only, отдельный агент) по исправленному дифу: **GO WITH
CONDITIONS** — findings F1–F5 и F7 закрыты, F6 закрыт статически. До плоского GO остаются
два условия, оба — операционные (apply/приёмка, а не код):

1. **Runtime-проверка активации.** Постчек обёртки читает установленный `initialize` в
   `flows.json`, но не рантайм-глобал: `initialize`, бросивший «station exclusions prior
   mismatch / readback mismatch», всё равно выложится зелёным и затем запретит плановые
   котировки (а при отсутствующем глобале Сириус продолжит получать 50 %). После apply
   нужно подтвердить именно решение: read-only превью-запрос для пары
   `233c1405-…` × `b2e6a9d4-…` должен вернуть legacy-котировку (0 ₽ / без скидки-доплаты)
   либо в логе Node-RED должны отсутствовать обе строки ошибок writer’а.
2. **In-flight операции до релиза.** Ретрай уже созданной и подтверждённой операции
   (`lk1_ingress_operation_find` → `lk1Finish`) отдаёт **сохранённый** checkout со ссылкой
   на 50 % и правило не переразрешает; операция без сохранённого checkout закрывается
   `LK1_PAYMENT_RECONCILIATION_REQUIRED`. Это свойство «не переоценивать существующую
   операцию», кодом не патчится: нужна операционная сверка когорты CONFIRMED-операций
   пары с `lk1.checkout`/`lk1.transactionId`.

Дополнительно приёмка должна покрыть: (а) карточку турнира в Сириусе — запись по
абонементу без доплаты (событийный маршрут превью для исключённой пары автотестом не
покрыт — остаточный риск ниже); (б) исключённую пару, у которой абонемент отсутствует в
`exercise.availableClientSubscriptions` (поведение обязано совпасть с legacy-продажей до
01.09.2026); (в) сверку из п.2.

Малозначимый остаток ревью: у двух исторических патчеров (`lk1-free-first-event`,
`lk1-plan-money-first-use`) постимидж-пины остались до-станционными — они неприменимы к
своим записанным преimage’ам и падают fail-closed; на путь релиза Сириуса не влияют.

## Остаточный риск

- исключение по станции действует на все категории этой пары, а не только на турниры:
  открытые игры по «Дружбе» в Сириусе возвращаются к legacy-механике (дневной лимит
  механизма A), как было до контура — это соответствует пункту 7 контракта;
- клиенты Сириуса с **годовым ХАБ** по-прежнему получают 50 % на турнир (ХАБ вне
  исключения); их legacy-путь турнир не разрешает вовсе, поэтому решение владельца —
  оставить правило;
- карточка турнира для внеконтурной подписки показывает «Скидка 0 %» на разовом тарифе
  (косметика того же класса, что чинили для групповых в #111): запись по абонементу
  при этом остаётся отдельной кнопкой и работает без доплаты; событийный (турнирный)
  маршрут превью для исключённой пары автотестом не покрыт — это шаг приёмки (а) выше;
- ретрай ранее подтверждённой операции со сохранённым checkout отдаёт старую ссылку на
  50 % до операционной сверки когорты (условие 2 выше).
