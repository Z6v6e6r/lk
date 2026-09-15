# Инцидент 2026-09-15: превью цены по подписке для групповых и турниров (503)

## Симптом

Клиенты не могли создать/войти в групповую тренировку и турнир: в кабинете
показывалось «Условия подписки не подтверждены» (`src/components/games/subscriptionPricePreview.ts:98`,
состояние `unavailable` асайда превью, которое выставляется, когда запрос
`POST /lk/subscriptions/game-price-preview` не вернул котировки). Запись блокируется
на `GameJoinPage.tsx:1288` и `GamesPage.tsx:14141`, пока выбранный абонемент не в
состоянии `available`.

## Хронология и доказательства

Деплой plan-rules на 147 (PR #86) — 2026-09-15 ~19:05 MSK, рестарт Node-RED 19:05–19:06
(pid 541486). Раздача nginx на 147 для `POST /lk/subscriptions/game-price-preview`:

| час (MSK) | 200 | 503 |
| --- | --- | --- |
| 18:00 | 163 | 9 |
| 19:00 | 31 | 129 |
| 20:00 | 24 | 210 |
| 21:00 | 0 | 31 |

До 19:06 эндпоинт был здоров, после — 85–100 % отказов. Перехват тел ответов на
loopback (nginx → Node-RED, открытый HTTP) дал точные коды:

```
{"error":{"code":"GROUP_DISCOUNT_BACKEND_NOT_READY"}}      ×4
{"error":{"code":"TOURNAMENT_DISCOUNT_BACKEND_NOT_READY"}} ×1
```

Дев-стенд 89 ходит в тот же flow 147 и в 19:00 отдал те же 503 — отдельной
«рабочей дев-версии» ограничений не существует.

## Причина

Патч plan-rules пересобрал тело `lk_subscription_price_preview_20260908_router`
через `previewSources()`. В установленном (до релиза) теле был хвостовой блок

```js
Object.assign(canonical, (() => { … return { identityMoneyOwned, lk1LifecycleInstant, managedExternalEventTypeId }; })());
```

который публиковал три хелпера событийного маршрута. Новая композиция собрала
`canonical` из исходников репозитория, где этих имён в списке корней не было:
определения остались внутри замыкания, но в возвращаемый объект не попали.

Первая же защита роутера

```js
if (eventRoute && typeof canonical.identityMoneyOwned !== 'function') return stop(eventRoute.error + '_BACKEND_NOT_READY');
```

после этого отдавала 503 на **каждое** превью групповой тренировки и турнира;
`canonical.managedExternalEventTypeId` и `canonical.lk1LifecycleInstant` бросили бы
TypeError сразу за ней. Проверка композиции: 30 обращений `canonical.*`, не
экспортированы ровно три перечисленных имени.

Тесты этого не поймали, потому что harness (`scripts/tests/lk1PlanRulesPreview.test.mjs`)
извлекает корни вручную и включал эти три имени, а продовая композиция — нет;
assertion на `canonical.*` отсутствовал.

## Исправление (generation `lk1-preview-event-helpers`)

1. `scripts/patch_nodered_subscription_price_preview.mjs`:
   * `PREVIEW_EVENT_HELPERS = ['identityMoneyOwned', 'lk1LifecycleInstant', 'managedExternalEventTypeId']`
     добавлены в корни извлечения `previewSources()` (и переиспользованы в
     исторической групповой композиции);
   * build-time гейт `assertCanonicalExports()`: каждый `canonical.<name>`, к которому
     обращается тело роутера, обязан быть опубликован замыканием, иначе релиз падает
     на сборке (не в проде);
   * compose-time проверка callable-экспортов расширена на три хелпера.
2. `scripts/patch_live_lk1_preview_exports_hotfix.mjs` — focused-генерация: ровно одно
   поле одного узла. Preimage живого flow `95ff37df…` (4804 узла), тело превью
   `64f67bad…` → `3ac29cf0…`; пиннутся installed-поколение (gateway `ed59d29e…`,
   evaluator `d410acdb…`, split `d93de261…`, join `8b312b97…`, allowance `98229c72…`).
3. `scripts/deploy_nodered_lk1_preview_exports_hotfix_147.sh` + npm
   `nodered:lk1-preview-exports:deploy-147` — CONFIRM_147, чистый main, свежий pull,
   exact-graph контракт на 1 узел/1 поле, бэкапы, readback, smoke, авто-rollback.
4. Тесты: `scripts/tests/lk1PreviewExportsHotfix.test.mjs` (пины, отказ при дрейфе,
   публикация хелперов, гейты обёртки) и регресс-блоки в
   `scripts/tests/lk1PlanRulesPreview.test.mjs` (замыкание публикует все
   `canonical.*`, которые называет роутер; мутация «корни без хелперов» падает с
   `Price preview canonical export is missing: identityMoneyOwned`).
5. Пины `patch_live_lk1_plan_rules.mjs` обновлены на новую композицию (`3ac29cf0…`),
   чтобы историческая генерация оставалась воспроизводимой.

Проверки: `lk1PlanRulesPreview` 23/23, `lk1PreviewExportsHotfix` 6/6,
`lk1PlanRulesRelease` 14/14, свод по resolver/evaluator/matrix/preview/hotfix 63 pass /
0 fail / 1 skip, composition-зависимые файлы 28 pass / 0 fail / 44 skip (снапшот-гейты).

## Остаточные риски

* `PRICE_PREVIEW_DECISION_UNRESOLVED` (одиночный 503 в захвате) — дорегрессионное
  поведение для `eligible:false` с блокером, отличным от `ACTIVE_SERVICES_LIMIT_REACHED`;
  требует отдельного разбора, если его доля в потоке вырастет.
* Сборка фронта в проде — от 2026-09-14 (`52265f6f`), новее main не выкладывалась;
  на этот инцидент она не влияет (отказ серверный), но расхождение стоит закрыть
  обычным фронтовым релизом.
* Откат 147 на `flows-pre-lk1-plan-rules-20260915T190516+0300.json` не выполнялся
  (решение оператора — фикс-форвард); бэкап и helper остаются доступными.

## Второй слой: событийный маршрут после восстановления хелперов

После хотфикса `lk1-preview-event-helpers` (инсталл `d8bbfe27…`, 21:40 MSK) массовый
503 `*_DISCOUNT_BACKEND_NOT_READY` исчез, но событийный маршрут оставался нерабочим.
Разбор живого потока (nginx + перехват тел ответов на loopback, окно 21:41–21:57)
дал четыре остаточных класса, из них три — регрессии того же релиза:

| код / тело | кол-во за 16 мин | происхождение |
| --- | --- | --- |
| `{"quotes":[]}` (200) | 31 | внеконтурные подписки выбрасывались из батча: кабинет показывал «Условия подписки не подтверждены» и блокировал запись |
| `LK1_EVENT_TARIFF_UNVERIFIED` (503) | 27 в превью + 11 в CREATE | проверка тарифа Viva сравнивала `msg.responseUrl` с URL своего запроса, а поле оставалось от предыдущего шага |
| `PRICE_PREVIEW_DECISION_UNRESOLVED` (503) | 9 | до превью доходили блокеры, которые маппился только снятый лимитный код |
| `PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED` (503) | 6 | владение для событий считалось HUB-онли (`identityMoneyOwned`), план-продукты дохли |

Доказательства регрессий: `PRICE_PREVIEW_DECISION_UNRESOLVED` (тело 54 байта) в nginx
не встречается ни разу до 19:05 и появляется с 19:00 (26/91/12 в час); коды
`*_DISCOUNT_BACKEND_NOT_READY` (53/58 байт) — только с 19:00.

### Причина по каждому пункту

1. **Внеконтурная когорта.** Шаг `metadata` фильтровал `ctx.requestedIds` до
   `matched && !legacy`; при пустом остатке роутер отдавал `{"quotes":[]}` с 200, а
   `isSubscriptionEventDiscountQuote`/`matchGroupSubscriptionDiscount` такое не
   принимают, и `GameJoinPage.tsx:1288` / `GamesPage.tsx:14141` блокируют запись.
   Исправлено: контур решает, кого считает managed-оценщик, а не кто видит цену;
   внеконтурные получают обычный тариф со скидкой 0 % (`status: AVAILABLE`,
   `amountMinor === basePriceMinor`), что и означает «контур выключен».
2. **Владение для событий.** `owned` считался через `identityMoneyOwned`, который
   требует ровно HUB-продукт. Теперь HUB по-прежнему идёт через money-identity (мандат
   годовой подписки сохранён), остальные продукты — через продуктовую идентичность,
   которая сама применяет HUB-ограничения для HUB.
3. **Блокеры оценщика.** Аудит LK1-ветки оценщика: лимит активных записей перестал быть
   блокером и стал скидкой, из-за чего размаскировался `USAGE_SNAPSHOT_BUCKET_MISMATCH`
   (у клиента исчерпан лимит активных и не сходится снимок free-минут) — раньше он
   получал 200 `LIMIT_USED`. Маппинг: `USAGE_SNAPSHOT_BUCKET_MISMATCH` и исторический
   `ACTIVE_SERVICES_LIMIT_REACHED` → `LIMIT_USED`; `TARGET_NOT_SERVER_RESOLVED`,
   `EVENT_NOT_INCLUDED`, `LK1_GAME_OVERAGE_ALLOCATION_UNBOUND` → `UNAVAILABLE`; все
   технические коды (`LK1_POLICY_INVALID`, `LK1_PRODUCT_BINDING_INVALID`,
   `USAGE_SNAPSHOT_INVALID`, `BASE_PRICE_*`, `BENEFIT_*`, `PRICE_CALCULATION_OVERFLOW`)
   остаются fail-closed 503.
4. **Провенанс запроса.** `msg.responseUrl` ставит Node-RED на каждый ответ, а шаг
   тарифа сверяет его со своим URL; в цепочке шагов поле оставалось от предыдущего
   запроса, поэтому проверка падала при корректном ответе. Исправлено в обоих путях:
   `delete msg.responseUrl` в `http()` превью и в `prepareHttp` booking-роутера
   (create/join). Дополнительно шаг тарифа теперь пишет `error.details.stage`
   (`request_url|product_identity|product_type|product_amount|amount_ceiling`) и
   наблюдаемую форму (счётчики и значения перечислений, без сумм и имён), а `final`
   отдаёт это в теле 503 — следующая остановка диагностируется по ответу, а не догадкой.
   Решение accept/reject не изменилось.

### Генерация `lk1-event-quotes`

Ровно три узла по одному полю `func`: preview router `3ac29cf0…` → `9b4f69b5…`,
preview final `5312c424…` → `7c822e2b…`, booking gateway `ed59d29e…` → `44073942…`.
Preimage — живой flow `d8bbfe27…` (4804 узла); evaluator, split/join и блок
активации plan-rules не меняются. Обёртка с CONFIRM_147, exact-graph контрактом на три
узла, бэкапами, readback и авто-rollback: `npm run nodered:lk1-event-quotes:deploy-147`.

### Остаточные риски второго слоя

* `USAGE_SNAPSHOT_BUCKET_MISMATCH` остаётся смешанным случаем (дрейф бакета против
  реального «лимит исчерпан»); превью отвечает мягким `LIMIT_USED`, CREATE при этом
  сохраняет собственный fail-closed.
* Второй сайт подготовки HTTP-запроса в booking-узле (managed-runtime активация,
  payload-объект) сохраняет ту же привычку не сбрасывать `msg.responseUrl`; его проверки
  сравнивают поле позитивно (`=== url`) и в этот релиз не входят — отдельная задача.
* `docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md`, на который ссылаются комментарии
  `scripts/lib/lk1PlanRules.mjs` и генераций, в репозитории отсутствует: документ нужно
  восстановить отдельно.
