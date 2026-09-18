# LK1: ПРО-тренировки вне подписок и скидок (2026-09-18)

## Что случилось

Обращение по карточке групповой тренировки «ТРЕНИРОВКА ПРО УРОВЕНЬ С/С+» в `/group`:
на «Разовой» показывалась строка «Скидка 100% по подписке «РА»» и цена `0 ₽`, рядом
предлагался пакет «Энергия 5». Скидку давал LK1-контур: продукты «РА»/«Академия» входят в
`LK1_FREE_FIRST_EVENT_PRODUCTS` (`scripts/nodered_lk1_hub_nodes/gateway.js`), то есть первое
групповое занятие дня списывает посещение и стоит 0 ₽, а обычная денежная скидка по правилу
плана — `groupTrainingDiscountPercent = 50`.

## Решение владельца (2026-09-18)

На ПРО-тренировки подписки не действуют: доступна только разовая оплата по полной цене.
Промокоды исключением **не** затронуты.

- Направления: «Тренировка ПРО уровень D/D+/C/C+» — `5505/5506/5507` (тип 605) и
  «Игра+Тренер ПРО уровень D/D+/C/C+» — `5502/5503/5504` (тип 847). Список снят из
  Viva-каталога `tmp/viva-exercise-types.json`.
- Распознавание: id направления либо отдельный токен «ПРО» в названии. Токен обязан быть
  самостоятельным (`/(^|[^a-zа-яё0-9])про([^a-zа-яё0-9]|$)/i`), поэтому «Первая пробная
  тренировка», «Пробная групповая тренировка», «Просто аренда корта», «Аренда со скидкой -
  Профсоюзная» и «Игра в манеже на Профсоюзной» никогда не попадают в правило.

## Правило живёт в одном месте для каждой стороны

| Сторона | Источник | Куда попадает |
| --- | --- | --- |
| Виджет | `src/utils/proTrainingExclusion.ts` | `GroupSchedulePage.tsx`, `FindGamePage.tsx` |
| Node-RED (запись и превью) | `scripts/lib/proTrainingExclusion.mjs` | `hubGatewaySource()` (тело шлюза записи) и канонический closure превью |

Оба файла держат один и тот же список id и один и тот же токен; равенство пинится
`scripts/tests/proTrainingExclusion.test.ts`.

## Что изменено

### Виджет

- `src/utils/proTrainingExclusion.ts` — `PRO_TRAINING_DIRECTION_IDS`, `isProTrainingName`,
  `isProTraining` (принимает и `GroupTrainingSummary`, и сырой Viva-exercise).
- `src/components/group-schedule/GroupSchedulePage.tsx` — `proTrainingSelected`:
  * запрос `/lk/subscriptions/game-price-preview` не отправляется вовсе, а проверка скидки
    сразу считается завершённой (`discountPending` для ПРО принудительно `false`, поэтому нет
    ни ожидания, ни строки «Проверяем скидку по подписке…»);
  * `purchasableProducts` сужается до `checkout.oneTimes` — пакет «Энергия 5» больше не
    предлагается как способ оплатить ПРО-тренировку;
  * `ownedSubscriptions` пуст — кнопок «Записаться по абонементу» нет;
  * ссылка «БЕСПЛАТНО по подписке» и DEV-shadow панель скрыты;
  * под заголовком «Записаться» появляется пояснение, что доступна только полная цена.
  * Секция промокода не тронута.
- `src/components/games/FindGamePage.tsx` — для ПРО-карточки «Игра+Тренер» footer больше не
  обещает `/академия/РА`, остаётся только цена.

### Сервер (Node-RED, source-driven)

- `scripts/lib/proTrainingExclusion.mjs` — новое правило (чистая функция, без I/O и
  глобалов).
- `scripts/lib/eventPaymentSources.mjs` — `proTrainingExclusionSource()` и его встраивание в
  `hubGatewaySource()` рядом с `planRulesSource()`, плюс запрет повторного объявления
  символов в `gateway.js`.
- `scripts/nodered_lk1_hub_nodes/gateway_hooks.js` — гард первым оператором секции
  `HUB_EXERCISE`, то есть до `findOwnedSubscriptions`, до денежного readback, до
  `resolveManagedEnforcementDecision`, до `operation_find` и до любой записи:

  ```js
  if (resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)) {
    return finishError(ctx, 409, "На ПРО-тренировки подписки не действуют: доступна только оплата по полной цене",
      { code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE" });
  }
  ```

  `finishError` 409, а не `lk1Stop`/202: это окончательный отказ, а не «требует сверки».
  Проверка категории обязательна — открытая игра или турнир с «ПРО» в названии сохраняют
  свой контур и скидку.
- `scripts/nodered_subscription_price_preview_nodes/router.js` — в шаге `groupExercise`
  ПРО отвечает пустым успешным списком котировок (`ctx.quotes = []; ctx.done = true;
  ctx.statusCode = 200; return out(4)`), как уже сделано для пустого `requestedIds`.
  Вызов `canonical.isProTrainingExercise` защищён `typeof === 'function'`, чтобы генерация
  со старым canonical-closure не падала на каждой котировке.
- `scripts/patch_nodered_subscription_price_preview.mjs` — `proTrainingEmbedding(declared, booking)`
  встраивает тот же модуль в canonical closure (по образцу `planRulesEmbedding`) **только если
  установленное тело шлюза записи действительно содержит отказ**
  (`PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE`); иначе в closure попадает инертный
  `const isProTrainingExercise = () => false;`. Так превью не может скрыть цену, пока
  шлюз записи всё ещё начисляет льготу: исключение котировки всегда следует за гардом
  записи, а не опережает его. Имя добавлено в `PREVIEW_INJECTED_EXPORTS`/
  `PREVIEW_INJECTED_FUNCTIONS`, поэтому `assertCanonicalExports` и проверка «каждый
  `canonical.*` объявлен» покрывают гард.
- `scripts/patch_live_lk1_hub.mjs` — новый модуль добавлен в provenance-closure
  (`sourceFiles`/`sourceClosureSha256`), потому что `hubGatewaySource()` его встраивает.

### Проверки и CI

- `scripts/tests/proTrainingExclusion.test.ts` — правило на обеих сторонах, отсутствие
  ложных срабатываний на «пробная/Профсоюзная/просто», привязка UI-поведения к источнику.
- `scripts/tests/proTrainingExclusion.nodered.test.mjs` — правило сервера; исполнение
  реального текста `HUB_EXERCISE` в песочнице (managed-план, legacy «Энергия», обычная
  тренировка, турнир с «ПРО» в названии); форма ответа превью; однократное встраивание
  модуля в тело шлюза.
- `package.json` — `npm run test:pro-training-exclusion`.
- `.github/workflows/lk1-subscription-enforcement.yml` — оба файла добавлены в `check_9`
  («critical subscription regression matrix»).

## Проверки (локально)

- `npm run test:pro-training-exclusion` — **53 pass / 0 fail**.
- CI-матрица `check_9` («critical subscription regression matrix») целиком: **917 тестов —
  901 pass, 2 fail, 14 skip**. Оба провала — предсуществующая среда, не это изменение:
  `eventPaymentRoutesUpgrade.test.mjs` → «CLI refuses raw flow export inside Git» и
  `groupEventPaymentUpgrade.test.mjs` → «legacy CLI still rejects repository destination…»
  падают на `realpathSync` из-за пробела в пути воркспейса (`project-fixed%206`, ENOENT);
  оба воспроизводятся на неизменённом воркtree `lk-target-diag-20260917`.
  Скипы — приватные live-фикстуры (например `groupSubscriptionDiscount.backend` без
  `LK_GROUP_DISCOUNT_FLOW_FIXTURE`).
- `node --experimental-strip-types --test scripts/tests/lk1PlanRulesPreview.test.mjs` — 24/24
  (композиция превью; новый тест проверяет, что исключение котировки включается только для
  тела шлюза с гардом, а без гарда композиция остаётся инертной).
- `scripts/tests/groupEventPayment.test.mjs` — 18/18, включая «event preview validates actual
  category…», который исполняет `groupExercise` со стаб-canonical.
- Пинующие наборы вне матрицы: `lk1PlanRulesResolver` + `lk1PlanRulesMatrix` +
  `lk1PlanRulesEvaluator` (38 pass, 1 skip), `lk1FreeFirst*`, `lk1PlanMoneyFirstUseHotfix`,
  `lk1MoneyCohortHotfix`, `lk1MoneySubscriptionValidity`, `subscriptionRejoinGateway`,
  `lk1ConfirmedReplayGuard`, `subscriptionPreviewUsagePatch`, `subscriptionInstanceLimits`,
  `subscriptionVisitLifecycle`, `subscriptionVisitDev`, `lk1EventQuoteRouting`, `lk1Preview*`,
  `lk1EventDiagnosticsHotfix`, `lk1EventQuotesHotfix`, `lk1PlanRulesRelease`,
  `subscriptionCriticalMatrix`, `subscriptionDecisionJourneySource` — 0 fail.
- `npx tsc -b` — PASS; ESLint по изменённым TS-файлам — 0 ошибок.
- `npx vite build --config vite.config.group-schedule.ts` и `vite.config.games.ts` — PASS;
  в `dist/group-schedule.js` есть маркер правила и текст пояснения.

## Осталось для выпуска (в этой сессии не выполнялось)

Изменения внесены в **source** Node-RED; живой флоу на `147` не читался и не менялся, деплой
не выполнялся. Для реального включения нужен отдельный авторизованный CRITICAL-проход:

1. Свежий read-only pull флоу с `147` (`scripts/pull_nodered_source_from_147.sh` +
   `verify_nodered_source_origin.mjs`) — пины установленной генерации в репозитории
   непрозрачны и без pull не проверяемы: `PREVIEW_CANONICAL_SOURCE_SHA256.booking`,
   `scripts/nodered_lk1_hub_nodes/preimages.json`, `HUB_PREIMAGES`.
2. Focused-генерация `scripts/patch_live_lk1_pro_training_exclusions_hotfix.mjs` по образцу
   `patch_live_lk1_station_exclusions_hotfix.mjs`: пины live-флоу и по-узловых preimage/
   postimage, дельты с якорями, `buildExactGraphContract`, отчёт с
   `deploymentPerformed: false`. Дельты: тело
   `lk_subscription_booking_router_20260804.func` (гард первым оператором
   `HUB_EXERCISE`) и `lk_subscription_price_preview_20260908_router.func` (перекомпозиция).
3. **Перепиновка, которую вызывает это изменение.** `previewSources()` теперь всегда
   добавляет в canonical closure либо модуль правила, либо инертную заглушку, поэтому
   каждая ранее зафиксированная postimage-композиция превью изменилась. Перепиновать
   (значения выводятся только из свежего live-преимиджа) нужно: `PLAN_RULES_TARGETS.preview.patchedFuncSha256`
   (`scripts/patch_live_lk1_plan_rules.mjs`), те же константы в
   `patch_live_lk1_event_diagnostics_hotfix.mjs`, `patch_live_lk1_event_quotes_hotfix.mjs`,
   `patch_live_lk1_preview_exports_hotfix.mjs`, `patch_live_lk1_tariff_amounts_hotfix.mjs`,
   `patch_live_lk1_preview_free_first_event_hotfix.mjs`, а также фикстуры, сравнивающие
   композицию побайтово: `scripts/tests/lk1PlanRulesRelease.test.mjs` (нужен
   `LK1_PLAN_RULES_LIVE_SNAPSHOT`) и `scripts/tests/subscriptionInstanceLimits.test.mjs`
   (нужен `LK_INSTANCE_LIMITS_FLOW_FIXTURE`). Оба теста fail-closed и локально скипаются без
   приватных фикстур — то есть рассинхрон поймается, но только на авторизованном проходе.
   Плюс новые `PREVIEW_CANONICAL_SOURCE_SHA256.booking`, `preimages.json`, `HUB_PREIMAGES`.
4. Guarded deploy-script `scripts/deploy_nodered_lk1_pro_training_exclusions_147.sh`
   (`CONFIRM_147`, clean main, независимый exact-graph contract, бэкапы, readback, smoke,
   rollback) и `package.json`-скрипт `nodered:lk1-pro-training-exclusions:deploy-147`.
5. `PLAN_RULES_MODULE_SHA256` / `PLAN_RULES_CONFIG_FRAGMENT_SHA256` /
   `PLAN_RULES_REVIEWED_EVALUATOR_SHA256` (`scripts/patch_live_lk1_plan_rules.mjs`)
   перепиновывать **не** нужно — проверено пересчётом: `lk1PlanRules.mjs`, `lk1Config` и
   `lk1Quote` не менялись.
6. Базовая (не-HUB) генерация `scripts/patch_nodered_subscription_booking_flow.mjs` пишет
   `scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js` без
   встраивания модуля, поэтому при следующей её ревизии гард нужно добавить в её шаг
   `exercise` вместе с `proTrainingExclusionSource()`.

## Остаточные риски

- **Покупка пакета подписки под это занятие.** Продукты из
  `GET /products/subscriptions?exerciseId=…` (source `"subscription"`) уходят из браузера
  напрямую в Viva (`POST https://api.vivacrm.ru/end-user/api/v2/{tenant}/transactions`)
  вместе с `bookingRequests:[{exerciseId}]`, минуя `/lk/subscription-bookings` и, значит,
  минуя проверенный серверный гард. Сейчас этот путь закрывают только виджет (пакет для ПРО
  не показывается) и конфигурация продукта в Viva (ограничение `availableDirections`/
  `availableTypes`); устаревший кэш бандла или прямой вызов API его не встретит. Durable
  исправление — либо провести покупку пакета для групповых тренировок через guarded
  Serv2-путь, либо ограничить продукт на стороне Viva. Отдельная задача.
- **Повтор подтверждённой операции.** Гард стоит в шаге `exercise`; уже подтверждённые
  (`CONFIRMED`) подписочные брони ПРО-тренировок реплеятся из
  `lk_subscription_daily_booking_ops` без повторного чтения упражнения. Требуется отдельное
  продуктовое решение: считать ли такие брони историческими или сверять их данными.
- **Превью и запись расходятся по форме ответа.** Превью отвечает 200 с пустым списком, а
  шлюз записи — 409. Пока виджет скрывает абонементные кнопки для ПРО, пользователь до 409
  не доходит; при прямом вызове API он получит отказ с понятным кодом. Исключение котировки
  включается только вместе с гардом записи (см. `proTrainingEmbedding`), поэтому обратной
  расходимости «цена скрыта, скидка ещё действует» быть не может.
- **Имя как fallback.** Кроме id направления правило читает `direction.name/title`,
  `directionName`, `exercise.title/name`. Новое ПРО-направление, созданное в Viva после
  выверки списка, поймается токеном «ПРО»; направление с другим названием потребует
  расширить список id на обеих сторонах. По каталогу `tmp/viva-exercise-types.json`
  (189 направлений) токен совпадает ровно с шестью ПРО-направлениями, ложных срабатываний
  нет.
- **Промокоды.** Осознанно оставлены; проверка `expectedGroupDiscount` и промо-ветки не
  менялись.
- Изменение источника Node-RED само по себе не влияет на прод до авторизованной генерации и
  apply.

## Границы сессии

Чтение прода, live Node-RED, Mongo, Viva: не выполнялось. Деплой, импорт, рестарт, запись в
данные: не выполнялись. Изменены только файлы репозитория в
`.worktrees/lk-pro-training-exclusions-20260918`.
