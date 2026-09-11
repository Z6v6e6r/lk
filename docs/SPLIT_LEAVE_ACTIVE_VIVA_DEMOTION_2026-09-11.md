# Явный выход из игры при живой записи Viva — 2026-09-11

Owner: current task. Audience: авторизованные игроки LK, которые выходят из игры сами (SELF leave).
Route: CRITICAL, payment/booking safety.
Base: `origin/main` `99e7fdd`. Branch: `codex/lk-self-leave-active-viva-20260911`.

## Наблюдаемое

Игрок нажимает «Покинуть игру», видит бесконечный спиннер в составе, выхода не происходит.
В HAR (`выход из игры.har`, 2026-09-11 12:14 UTC, `lk_dev`) — пять одинаковых
`POST /lk/games/pay_db064db0-…/split/leave`, все HTTP 202 с одним телом:

```json
{"ok":false,"state":"RETRY_REQUIRED",
 "operationId":"self-leave:pay_db064db0-…:83756527-…:1mxpt71dfgrnp",
 "message":"В Viva есть действующая запись. Обновите игру перед новым выходом."}
```

Интервалы между ответом и следующей попыткой `1.202 / 2.500 / 5.001 / 10.001` с
совпадают с `SELF_REMOVE_RETRY_DELAYS_MS = [0, 1200, 2500, 5000, 10000]` — один клик даёт
пять попыток. После исчерпания попыток обработчик оставлял `leavePendingMessage`, то есть
неактивную кнопку `Покидает игру` со спиннером, и не показывал ошибку.

## Причина

1. Снапшот игры: участник `83756527-…` остался в `participants` (`CONFIRMED`), его платёж
   `…867c8660…` — `LEFT` с `leaveOperationId …:1mxpt71dfgrnp`, предыдущая операция
   `DONE` с `vivaVerification=active_absent_history_cancelled`. Это включает
   local-reconciliation ветку self-leave (фантом в составе без актуального membership).
2. В Viva при этом есть **новая** активная запись по тому же exercise/клиенту:
   `GET /lk/tournaments/participants?exerciseId=638c0159-…` →
   `09308132-06ba-4f0d-9799-fb681bc27ab2`, `isCancelled: false`, место 2. Снапшот игры
   знает только про отменённую `a4db7d81-…`.
3. `Route split leave booking cancel` (`9878400d518ebcbd`, SHA тела `c9fb27a4…`, live 147
   совпадает с `origin/main`) отказывал на любую активную запись в
   local-reconciliation, включая собственную запись игрока по этому exercise, и просил
   «обновить игру».
4. Клиент не мог это разрешить повторами: ответ детерминированный, следующий запрос не
   менял ни снапшот, ни решение, а по завершении попыток оставался вечный pending без
   ошибки.

## Что изменено

- `scripts/nodered_games_nodes/fn_split_leave_prepare.js`: HTTP-вход помечает контекст
  `foregroundRequest: true`. Фоновые повторы гидратируют контекст из durable-операции и
  этого флага не получают.
- `scripts/nodered_games_nodes/fn_split_leave_router.js`: в local-reconciliation, если это
  явный выход игрока (`foregroundRequest`), режим `SELF`, нет фонового восстановления,
  есть хотя бы одна **атрибутируемая** активная запись по exercise этой игры и нет
  неатрибутируемых записей — контекст «понижается» (`delete ctx.localReconciliation`,
  `reconciliationDemoted`), и выход идёт штатным путём: обнаружение записи, отмена с
  обычным выбором возврата, затем локальное удаление из состава. Фоновое восстановление и
  неатрибутируемые записи по-прежнему отвечают `202 RETRY_REQUIRED` и не меняют данные.
- `src/components/games/GamesPage.tsx`: после исчерпания попыток обработчик больше не
  оставляет спиннер. Он один раз перечитывает игру, при отсутствии игрока в составе
  считает выход состоявшимся, иначе снимает pending-состояние и показывает реальное
  сообщение сервера.
- Новый focused builder
  `scripts/prepare_split_leave_active_viva_demotion_candidate.mjs` (fresh preimage
  `2ace2b60…`, меняет только тела двух function nodes, forward/reverse
  function-only contract).

## Границы

- Endpoint: `POST /lk/games/:gameId/split/leave`, только SELF leave.
- Новых маршрутов, Mongo-нод и связей графа нет: 4799 → 4799 узлов, меняются 2 function bodies.
- Фоновые recovery-повторы (inject «Retry Viva-confirmed split leaves») поведение не меняют.
- Неатрибутируемая активная запись (без exercise/client) по-прежнему останавливает
  восстановление: код не угадывает чужие записи.
- Отмена живой записи использует существующий путь возврата Viva; новых списаний нет.
- Stop signal: отсутствие атрибутируемой записи, изменение снапшота или расхождение preimage.
- Stop method: отказ от mutation/RETRY_REQUIRED без изменения данных.

## Проверки

- `node --experimental-strip-types --test scripts/tests/splitLeave.router.test.ts
  scripts/tests/splitLeave.auth.test.ts`: **100 PASS / 0 FAIL** (включая 4 новых кейса
  демации, фонового отказа, неатрибутируемой записи и unrelated-записей).
- `scripts/tests/gameLeaveCancellation.test.ts`: **5 PASS / 0 FAIL** (включая новый
  кейс «exhausted self leave stops the roster spinner»).
- `scripts/tests/splitLeaveActiveVivaDemotionCandidate.test.mjs`: **3 PASS / 0 FAIL** (пины
  preimage/candidate SHA).
- `scripts/tests/staffPlayerLeave.nodered.test.mjs`, `subscriptionVisitLeaveGuard`,
  `subscriptionVisitWorker`, `subscriptionSessionCache`: **55 PASS / 1 SKIP / 0 FAIL**.
- `tsc -b --pretty false`: PASS.
- `eslint` по изменённым файлам: 0 errors (только существующие warnings).
- `npm run build` (prod + dev bundles): PASS.
- Modular build/validate LK Games из fresh live 147 `2ace2b60…`: 345 узлов, 42 HTTP inputs,
  broken wires/links 0/0.
- Focused candidate: source `2ace2b60…` → candidate `95841d98…`, changed functions 2,
  forward + reverse contract PASS.
- Предсуществующие красные тесты (падают и на чистом `origin/main`, не связаны с diff):
  `gameCancellationConsistency.client.test.ts` → «GamesPage self leave delegates to server…»,
  `splitLeaveProjectionPatch.test.mjs` → пины `fn_split_leave_game_update.js`,
  `lk1DevFrontendRelease.test.mjs` → «DEV offline bootstrap binds immutable baseline…»,
  плюс 5 source-тестов игрового создания/джойна из батча games/cabinet.

## Статус этапа

Изменения подготовлены и проверены изолированно. Commit, push, PR, merge, Node-RED
import/restart, deploy и любые live-мутации не выполнялись. Для реального применения нужен
свежий preimage, явное разрешение и штатный reviewed deployment contract.
