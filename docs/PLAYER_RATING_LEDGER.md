# Канонический рейтинг игроков в ЦУП

## Назначение

ЦУП становится владельцем рейтинга игрока. Viva на переходном этапе получает только проекцию текущего значения и после завершения миграции перестаёт хранить рабочий рейтинг.

Физически используются две коллекции в существующей MongoDB:

- `player_rating_state` — одно актуальное каноническое состояние на игрока;
- `rating_events` — неизменяемые события изменения рейтинга.

`player_ratings` временно сохраняется как compatibility projection для старых readers/writers и не является источником истины.

`lk_game_rating_events` не является каноническим журналом: это временно сохраняемый lifecycle-документ результата игры.

## Production status 2026-07-10

- исходный cutover: `player_ratings` 81/81 `CUP_CANONICAL`, у каждой строки есть `lastEventId`;
- `rating_events`: 81 initial-import event, state/event mismatches — 0;
- identity duplicates — 0; одна legacy predecessor-строка сохранена в `player_ratings_duplicate_archive`;
- игровой writer `rating_events -> player_ratings -> Viva` активирован на `lk-primary-147`; следующий rollout меняет цепочку на `rating_events -> player_rating_state -> player_ratings -> Viva`;
- `/lk/onboarding/level` проверяет каждый Viva PUT и возвращает `502/FAILED` при partial error;
- server backup: `/root/.node-red/flows.json.backup-rating-p0-20260710T103846Z`.

## Инварианты

1. Любое эффективное изменение сначала создаёт событие, затем обновляет состояние.
2. Событие вставляется через `$setOnInsert` с детерминированным `_id`; повторная доставка не меняет историю.
3. `player_rating_state.lastEventId` указывает на событие, сформировавшее текущее значение.
4. Новые writers не имеют права менять `ratingNumeric` без `rating_events`.
5. Основная идентичность — `clientId`; `phoneNorm` остаётся переходным alias и требует проверки дублей.
6. В событии всегда фиксируются источник и actor. Системные и административные изменения не маскируются под игрока.
7. Состояние можно восстановить из журнала событий; журнал нельзя восстанавливать из состояния.

## CUP-first read и Viva bootstrap

1. Если `player_rating_state` найден, используется только значение ЦУП; Viva в read-path не вызывается.
2. Если canonical state отсутствует, разрешён lookup в Viva по точному `clientId` или нормализованному телефону.
3. Найденное значение сначала фиксируется как `RATING_BOOTSTRAPPED_FROM_VIVA` и новый `CUP_CANONICAL` state, затем возвращается потребителю.
4. Viva fallback не имеет права перезаписывать уже существующий state, даже если значения расходятся.
5. Отсутствующий уровень не заменяется нулём или дефолтом.

Для v2 game-result worker и частого `result/state` read-path Viva fallback
запрещён: worker при неполном `player_rating_state` завершается
`RATING_STATE_INCOMPLETE`, а восстановление baseline выполняется только отдельным
bounded dry-run/apply процессом. Переключение auth read-path на CUP описано в
[`RESULT_AUTH_CUP_MIGRATION.md`](RESULT_AUTH_CUP_MIGRATION.md).

Ручное изменение выполняется как canonical command в ЦУП: immutable event → CAS state update → Viva projection outbox. Ошибка Viva не откатывает state ЦУП и показывается как отдельный projection status.

## Контракт `player_rating_state` v1

Обязательные поля мигрированного состояния:

| Поле | Значение |
|---|---|
| `schemaVersion` | `1` |
| `ownership` | `CUP_CANONICAL` |
| `playerKey` | `client:<id>`, временно `phone:<phone>` |
| `clientId` | стабильный id Viva/ЦУП, когда известен |
| `phoneNorm` | временный alias для legacy flows |
| `ratingNumeric` | актуальное числовое значение |
| `rating` | актуальный уровень/grade |
| `lastEventId` | `_id` последнего канонического события |
| `lastEventType` | тип последнего события |
| `lastEventAt` | время последнего события |
| `lastChangedBy` | actor, выполнивший изменение |
| `updatedAt` | время обновления состояния |

## Контракт `rating_events` v1

Событие содержит:

- `_id`, `id`, `idempotencyKey`, `schemaVersion`;
- `eventType`, `occurredAt`, `createdAt`;
- `player.key`, `clientId`, `memberKey`, `phoneNorm`, `name`;
- `actor.type`, `id`, `memberKey`, `phoneNorm`, `name`;
- `source.domain`, `sourceId` и domain-specific ids;
- `change.before`, `delta`, `after`, `gradeBefore`, `gradeAfter`;
- `formula.version` и снимок параметров;
- `projectionIntent.viva` только как намерение переходной проекции. Фактический статус синхронизации хранится в outbox, а не меняет immutable event.

Первый реализованный writer использует типы:

- `GAME_RESULT_CONFIRMED`;
- `GAME_RESULT_CORRECTION_APPLIED`;
- `GAME_RESULT_TIMEOUT_CONFIRMED`;
- `GAME_RESULT_DISPUTED_REVERTED`;
- `GAME_RESULT_EXPIRED_REVERTED`;
- `RATING_INITIAL_IMPORTED` для backfill.

Следующие writers должны добавить tournament и admin/manual event types без изменения базового envelope.

## Backfill

По умолчанию миграция работает только как dry-run и не перезаписывает рейтинг:

```bash
npm run rating:ledger:migrate -- --input-file /absolute/path/player-ratings.json
```

Dry-run непосредственно из Mongo:

```bash
MONGODB_URI="$MONGODB_URI" npm run rating:ledger:migrate
```

Применение разрешается только после разбора duplicate identities и сохранения dry-run отчёта:

```bash
MONGODB_URI="$MONGODB_URI" npm run rating:ledger:migrate -- --apply
```

`--apply`:

1. создаёт `rating_events` при отсутствии;
2. создаёт уникальные identity/idempotency индексы;
3. добавляет детерминированные `RATING_INITIAL_IMPORTED` события;
4. маркирует только ещё не мигрированные `player_ratings` как `CUP_CANONICAL`;
5. не меняет `ratingNumeric` и `rating`.

Если найдены дубли `phoneNorm` или `clientId`, apply завершается до записи.

Второй физический cutover выполняется отдельно:

```bash
npm run rating:state:migrate -- --mongo-uri "$MONGODB_URI" --out tmp/player-rating-state-dryrun.json
npm run rating:state:migrate -- --mongo-uri "$MONGODB_URI" --apply --out tmp/player-rating-state-apply.json
```

Миграция строит однозначный `clientId ↔ phoneNorm` crosswalk из игр, результатов, сообществ и посещений, создаёт `player_rating_state`, фиксирует ledger cutover в `rating_job_registry` и не меняет числовой рейтинг.

## Переходный маршрут записи

```text
CAS результата игры
  -> rating_events ($setOnInsert)
  -> player_rating_state (canonical state)
  -> player_ratings (compatibility projection)
  -> lk_result_viva_sync_outbox
  -> Viva projection
```

Отключать Viva-write можно только после подключения tournament/manual writers, reconciliation и периода сравнительного контроля.

Затронутые source-driven function nodes:

- `Confirm result + calc rating` формирует immutable event и current-state mutation;
- `Route confirm after CAS` прикрепляет соответствующую Viva projection task к rating mutation;
- `Build rating update msg` готовит `$setOnInsert` в `rating_events`;
- `Upsert player rating -> mongodb4 args` готовит обновление `player_rating_state` после append;
- `Build player_ratings compatibility projection` обновляет legacy read model;
- `Project canonical rating to Viva` запускает outbox/request только после записи state.

HTTP-контракт результата игры не меняется. Переходная Viva-проекция продолжает использовать `POST /lk/onboarding/level`; его truthful upstream-status handling остаётся отдельным rollout gate.

## Versioned worker и reconciliation

- `rating-worker-v1.0.10` хранит incremental watermark и lease в `rating_job_registry` и очищает старую ошибку после успешного прогона;
- каждый запуск фиксируется в `rating_job_runs`;
- изменение стартового уровня турнира создаёт idempotent
  `TOURNAMENT_START_RATING_CHANGED`: actor/reason и исходный UI event остаются в
  source, а canonical delta рассчитывается как `targetAfter - canonicalBefore`;
- после стартового override worker последовательно обновляет `rating_events`,
  `player_rating_state`, compatibility `player_ratings` и Viva projection outbox;
- tournament finalize/correction/reopen создают idempotent events и компенсации;
- новый tournament event сохраняет исходные `ratingBefore/ratingDelta/ratingAfter` в
  `source.tournamentRatingSnapshot`, но canonical `change.delta` вычисляет как
  `tournament ratingAfter - canonical rating before tournament`; поэтому replay всегда
  приходит ровно в подтверждённый `ratingAfter`, даже если tournament snapshot был
  рассчитан от отличающегося Viva/legacy baseline;
- projector пересобирает затронутый state из initial baseline и ordered deltas;
- incremental запуск — каждые 15 минут, nightly full safety run — отдельно;
- ошибка отдельной Viva-синхронизации посещений фиксируется в wrapper report, но
  не блокирует canonical rating run;
- `npm run rating:reconcile` всегда начинает с dry-run и выдаёт confirmation token для historical backfill;
- события турниров до cutover получают `applyToState=false`: они участвуют в истории/dynamics, но исключены из canonical replay, active-revision logic и Viva projection.
- Viva transition projection writes the supported numeric rating custom field only; the letter grade is derived from the numeric canonical state and is no longer retried against the removed Viva field.

## Что ещё не входит в текущий срез

- административный API ручной корректировки с reason и actor из ЦУП;
- read API истории и объяснения рейтинга;
- отключение чтения и записи рейтинга в Viva.
