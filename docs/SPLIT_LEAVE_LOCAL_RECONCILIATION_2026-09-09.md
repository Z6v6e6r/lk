# Повторный выход после подтверждённой отмены Viva

Owner: current task. Audience: authenticated LK players using SELF split leave.
Route: CRITICAL / R3, primary implementation with independent reliability/payment-safety review.
Base: `da04bd7` (`origin/main` at branch creation).
Branch: `codex/split-leave-reconcile-20260909`.

## Поведение

Если после подтверждённого выхода синхронизация вернула игрока в состав ЛК без
`membershipId`, `bookingId` и `paymentRef`, повторный SELF leave находит предыдущую
операцию в серверном `lk_game_leave_operations`. Совпадать должны игра, упражнение,
проверенный actor/target, режим SELF, подтверждённая отмена Viva и применение удаления
в ЛК. Клиентский audit/leave marker сам по себе не разрешает изменение данных.

После свежих GET active/history и подтверждения отмены прежних booking IDs создаётся
отдельная локальная операция с `vivaTargetMode=NONE`, привязанная к исходному
`game.updatedAt`. Она удаляет оставшийся roster через существующие CAS/ack/fence.
Успех: HTTP 200, `state=DONE`, «Вы вышли из игры». Повтор после очистки возвращает
проверенный durable receipt без новой отмены. При отсутствии предыдущей операции
обычный первый выход сохраняет прежнее обнаружение и отмену активной брони.

Новая активная запись, неполный/непонятный ответ Viva или изменение snapshot
оставляют восстановление неподтверждённым. Новый booking не отменяется восстановлением.
Фоновые повторы сохраняют исходный snapshot и заново проверяют Viva.

## Границы

- Endpoint: `POST /lk/games/:gameId/split/leave`, только SELF recovery.
- Новых маршрутов, Mongo-нод или связей графа нет; меняются тела 10 function nodes.
- Предыдущая `RETURN_PENDING` операция остаётся отдельной: новый выход не обещает возврат посещений.
- Исторические payment rows не переписываются; новая операция не освобождает дневные лимиты.
- Marker-only actor допускается только к чтению своего durable receipt; активный joinResponse не расширяет его права.
- Изменение не исправляет саму синхронизацию roster и не выполняет массовый repair.
- Stop signal: новая бронь, иной snapshot, неполное доказательство или drift live flow.
- Stop method: отказ от mutation/RETRY_REQUIRED; при релизе — запрет применения при несовпадении preimage.

## Изменённые исходники

В `scripts/nodered_games_nodes/`:

- `fn_split_leave_authorize.js`: узкий lookup прошлой отмены / receipt.
- `fn_split_leave_operation_route.js`: проверка durable proof и безопасный replay.
- `fn_split_leave_router.js`: полные active/history GET, отдельный local-only путь.
- `fn_split_leave_operation_start.js`: сохранение snapshot recovery.
- `fn_split_leave_operation_viva_confirmed.js`: повторная проверка под existing local claim.
- `fn_split_leave_retry_select.js`, `fn_split_leave_retry_hydrate.js`: восстановление контекста и snapshot guard.
- `fn_split_leave_daily_limit_find.js`, `fn_split_leave_daily_limit_route.js`: исключение повторного освобождения лимита.
- `fn_split_leave_game_update.js`: исходный snapshot CAS и сохранение payment history.

`./scripts/tests/splitLeave.router.test.ts` содержит regression cases для всего пути,
повторов, возврата, первого выхода, concurrent rejoin, malformed/partial Viva,
фоновой проверки с другими активными игроками и forged markers.

`./scripts/prepare_split_leave_reconciliation_candidate.mjs` строит function-only
candidate с фиксированным полным live preimage и SHA каждого изменяемого тела.

## Проверки

- Полная критическая матрица из CI + `splitLeave.auth.test.ts`: **519 PASS / 5 SKIP / 0 FAIL**.
  Пять SKIP — существующие optional retained-live fixtures подписочных gateway/candidate;
  они не являются live-проверкой этого исправления.
- Совместимость lifecycle/payment recovery/roster/patch/auth и Node-RED toolchain:
  **192 PASS / 0 FAIL** до последних добавлений receipt; receipt/authorization затем
  проверены в финальной критической матрице.
- `npm run lint`: 0 errors, 387 существующих warnings. Новый candidate script lint: PASS.
- `npx tsc -b --pretty false`: PASS.
- `npm run build` с inert CI URLs: prod + dev PASS (не release artifact для публикации).
- `git diff --check`: PASS.
- Свежая копия live 147: `de6a6b2206476de79564fbec9ad5d41ac8bd6088517c29452f4101d6ed3bb0aa`.
- Modular build/validate LK Games: 345 nodes, 42 HTTP inputs, broken wires/links 0/0.
- Полный scoped candidate: 4798 nodes, 219 routes, только 10 function bodies changed.
  SHA `168cf5bfe922178383b470e1e013a02aac38adbd182c7c9a82d78d9346799dd2`.
- Forward/reverse function-only contracts PASS; altered preimage/HTTP route rejected.
- Независимый review: все выявленные замечания исправлены и проверены.

Локальная проверка:

```bash
node --experimental-strip-types --test scripts/tests/splitLeave.router.test.ts scripts/tests/splitLeave.auth.test.ts
```

Private candidate и contracts: `/private/tmp/lk-leave-reconciliation-final/`.
Fresh source workspace: `/private/tmp/lk-leave-recovery-live-20260909/`.
Raw flows и runtime exports не входят в git.

## Статус этапа

Подготовлено изолированное исправление для проверки. Main не изменён; push, merge,
Node-RED import/restart, deploy, реальные leave/join/booking/refund/data mutations не выполнялись.
CI этого task head и реальный UI/provider postcheck ещё не выполнялись. Для релиза
нужно отдельное разрешение, свежий preimage и штатный reviewed deployment contract.
Структурный reverse contract сам по себе не доказывает rollback новых persisted операций.
