# LK1: ПРО-тренировки вне подписок и скидок (2026-09-18)

## База ветки

Ветка `codex/lk-pro-training-exclusions-generation-20260918` уложена **поверх PR #113**
(«Сириус остаётся legacy для „Лето.Падел.Дружба“», ветка
`codex/lk1-sirius-station-legacy-20260918`, `0bcda580`), по решению владельца: серверный
пакет ПРО строится на готовом паттерне focused-генерации и guarded-deploy. Все три коммита
ПРО перенесены cherry-pick'ом; конфликты были только в `docs/WORKLOG.md` (обе записи
сохранены) и в списках `PREVIEW_INJECTED_*` (станционные и ПРО-имена объединены).
После слияния #113 ветку нужно перенацелить на `main`.

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
- На уложенной ветке (base #113) дополнительно: `lk1StationExclusionsHotfix` 4/4 (снапшот-тест
  генерации «Сириус» после перепривязки preview-postimage), `lk1SiriusStationLegacy` 12/12,
  `lk1PlanRulesResolver` 16/16, `lk1PlanRulesMatrix` 10 pass/1 skip, `lk1PlanRulesRelease`
  7 pass/7 skip, `lk1PlanRulesPreview` 25/25, `groupEventPayment` 18/18, `npm run test:pro-training-exclusion`
  54/54, `npm run lint` 0 ошибок.

## Осталось для выпуска (в этой сессии не выполнялось)

Изменения внесены в **source** Node-RED; живой флоу на `147` не читался и не менялся, деплой
не выполнялся. Для реального включения нужен отдельный авторизованный CRITICAL-проход:

1. Свежий read-only pull флоу с `147` (`scripts/pull_nodered_source_from_147.sh` +
   `verify_nodered_source_origin.mjs`) — пины установленной генерации в репозитории
   непрозрачны и без pull не проверяемы: `PREVIEW_CANONICAL_SOURCE_SHA256.booking`,
   `scripts/nodered_lk1_hub_nodes/preimages.json`, `HUB_PREIMAGES`.
2. **Focused-генерация — сделана:** `scripts/patch_live_lk1_pro_training_exclusions_hotfix.mjs`
   (2 узла / 2 поля: booking `func`, preview `func`; пины upstream-флоу и postimage, дельты с
   якорями «после проверки identity упражнения» и «перед шагом exercise», `buildExactGraphContract`,
   отчёт с `deploymentPerformed: false`). Она **уложена поверх постобраза генерации «Сириус»**:
   upstream `1b3a77de…` = постобраз `patch_live_lk1_station_exclusions_hotfix.mjs`, поэтому
   порядок apply — сначала «Сириус», потом ПРО; патчер отказывается работать на до-станционном
   флоу. Проверено на локальном снапшоте: кандидат `bcc9fd6b…`, 0 добавленных узлов,
   booking `0211ba40…`, preview `1cdeddc3…`, `scripts/tests/proTrainingExclusionHotfix.test.mjs`
   4/4.
3. **Перепиновка, которую вызывает это изменение.** Любая правка `router.js`/`previewSources()`
   меняет композицию узла превью, поэтому postimage-константы генераций нужно перепривязывать
   осознанно.
   - **Сделано в этой ветке:** `STATION_EXCLUSIONS_TARGET.patchedPreviewFuncSha256` в
     `scripts/patch_live_lk1_station_exclusions_hotfix.mjs` перепривязан на `df5c4ba1…`.
     Значение пересчитано из свежего read-only pull (`3ecadce7…`, 4804 узла),
     которым пользовалась генерация «Сириус», и подтверждено её снапшот-тестом
     (`lk1StationExclusionsHotfix` 4/4). Booking-postimage этой генерации не изменился
     (`fc1ca544…`), затронут только узел превью.
   - **Остаётся при переигрывании исторических генераций** (они уже перекрыты более новыми
     поколениями и падают fail-closed; их равенство-тесты локально скипаются без приватных
     фикстур): `PLAN_RULES_TARGETS.preview.patchedFuncSha256` в `patch_live_lk1_plan_rules.mjs`
     и те же константы в `patch_live_lk1_event_diagnostics_hotfix.mjs`,
     `patch_live_lk1_event_quotes_hotfix.mjs`, `patch_live_lk1_preview_exports_hotfix.mjs`,
     `patch_live_lk1_tariff_amounts_hotfix.mjs`, `patch_live_lk1_preview_free_first_event_hotfix.mjs`,
     а также побайтовые фикстуры `scripts/tests/lk1PlanRulesRelease.test.mjs`
     (`LK1_PLAN_RULES_LIVE_SNAPSHOT`) и `scripts/tests/subscriptionInstanceLimits.test.mjs`
     (`LK_INSTANCE_LIMITS_FLOW_FIXTURE`).
   - **На авторизованном проходе:** свежие `PREVIEW_CANONICAL_SOURCE_SHA256.booking`,
     `preimages.json`, `HUB_PREIMAGES` для новой генерации.
4. **Guarded deploy-обёртка — сделана:** `scripts/deploy_nodered_lk1_pro_training_exclusions_147.sh`
   (`NODE_RED_LK1_PRO_TRAINING_EXCLUSIONS_DEPLOY=CONFIRM_147`, чистый main == origin/main,
   свежий pull, node/field-allowance, независимый exact-graph contract через
   `prepare_exact_graph_contract.mjs`, бэкапы, readback установленного флоу, постчек маркеров
   `PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE` + модуль в теле записи и настоящий предикат в
   превью, smoke LK-backend, авто-rollback) и `package.json`-скрипт
   `nodered:lk1-pro-training-exclusions:deploy-147`. Локально проверено: независимый contract
   даёт `sourceSha256 1b3a77de…`, `candidateSha256 bcc9fd6b…`, `changedNodeCount 2`,
   `addedNodeCount 0`, `allowedChanges` = booking:func + preview:func; постчек-логика
   симулирована на подложном `flows.json` (пропуск отказа, пропуск вызова и инертная заглушка
   в превью — отказ).
5. **Осталось:** свежий read-only pull `147` на проходе apply (upstream-пин должен
   воспроизвести `1b3a77de…`; иначе — осознанная перепривязка) и явное CRITICAL-разрешение
   на apply с порядком «станция → ПРО».
6. `PLAN_RULES_MODULE_SHA256` / `PLAN_RULES_CONFIG_FRAGMENT_SHA256` /
   `PLAN_RULES_REVIEWED_EVALUATOR_SHA256` (`scripts/patch_live_lk1_plan_rules.mjs`)
   перепиновывать **не** нужно — проверено пересчётом: `lk1PlanRules.mjs`, `lk1Config` и
   `lk1Quote` не менялись.
7. Базовая (не-HUB) генерация `scripts/patch_nodered_subscription_booking_flow.mjs` пишет
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
