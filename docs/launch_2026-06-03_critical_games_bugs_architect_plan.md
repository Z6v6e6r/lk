# Launch Plan — Critical Games Bugs (2026-06-03)

Дата подготовки: 2026-06-03
Область: `src/components/cabinet/*`, `src/components/games/*`, `src/utils/apiClient.ts`, `scripts/nodered_games_nodes/*`

## Source Inputs

- Внешний документ: `/Users/zver/Downloads/баг репорт.md`
- Внутренний debug report: `docs/launch_2026-06-01_split_leave_debug_report.md`
- Кодовая сверка по текущей ветке на 2026-06-03

## Confirmed Status Matrix

| ID | Симптом | Статус | Наиболее вероятный корень |
| --- | --- | --- | --- |
| BUG-01 | Отмена игры из карточки ЛК не возвращает занятия на абонементы | Confirmed by code path | `Cabinet` принимает решение по stale `createdGames` snapshot и может уйти в fallback `apiCancelBooking()` вместо полного `split cleanup` |
| BUG-02 | У организатора кратковременно видна кнопка `Покинуть игру` | Confirmed by code path | `GamesPage` определяет organizer-row слишком узко, только через `detailsOrganizerPlayer` |
| BUG-03 | После нажатия на нерабочую `Покинуть игру` отмена из карточки начинает работать | Confirmed as derived symptom | Открытие details гидратирует более полный game snapshot; карточка затем видит `exerciseId/bookingIds` и уходит в cleanup-path |
| BUG-04 | При выборе `Лето.Падел.Спорт` списывается `Лето.Падел.Дружба` | Confirmed as backend contract risk | Shared split backend не валидирует exact subscription selection end-to-end и преждевременно short-circuit’ит subscription-flow |
| BUG-05 | При отмене игры не возвращаются занятия и другим участникам | Confirmed by code path | Card cancel может не запускать полный cleanup; backend cleanup также имеет fail-open риски при пустых booking/exercise targets |
| BUG-06 | После join игрок до reload виден и в `participants`, и в `waitlist` | Confirmed by code path | Дедуп в `GamesPage` опирается на узкий identity key (`phone` xor `id`) и пропускает одну и ту же сущность в двух списках |
| RC-01 | Invite self-leave без Viva cancel | Closed in current code | `GameJoinPage` теперь делает `/split/leave` fail-fast перед LK patch |
| RC-02 | Timeout cleanup мутирует LK без фактической Viva cancel | Open | `split_cleanup` допускает success-path при пустой booking queue |
| RC-03 | Late payment recovery зависит от потери `transactionId` | Partially open | `transactionId` всё ещё извлекается слишком узко в shared split router |

## Root Causes

### 1. Card cancel relies on stale game snapshot

- `src/components/cabinet/Cabinet.tsx`
- `handleCancelGameBooking()` принимает решение по `createdGames.find(...)`
- При отсутствии у карточки `exerciseId/bookingIds` функция не делает refresh record и уходит в `apiCancelBooking(bookingId)`
- Это не гарантирует отмену split-related bookings для всех участников и не использует общий cleanup-contract

### 2. Organizer detection in details is narrower than organizer detection in permissions

- `src/components/games/GamesPage.tsx`
- `canManagePlayersInDetails` уже использует `isCurrentUserOrganizerOfActiveGame || isCurrentUserOrganizerByDetails`
- Но row-level `isDetailsOrganizerPlayer()` проверяет только key equality against `detailsOrganizerPlayer`
- В момент, когда organizer payload ещё не гидратирован, organizer-row рендерится как обычный participant row

### 3. Split cleanup is fail-open

- `scripts/nodered_games_nodes/fn_split_cleanup_prepare.js`
- `scripts/nodered_games_nodes/fn_split_cleanup_router.js`
- `PARTICIPANT_TIMEOUT` и `GAME_CLEANUP` task могут быть собраны без достаточных Viva targets
- Router считает это завершённым cleanup и может записать LK mutation с `withVivaErrors=false`

### 4. Exact subscription selection is not verified end-to-end

- `src/components/games/GamesPage.tsx`
- `src/utils/apiClient.ts`
- `scripts/nodered_games_nodes/fn_split_create_prepare.js`
- `scripts/nodered_games_nodes/fn_split_join_prepare.js`
- `scripts/nodered_games_nodes/fn_split_router.js`
- UI передаёт выбранный `subscriptionId`, но backend subscription branch short-circuit’ит после booking creation и не проходит строгую product-level validation

### 5. Local roster dedupe is too weak

- `src/components/games/GamesPage.tsx`
- Текущий дедуп использует `getPadelPlayerIdentityKey()` (`phone` first, then `id`)
- Для одного и того же пользователя можно получить разные ключи между pending waitlist row и confirmed participant row

## Architecture Risks

### P0

1. `split cleanup` может архивировать LK без реальных Viva-side effects
2. Payment recovery в split flows всё ещё не authoritative по факту оплаты
3. Exact subscription selection не имеет server-side acceptance guard

### P1

1. `fn_patch.js` остаётся last-writer-wins snapshot patch без revision/CAS
2. Fallback leave/remove path может матчить booking по stale `exerciseId`

## Fix Strategy

### Track A — Frontend / Cabinet / Details

1. В `Cabinet.handleCancelGameBooking()` всегда получать свежий `apiFetchPadelGameRecord(gameId)` перед выбором cleanup vs fallback.
2. Для split/linked games считать cleanup основным путём, а fallback `apiCancelBooking()` оставлять только для truly standalone booking.
3. В `GamesPage` расширить `isDetailsOrganizerPlayer()`:
   - учитывать `detailsOrganizerPayload.id/phone`
   - учитывать `player.source === "ORGANIZER"`
4. В `GamesPage.patchGameRoster()` и близких локальных join-paths перейти на stronger dedupe by shared identity, а не by single key.

### Track B — Backend / Node-RED cleanup

1. `fn_split_cleanup_prepare.js`:
   - не создавать mutating task без Viva targets
   - отдельно маркировать cases `missing_viva_targets`
2. `fn_split_cleanup_router.js`:
   - если нет booking queue и нет exercise target, переводить задачу в fail-safe mode
   - не писать LK mutation как success
3. Для `PARTICIPANT_TIMEOUT` без booking targets не удалять игрока из LK автоматически

### Track C — Backend / shared split router

1. Расширить extraction `transactionId` beyond `id|uuid`
2. Сохранить authoritative `transactionId` в response/metadata
3. Для explicit subscription selection:
   - не допускать silent fallback на другой абонемент
   - при невозможности exact match возвращать error, а не success
4. Убедиться, что create/join используют одинаковую strict policy

## Required Regression Tests

### FE

1. Card cancel refreshes full game record before deciding cleanup path
2. Organizer row never shows `Покинуть игру` for organizer identity
3. Join flow dedupes one user out of `participants` and `waitlist`

### BE

1. `split cleanup` does not mutate LK on timeout without Viva targets
2. `split cleanup` marks missing-target case as Viva error / blocked mutation
3. Shared split router preserves `transactionId` from production-shaped payload
4. Explicit subscription selection does not silently fall back to another plan

## Agent Work Split

### Worker 1 — Cleanup hardening

- Ownership:
  - `scripts/nodered_games_nodes/fn_split_cleanup_prepare.js`
  - `scripts/nodered_games_nodes/fn_split_cleanup_router.js`
  - cleanup-specific tests in `scripts/tests/*`
- Goal:
  - close `RC-02`
  - prevent silent LK mutation without Viva action

### Worker 2 — Cabinet/details UX and roster consistency

- Ownership:
  - `src/components/cabinet/Cabinet.tsx`
  - `src/components/games/GamesPage.tsx`
  - optional shared helper in `src/components/games/rosterSyncReconcile.ts`
  - frontend-focused tests in `scripts/tests/*`
- Goal:
  - close `BUG-01`, `BUG-02`, `BUG-03`, `BUG-06`

### Architect/Main thread

- Ownership:
  - `scripts/nodered_games_nodes/fn_split_router.js`
  - `src/utils/apiClient.ts`
  - split-router tests in `scripts/tests/*`
- Goal:
  - close `RC-03`
  - harden explicit subscription selection for `BUG-04`
  - integrate and review worker changes

## Acceptance Criteria

1. Все новые tests PASS.
2. `npm run nodered:modular:validate` PASS.
3. Relevant targeted tests for split/router/cabinet/details PASS.
4. `BUG-03` disappears as consequence:
   - card cancel works without pre-opening details
5. No code path remains that can mark split cleanup success with zero Viva actions.

## Changed Files

- `docs/launch_2026-06-03_critical_games_bugs_architect_plan.md` — consolidated architect plan and agent TZ for critical games bugs.
