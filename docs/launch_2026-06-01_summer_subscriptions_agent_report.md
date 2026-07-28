# Agent Report: Summer Subscriptions + Split Games (2026-06-01)

Дата контроля: 2026-05-31
Область: `Лето.Падел.Дружба`, `Лето.Падел.Спорт`, split games, Viva roster/booking consistency.

## Поагентный план и результаты

| Агент | Задача | Артефакт/результат | Проверка результата |
| --- | --- | --- | --- |
| Architect / Planner | Разобрать launch scope, user cases, gaps, go/no-go, rollback. | `docs/launch_2026-06-01_summer_subscriptions_architect_plan.md` | Матрица `SUB-*` и `SPL-*`, P0/P1/P2 риски, smoke/monitoring checklist. |
| Debugger | Найти причины жалобы: игрок выходит, но занятие на абонемент не возвращается. | `docs/launch_2026-06-01_split_leave_debug_report.md` | Описаны цепочки `GamesPage`, `GameJoinPage`, `split_leave`, `split_cleanup`, late-payment recovery. |
| Feature Implementer | Закрыть безопасные launch-critical дефекты без широкого refactor. | Node-RED: configurable reservation window и корректные defaults; frontend: fail-fast при невозможности найти Viva booking для отмены. | Source functions синхронизированы в modular flow и legacy/import файлы. |
| Test Engineer | Добавить регрессии на summer purchase/confirm/limit и рядом связанные split сценарии. | `scripts/tests/tournamentSubscription.summer.nodered.test.ts` | Покрыты defaults, clamp, product binding, router fallback, active pending accounting. |
| Reviewer / Critic | Проверить diff на существенные дефекты. | Найден P1: `toInt(undefined, fallback)` давал `0` из-за `Number("")`. | Исправлено в `confirm_resolve`, `purchase_prepare`, `purchase_limit`; добавлены fallback tests. |

## Принятые исправления

1. `confirm_resolve`: убран жесткий `ctx.reservationMinutes = 30`; теперь используется `summer_subscription_reservation_minutes` с default `30` и clamp `5..360`.
2. `confirm_resolve`, `purchase_prepare`, `purchase_limit`: исправлен integer parser, чтобы `undefined`, пустая строка и нечисловое значение возвращали fallback, а не `0`.
3. `purchase_limit`: сохранен default HTTP timeout `20000` и clamp `3000..120000`.
4. `GamesPage`: отмена участника теперь не считается успешной, если в Viva не найден booking target; это предотвращает silent LK-only removal.
5. `GameJoinPage`: invite/self-leave для split-игры теперь сначала вызывает `/split/leave`; LK patch выполняется только после успешной отмены Viva.
6. Node-RED source flow и import артефакты пересобраны/синхронизированы из source functions.

## Проверки

| Команда | Результат |
| --- | --- |
| `npm run nodered:modular:build` | PASS |
| `npm run nodered:modular:validate` | PASS |
| `node --experimental-strip-types --test scripts/tests/tournamentSubscription.summer.nodered.test.ts` | PASS, 8/8 |
| `node --experimental-strip-types --test scripts/tests/tournamentSubscription.summer.nodered.test.ts scripts/tests/splitCleanup.prepare.test.ts scripts/tests/rosterSync.reconcile.test.ts scripts/tests/splitGameExerciseId.test.ts` | PASS, 16/16 |
| `npx eslint scripts/tests/tournamentSubscription.summer.nodered.test.ts scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js` | 0 errors; Node-RED source functions are ignored by current ESLint config |
| `npx eslint src/components/games/GameJoinPage.tsx` | PASS |
| `npm run build` | PASS, prod+dev bundles and release manifests written |
| `rg "ctx\\.reservationMinutes = 30"` in active Node-RED source/import artifacts | No matches |
| Structured scan of `node-red/modular/source.flow.json` and `node-red/modular/imports/*.json` | PASS, 30 summer function-node instances have configurable reservation/fallback parser |

## Остаточные риски

1. `GameJoinPage` now blocks split self-leave without a booking target; старые записи без `bookingId` больше не должны silent-desync, но потребуют repair/операторского разбора.
2. `split_cleanup` still needs hard fail or warning when it is about to mutate roster without any Viva booking target.
3. Late-payment recovery still depends on durable `transactionId`; cases without transaction id need monitoring/repair.
4. Purchase limit is still count-then-write, not an atomic reservation; concurrent purchase attempts can theoretically oversell until an atomic DB guard is added.
5. Viva cancel still uses `refundMethod: "NONE"` in existing Node-RED contract; нужно подтвердить, что именно этот режим возвращает занятие абонемента в Viva, либо изменить контракт.
6. Hard-coded Viva/Keycloak credentials remain in Node-RED functions; this requires secret rotation and migration to secure Node-RED credentials/global config before it is safe to call resolved.
