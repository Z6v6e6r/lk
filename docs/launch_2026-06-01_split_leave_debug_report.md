# Debug Report: split leave / невозврат посещения (2026-06-01)

## Контекст и метод
- Инцидент: «при некоторых выходах из игр не возвращается занятие на абонемент».
- Метод: статический разбор цепочек в frontend + Node-RED + Viva API-семантике.
- Runtime-воспроизведение в этом проходе не выполнялось (нет изолированной prod-базы/живых Viva payload в сессии).

## Минимальные корневые причины по коду

### RC-1 (самая вероятная): выход через invite-страницу (`GameJoinPage`) уводит игрока из LK без Viva-cancel
- Файл: `src/components/games/GameJoinPage.tsx`.
- Ключевые места:
  - удаление игрока из локальных списков: строки ~767-768;
  - ветка `target === "decline"`: ~1025-1027;
  - PATCH игры в LK без вызова split-leave: ~1046-1050.
- Проблема:
  - в `GameJoinPage` нет вызова `apiCancelPadelSplitParticipantBookings` перед `apiUpdatePadelGameRecord` для decline-сценария;
  - то есть запись игрока из LK удаляется, а booking в Viva может остаться активным (посещение не возвращено).
- Почему это «иногда»:
  - зависит от точки выхода пользователя: из `GamesPage` (details) cancel есть, из `GameJoinPage` (invite) cancel отсутствует.

### RC-2: timeout-cleanup может считать операцию успешной и мутировать LK даже без фактической отмены booking в Viva
- Файлы:
  - `scripts/nodered_games_nodes/fn_split_cleanup_prepare.js`;
  - `scripts/nodered_games_nodes/fn_split_cleanup_router.js`.
- Ключевые места:
  - сбор timedOut task и bookingIds: ~244-247, ~304-306;
  - task всё равно создаётся и удаляет игрока из `participants/waitlist`: ~269-274, ~298-324;
  - в роутере пустая очередь booking не трактуется как ошибка (переход к finalize): ~520-524, ~775-788, ~839-845;
  - LK patch с `participants/waitlist/leaveEvents` выполняется в `buildPersistSet`: ~621-655.
- Проблема:
  - если у timed-out payment нет валидного `bookingId/bookingIds`, Viva-cancel не вызывается, но состояние LK обновляется как будто cleanup прошёл;
  - это прямой путь к рассинхрону «вышел в LK, но посещение не вернулось в Viva».

### RC-3: late-payment recovery зависит от `transactionId`; при его потере recheck не срабатывает
- Файлы:
  - `scripts/nodered_games_nodes/fn_split_router.js`;
  - `src/utils/apiClient.ts`;
  - `scripts/nodered_games_nodes/fn_split_cleanup_router.js`.
- Ключевые места:
  - transactionId в split payment response формируется через `pickId` (только `id|uuid`): `fn_split_router.js` ~23-25, ~380-384, ~746;
  - клиентский парсер ждёт `transactionId` только в одноимённом поле: `apiClient.ts` ~6669;
  - timeout recheck включается только если transactionId есть: `fn_split_cleanup_router.js` ~534-561.
- Проблема:
  - если Viva возвращает идентификатор не как `id/uuid` (или теряется в маппинге), `transactionId` остаётся `null`;
  - тогда cleanup идёт сразу в cancel-ветку без `GET /transactions/{id}` paid-check;
  - в пограничных кейсах «оплатил поздно» recovery не срабатывает.

## Сценарии (цепочки FE -> BE -> Viva -> LK patch) и точки рассинхрона

### 1) Self-leave

#### 1A. Выход из `GamesPage` (details)
- Frontend action:
  - `handleLeaveCurrentUserFromDetails` (`src/components/games/GamesPage.tsx` ~11610+).
- Backend endpoint:
  - `POST /lk/games/:gameId/split/leave` через `apiCancelPadelSplitParticipantBookings` (`src/utils/apiClient.ts` ~6840+).
- Viva cancel semantics:
  - `fn_split_leave_prepare.js` + `fn_split_leave_router.js`:
  - `GET /clients/{clientId}/bookings/{bookingId}/cancel` (probe), затем
  - `PUT /clients/{clientId}/bookings/{bookingId}/cancel` с `{ refundMethod:"NONE", cancelExercise:false }`.
- LK patch:
  - после `vivaCancellation.ok === true` делается `patchGameRoster` с `leaveEvents` и обновлением `metadata.splitPayment`.
- Где возможен рассинхрон:
  - если booking/cancel не найден -> выход не применяется (ошибка на UI), это скорее fail-fast, не silent-desync.

#### 1B. Выход из `GameJoinPage` (invite)
- Frontend action:
  - `applyDecision("decline")` (`src/components/games/GameJoinPage.tsx` ~740-1076).
- Backend endpoint:
  - только `PATCH /lk/games/:id` (`apiUpdatePadelGameRecord`), без `/split/leave`.
- Viva cancel semantics:
  - отсутствует в этой ветке.
- LK patch:
  - игрок удаляется из `participants/waitlist`, `joinResponses` помечается как `DECLINED`.
- Где возможен рассинхрон:
  - самый прямой silent desync: в LK «вышел», а booking в Viva не отменён.

### 2) Organizer remove
- Frontend action:
  - `handleRemoveParticipantFromDetails` (`src/components/games/GamesPage.tsx` ~11426+).
- Backend endpoint:
  - `POST /lk/games/:gameId/split/leave` (reason `REMOVED_BY_ORGANIZER`).
- Viva cancel semantics:
  - та же `split_leave` цепочка probe+cancel по client booking.
- LK patch:
  - `patchGameRoster` + `leaveEvents` (`ORGANIZER_REMOVED`) + `splitPayment` mark cancelled for player.
- Где возможен рассинхрон:
  - зависит от полноты `bookingId/clientId` в metadata/roster lookup; при ошибке обычно блокируется patch (ошибка), но при обходных UI-сценариях возможны ручные правки состава без Viva-cancel.

### 3) Participant timeout cleanup
- Frontend action:
  - авто-эффект в details/chat (`GamesPage.tsx` ~6940-6988), вызов `apiCleanupPadelGameByOrganizer(... intent:"participant_timeout")`.
- Backend endpoint:
  - `POST /lk/games/split/cleanup`.
- Viva cancel semantics:
  - `fn_split_cleanup_query/prepare/router`:
  - для timed-out payment:
    - при наличии `transactionId` -> `GET /transactions/{id}`;
    - если не paid -> cancel booking (client path или generic fallback);
    - если paid -> восстановление статуса через `recoverPaidTimedOutState`.
- LK patch:
  - через `buildPersistSet` обновляются `participants`, `waitlist`, `metadata.leaveEvents`, `metadata.splitPayment.*`.
- Где возможен рассинхрон:
  - bookingId пустой/потерян -> Viva cancel не выполняется, но LK всё равно чистится;
  - может выглядеть как успешный timeout-cleanup при `withVivaErrors=false`.

### 4) Late payment recovery
- Frontend action:
  - явного отдельного клика нет; срабатывает внутри timeout-cleanup цикла.
- Backend endpoint:
  - тот же `POST /lk/games/split/cleanup`.
- Viva cancel semantics:
  - `GET /transactions/{transactionId}`; если paid -> не отменять booking, а вернуть игрока/статус оплаты.
- LK patch:
  - `recoverPaidTimedOutState` возвращает игрока в `participants/waitlist`, убирает timeout leave-event, ставит `status: PAID` в split payment item.
- Где возможен рассинхрон:
  - отсутствует/потерян `transactionId` -> paid-check пропускается, идёт cancel-ветка;
  - recovery сильно зависит от качества transaction id mapping в split join response.

## Подозрительные файлы и Node-RED узлы

### Frontend
- `src/components/games/GameJoinPage.tsx` (ветка decline без Viva cancel, ~767-768, ~1025-1050).
- `src/components/games/GamesPage.tsx` (leave/remove + timeout effect, ~6940+, ~10198+, ~11426+, ~11610+).
- `src/utils/apiClient.ts` (`apiCancelPadelSplitParticipantBookings`, `normalizePadelSplitPaymentResult`, ~6840+, ~6632+).

### Node-RED functions
- `scripts/nodered_games_nodes/fn_split_leave_prepare.js`
- `scripts/nodered_games_nodes/fn_split_leave_router.js`
- `scripts/nodered_games_nodes/fn_split_cleanup_prepare.js`
- `scripts/nodered_games_nodes/fn_split_cleanup_router.js`
- `scripts/nodered_games_nodes/fn_split_router.js`

### Node-RED flow nodes (из `scripts/patch_nodered_games_flow.mjs`)
- `LK games split leave` (`http in`, id `d4a011b9337a4401`)
- `Prepare split leave booking cancel` (id `d4a011b9337a4402`)
- `Route split leave booking cancel` (id `d4a011b9337a4406`)
- `LK games split cleanup` (`http in`, id `d4a011b9337a4301`)
- `Prepare split cleanup tasks` (id `d4a011b9337a4304`)
- `Route split cleanup action` (id `d4a011b9337a4306`)

## Таблица: симптом -> вероятная причина -> как воспроизвести -> что логировать/мониторить

| Симптом | Вероятная причина | Как воспроизвести | Что логировать/мониторить |
|---|---|---|---|
| Пользователь нажал «Выйти» по invite-ссылке, исчез из состава, но абонемент не вернулся | В `GameJoinPage` decline нет вызова `/split/leave`; только PATCH игры | 1) Войти в split-игру через invite, 2) сделать join по абонементу, 3) снова открыть invite и нажать «Выйти», 4) проверить Viva booking | FE: событие `game_join_decline` + `gameId`, `playerId`, `hadSplitPayment=true`; BE: факт вызова `/split/leave` (должен быть, но сейчас отсутствует); Viva: статус booking до/после |
| Organizer удалил игрока, но посещение не вернулось | В `split_leave` не удалось корректно сопоставить booking/client либо пришёл частичный cancel | 1) Подготовить игрока с нестандартным/частично заполненным splitPayment metadata, 2) удалить из details | Ответ `/split/leave`: `bookingIds`, `bookingSuccess`, `bookingFailed`, `withVivaErrors`, `trace`; FE: `vivaCancellation.ok`, `resolvedBookingIds` |
| Timeout убрал игрока из waitlist/participants, но в Viva booking живой | `fn_split_cleanup_prepare` создал timeout task с пустыми bookingIds; router применил LK patch без Viva-cancel | 1) Создать pending split payment с истекшим deadline и без `bookingId(s)`, 2) открыть details/chat чтобы сработал cleanup effect | Cleanup summary: `mode=PARTICIPANT_TIMEOUT`, `bookingIds`, `bookingSuccessCount`, `bookingFailedCount`, `withVivaErrors`; audit `metadata.splitPayment.lastTimeoutCleanupResult` |
| После «поздней оплаты» игрок не восстановился и посещение/состав разошлись | Нет `transactionId` -> не срабатывает `GET /transactions/{id}` paid-check | 1) Сделать PAYMENT_PENDING запись без transactionId, 2) дождаться timeout, 3) подтвердить оплату поздно, 4) запустить cleanup | В split payment item сохранять `transactionId`, `paymentRef`; trace шага cleanup: наличие `check_timeout_transaction_*`; мониторинг доли timeout-cases без transactionId |
| В cleanup ответе `withVivaErrors=false`, но реальной отмены в Viva не было | Успех определяется по `bookingFailedCount`, а пустая очередь booking не считается ошибкой | Инъекция timedOut item без bookingIds и запуск cleanup | На уровне BE считать/логировать `bookingQueueSize` и флаг `noBookingTargetsButMutatingRoster` |

## Вывод
- Наиболее критичный и воспроизводимый корень инцидента: invite-ветка self-leave (`GameJoinPage`) без Viva cancel.
- Второй по риску: timeout-cleanup допускает «мутацию LK без Viva отмены», если booking ids неполные/потеряны.
- Для late-payment recovery ключевой фактор устойчивости: гарантированное сохранение `transactionId` и прозрачный trace paid-check ветки.

## Статус после исправлений 2026-05-31
- RC-1 закрыт fail-fast исправлением в `GameJoinPage`: split self-leave через invite теперь вызывает `/split/leave` до LK patch и блокируется, если booking target не найден.
- Остаточный риск RC-1: старые/битые split-payment записи без `bookingId` больше не должны silent-desync, но пользователь получит ошибку и потребуется repair/операторский разбор.
- RC-2 и RC-3 остаются актуальными как backend/data risks: их нужно закрывать отдельным изменением в `split_cleanup` и transaction id mapping/monitoring.
