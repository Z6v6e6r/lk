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
