# Индивидуальная/сплит тренировка — испанский тренер

Решение владельца от 2026-11-07: для категории
«ИНДИВИДУАЛЬНАЯ/СПЛИТ ТРЕНИРОВКА ИСПАНСКИЙ ТРЕНЕР 🇪🇸»
не действуют скидки и бесплатная запись по любым подпискам.
Остаётся разовая оплата. Отдельные промокоды сохраняют прежний сценарий.
Обычные групповые занятия с испанским тренером и ПРО-тренировки не затронуты.

## Правило и проверка

Клиент и сервер сопоставляют полное название категории после нормализации
регистра, пробелов, пунктуации и флага. Проверяются названия направления,
типа занятия и нормализованного события. ID направления не выдумывается:
публичное расписание Viva не ответило при подготовке изменения.
При переименовании категории нужно обновить правило или добавить ID после
проверки текущего каталога. Тесты проверяют совпадение правил обеих сторон.

- `GroupSchedulePage` не запрашивает котировки, не предлагает имеющиеся
  подписки/Энергию или покупку подписки и не показывает бесплатную запись.
  Даже сохранённые котировки не меняют разовый тариф.
- `FindGamePage` не обещает включённое занятие по подписке на карточке.
- `apiCreateTournamentVivaTransaction` отклоняет подписочный способ и
  подписочную котировку до отправки сетевого запроса.
- Booking gateway `lk_subscription_booking_router_20260804`: `HUB_EXERCISE`
  отказывает по свежему серверному упражнению до legacy, Energy и управляемых
  правил. `lk1Quote` сохраняет отказ при повторной проверке перед записью.
  Код отказа: `SPANISH_TRAINING_SUBSCRIPTION_UNAVAILABLE`, HTTP 409.
- Preview `lk_subscription_price_preview_20260908_router` возвращает пустые
  котировки до чтения подписок, тарифов и лимитов. Композиция встраивает
  правило только при наличии серверного отказа в booking generation;
  прежняя generation получает инертный предикат, как в ПРО-правиле.

Затронуты существующие `/lk/subscription-bookings` и
`/lk/subscriptions/game-price-preview`; форма запроса не меняется.
Flow JSON и import/export файлы не создавались и не редактировались.
Новые тесты включены в существующий обязательный CI job.

## Доставка и откат

Это исходное изменение, не подтверждение работы production. Перед выпуском
нужно прочитать свежий flow 147, проверить точные preimages установленной
booking/preview generation и подготовить узкий кандидат с действующими
проверками композиции. Нельзя импортировать старый снимок или публиковать
только frontend как доказательство серверного запрета.

Откат исходников — revert данного изменения с повторной подготовкой из
актуального flow. Существующие оплаченные записи, созданные операции и
подписки не переписываются. Live-импорт и frontend deploy не выполнялись.

## Локальная проверка

- Обязательный application-набор CI (`check_9`) выполнен локально: 1 354 PASS,
  0 FAIL, 48 SKIP (приватные live fixtures не предоставлялись).
- `npx tsc -b --pretty false`: PASS.
- `npm run lint`: PASS, 0 ошибок / 467 предупреждений.
- `npm run build`: PASS для всех prod/dev bundles с синтетическими публичными
  build URLs (`example.invalid`); эти артефакты не предназначены для публикации.
- Независимый read-only payment/UI review: существенных замечаний нет.
- `npm run nodered:modular:validate`: не выполнен, требуется `--workspace`
  со свежим live flow. JSON не пересобирался.
- Браузерная проверка нужной записи и live E2E не подтверждены.

## Изменённые файлы

- `.github/workflows/lk1-subscription-enforcement.yml`
- `docs/LK1_SPANISH_TRAINING_SUBSCRIPTIONS_20261107.md`
- `scripts/lib/eventPaymentSources.mjs`
- `scripts/lib/spanishTrainingExclusion.mjs`
- `scripts/nodered_lk1_hub_nodes/gateway.js`
- `scripts/nodered_lk1_hub_nodes/gateway_hooks.js`
- `scripts/nodered_subscription_price_preview_nodes/router.js`
- `scripts/patch_nodered_subscription_price_preview.mjs`
- `scripts/tests/groupSubscriptionDiscount.test.ts`
- `scripts/tests/lk1PatriotsFriendship.test.mjs`
- `scripts/tests/lk1PlanRulesPreview.test.mjs`
- `scripts/tests/lk1TopokratyFriendship.test.mjs`
- `scripts/tests/proTrainingExclusion.nodered.test.mjs`
- `scripts/tests/proTrainingExclusion.test.ts`
- `scripts/tests/productionErrorCauses.test.mjs`
- `scripts/tests/spanishTrainingExclusion.test.ts`
- `scripts/tests/topokratyExclusion.test.ts`
- `scripts/tests/tournamentSignup.subscriptionConfirmation.test.ts`
- `scripts/tests/tournamentSubscriptionDiscount.test.ts`
- `scripts/tests/trialGroupFrontend.test.mjs`
- `src/components/games/FindGamePage.tsx`
- `src/components/group-schedule/GroupSchedulePage.tsx`
- `src/utils/spanishTrainingExclusion.ts`
- `src/utils/tournamentSignupApi.ts`
