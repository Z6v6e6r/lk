# Аудит контуров рейтинга и уровня

Дата аудита: 2026-07-10
Период live-проверки: 2026-07-06 — 2026-07-10, Europe/Moscow
Контур: `lk-primary-147`, активный Node-RED runtime, сохраненные production-отчеты и публичный API
Режим: read-only; новых пересчетов, импортов flow и записей в production не выполнялось

## Резюме

Система состоит не из одного, а из двух связанных контуров:

1. **Уровень игрока** — числовой rating `1..7` и буквенная градация в Viva.
2. **Community rating** — производный рейтинг внутри сообщества по играм, турнирам и активности.

Community rating с 7 июля реально работает в production: выполнен исторический backfill посещений, установлен ежедневный job, snapshots версии `community-rating-v1.1.0` обновлялись три ночи подряд и читаются публичным API.

Контур уровня завершен только частично. Для игр развернуты `player_ratings`, lifecycle rating events, Viva outbox и retry каждые 10 минут. Для турниров рейтинг пока остается в `tournaments.standings.ratingAfter` и переносится в Viva отдельным repair-скриптом. Единого источника истины уровня между играми, турнирами и Viva нет.

Главный production-дефект: `/lk/onboarding/level` не валидирует ответы двух Viva PUT и всегда возвращает `200 { ok: true }`. Поэтому outbox способен зафиксировать ложный `SYNCED`. По текущим данным нельзя достоверно посчитать долю успешной синхронизации уровня.

> Update 2026-07-10 13:39 MSK: P0 устранён. В production созданы canonical `player_ratings`/`rating_events`, выполнен initial backfill, игровой writer переведён на event-first, а `/lk/onboarding/level` теперь возвращает failure при ошибке любого Viva PUT. Ниже сохранён снимок состояния на момент исходного аудита.

Архитектурная оценка готовности:

| Часть | Готовность | Основание |
|---|---:|---|
| Формула и тесты community rating | высокая | Локально проходят 67/67 тестов, есть versioned facts/aggregates/snapshots |
| Production community rating | средняя | Live v1.1.0 работает, но job находится в `/root/tmp-*`, запускается раз в сутки и расходится с текущим contract |
| Уровень после игры | средняя | Ledger/outbox/retry активны, но успех Viva подтверждается некорректно |
| Уровень после турнира | низкая | Есть расчет standings, но штатного event-driven применения к общему ledger/Viva нет |
| Единый аудит и наблюдаемость | низкая | Нет общего rating event journal, run registry, SLO и надежного success/failure сигнала |

## Текущая архитектура

### Community rating

Авторитетные источники worker:

- `lk_communities`;
- `lk_community_feed`;
- `lk_games`;
- `tournaments`;
- `lk_training_visits`.

Материализованные коллекции:

- `community_rating_facts`;
- `community_rating_player_aggregates`;
- `community_rating_snapshots`.

Формула `community-rating-v1.1.0`:

- игры — 55% общего score;
- турниры — 35%;
- активность — 10%;
- activity: `4` за игру, `12` за турнир, `2` за подтвержденное посещение, максимум `100`.

Node-RED API сначала ищет versioned snapshot. Если snapshot отсутствует, включается live fallback по feed/game/tournament. Этот fallback не читает `lk_training_visits`, поэтому его результат семантически не равен v1.1.0 snapshot.

### Уровень после игры

Рабочая цепочка:

```text
result submit
  -> расчет per-set impact (K=0.3, D=3, B=0.3, bounds 1..7)
  -> PENDING_REVIEW
  -> confirm / accept correction
  -> player_ratings
  -> lk_game_rating_events
  -> lk_result_viva_sync_outbox
  -> /lk/onboarding/level
  -> два Viva custom fields
```

Outbox retry активен каждые 10 минут, максимум 30 попыток.

Начальный rating для следующей игры берется из `player_ratings`, а при отсутствии строки — из roster snapshot. Это делает локальный Mongo rating фактическим вычислительным источником, даже если Viva projection отстал.

### Уровень после турнира

`Recalculate ratings & totals` пересчитывает rating по раундам и пишет:

- `standings[].ratingBefore`;
- `standings[].ratingAfter`;
- `standings[].ratingDelta` / `deltaTotal`.

Но штатная tournament-ветка не пишет общий `player_ratings`, не создает общий immutable rating event и не ставит Viva projection в outbox. Для этого используется `repair_tournament_viva_ratings.mjs`, который вызывает `/lk/onboarding/level` напрямую.

Следствие: турнир способен изменить Viva, но не изменить `player_ratings`; следующая игра может начать расчет со старой Mongo-величины и затереть турнирный эффект.

## Как контур отработал 6–10 июля

### Community rating

| Дата | Посещения active | Facts game | Facts tournament | Facts visit | Facts total | Aggregates | Snapshots | Результат |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 6 июля | — | — | — | — | — | — | — | Daily job еще не был установлен |
| 7 июля, EOD | 6 793 | 213 | 851 | 11 139 | 12 203 | 6 104 | 1 312 | Full backfill и первый nightly run завершились |
| 8 июля, EOD | 7 050 | 213 | 898 | 11 844 | 12 955 | 6 280 | 1 328 | Nightly run завершился после дневного Node-RED outage |
| 9 июля, EOD | 7 329 | 213 | 978 | 12 529 | 13 720 | 6 564 | 1 328 | Nightly run завершился |
| 10 июля, 12:30 | 7 329 по последнему postcheck | 213 | 978 | 12 529 | 13 720 | 6 564 | 1 328 | Запуск за 10 июля ожидается в 23:55 |

Публичный API postcheck для открытого сообщества вернул:

- `calculationVersion=community-rating-v1.1.0`;
- `updatedAt=2026-07-09T20:58:09.809Z`;
- `period=all`;
- непустой список.

Наблюдения:

- visits растут ожидаемо: `6 793 -> 7 050 -> 7 329`;
- tournament facts растут: `851 -> 898 -> 978`;
- game facts остались `213`, хотя worker увидел больше исходных game documents. Это не доказывает ошибку, но означает, что за период не появилось новых пригодных `CONFIRMED` community game facts либо они не были связаны с feed; требуется отдельная coverage-метрика;
- 8 июля Node-RED пережил OOM и динамические API были недоступны до restart. Worker ночью завершился, но rating read API делит availability с общим Node-RED процессом.

### Уровень/Viva sync

Активный runtime содержит:

- `player_ratings` update;
- `lk_game_rating_events` lifecycle;
- `lk_result_viva_sync_outbox`;
- retry inject `600s`;
- `/lk/onboarding/level`;
- `lk_rating_change_events` audit insert.

В Node-RED log за неделю найдено 150 предупреждений `PUT custom field: JSON parse error`:

| Дата | Warnings |
|---|---:|
| 6 июля | 34 |
| 7 июля | 32 |
| 8 июля | 40 |
| 9 июля | 36 |
| 10 июля до 12:30 | 8 |

Один level request отправляет два PUT, поэтому поток точно использовался. Но warning может означать нормальный пустой `204` и не доказывает сбой. Одновременно handler игнорирует upstream status и всегда отвечает `ok=true`, поэтому эти же записи не доказывают успех.

Итог: **активность контура подтверждена, успешность применения уровня в Viva не измерима**.

## Что не доделано

### P0 — блокирует достоверность уровня

1. `/lk/onboarding/level` не проверяет status каждого PUT.
2. Game outbox доверяет ложному `200`, поэтому `SYNCED` не является доказательством Viva update.
3. Нет единого canonical rating ledger для игр и турниров.
4. Tournament finalization не создает idempotent rating event и не обновляет `player_ratings`.
5. Нет безопасной компенсации уровня при reopen/исправлении турнира.

### P1 — блокирует production-завершенность community rating

1. Worker развернут в `/root/tmp-rating-visits-run-20260707`, а не как versioned release unit.
2. Cron запускается один раз в сутки, а целевой safety interval в runbook — 15 минут плюс event triggers.
3. Каждый день повторно сканируется диапазон от `2026-05-01` до today и выполняются тысячи idempotent upsert; watermark/incremental режим отсутствует.
4. Нет `flock`, job-run collection, duration/error counters, retention и alerting.
5. Production worker продолжает contract `7d,30d,90d,all` и пишет `83 * 16 = 1 328` snapshots. Текущий локальный contract требует `83 * 8 = 664` snapshots для `all/30d`.
6. API fallback не учитывает visits и может вернуть другой рейтинг, чем snapshot.
7. Не зафиксировано бизнес-правило связи visit со станцией/сообществом. Сейчас одно посещение учитывается во всех сообществах, где человек является участником.
8. `dynamics.currentLevel` и `levelDelta` не опираются на единый level ledger: tournament delta не входит в game-only `ratingImpact`, а current level может быть взят из stale member snapshot.

### P1 — блокирует воспроизводимость релиза

Ключевые части реализации находятся в dirty/untracked рабочем дереве: worker, sync visits, facts/aggregates/persistence/recalculation, result lifecycle tests и часть Node-RED source functions. Production temp-worker и Git checkout не являются одним проверяемым артефактом.

## Целевая архитектура

### Инварианты

1. **Один canonical level state.** На переходном этапе — существующая Mongo `player_ratings`, расширенная v1-контрактом; Viva является projection, а не вторым вычислительным источником истины.
2. **Каждое изменение — immutable event.** Игра, турнир, rollback и ручная коррекция создают `rating_events` с formula version, before/after, source id и revision.
3. **Idempotency.** Ключ: `(sourceType, sourceId, sourceRevision, playerId, action)`.
4. **Projection через outbox.** Viva update получает реальные HTTP statuses, сохраняет оба field result, retry/dead-letter и audit.
5. **Компенсация вместо перезаписи истории.** Dispute/reopen создает обратное событие, а не мутирует старое.
6. **Community rating — только read model.** Он строится из финальных domain events и attendance facts, не меняет player level.
7. **Один versioned worker artifact.** Git SHA, formula version и deployment manifest видимы в каждом job run.
8. **Измеримая свежесть.** Level projection SLO <= 5 минут; community snapshot SLO <= 15 минут; UI показывает `dataThrough` и degraded state.

### Целевые коллекции/модели

| Модель | Назначение |
|---|---|
| `rating_events` | Immutable изменения уровня от game/tournament/manual/rollback |
| `player_ratings` | Текущий canonical numeric/letter level и `lastEventId` |
| `rating_projection_outbox` | Viva projection tasks с attempt/status/HTTP evidence/dead-letter |
| `rating_projection_audit` | Санитизированный аудит каждого внешнего PUT |
| `rating_job_runs` | Version, watermark, started/finished, counts, duration, status, error |
| `community_rating_facts` | Производные game/tournament/visit facts |
| `community_rating_snapshots` | Только `all/30d`, versioned, с `dataThrough` |

## План завершения

### Этап 0. Зафиксировать продуктовый контракт — 0,5–1 день

Решения:

- canonical identity: `clientId`, phone только alias;
- `player_ratings` — источник расчета, Viva — projection;
- formula/version для game и tournament;
- границы буквенных уровней;
- station/community scope для посещений;
- периоды `all/30d`;
- SLO и допустимая stale policy.

Артефакты:

- ADR в `architecture-workspace/adr/`;
- JSON/TS contract формул;
- migration/backfill acceptance checklist.

Done:

- нет открытых трактовок того, что является уровнем и где он хранится;
- game/tournament/revert используют один event contract.

### Этап 1. Исправить truthfulness Viva projection — 1–2 дня, P0

Изменения:

- перед release сначала pull live 147 flow;
- вынести `/lk/onboarding/level` functions в source-driven файлы;
- считать `200/201/204` success, остальные статусы — failure;
- не парсить пустой `204` как JSON;
- возвращать клиенту результат обоих PUT;
- сохранять status, error category и retryability;
- outbox помечать `SYNCED` только после двух подтвержденных PUT.

Тесты:

- 204 + 204;
- 200 JSON + 204;
- 401/403/404;
- 429/5xx retryable;
- один field success, второй failure;
- audit не содержит token/PII сверх допустимого.

Done:

- `SYNCED` означает реальный Viva success;
- false-positive success невозможен;
- есть метрика success/failed/retry/dead-letter.

### Этап 2. Объединить game и tournament level ledger — 2–4 дня, P0

Изменения:

- выделить общий rating event builder;
- game confirm пишет event и projection из общего контракта;
- tournament finalization создает event на каждого участника;
- tournament reopen/correction создает compensating event;
- `player_ratings` обновляется только после append канонического события и хранит `lastEventId`;
- repair-скрипт оставить только как reconciliation/backfill tool.

Done:

- следующий матч всегда стартует с уровня, включающего предыдущие игры и турниры;
- повторный confirm/finalize не применяет delta второй раз;
- reopen восстанавливает ожидаемый before/after;
- Viva и local state могут быть сверены по event id.

### Этап 3. Операционализировать community worker — 1–3 дня, P1

Изменения:

- зафиксировать все worker-файлы в Git;
- собрать versioned deployment package;
- развернуть не в `/root/tmp-*`, а в стабильный release path;
- добавить `flock` или systemd singleton;
- incremental sync по watermark, nightly full safety reconcile;
- event triggers после game confirm, tournament finalization и attendance sync;
- safety run каждые 15 минут;
- `rating_job_runs`, log rotation и alerting.

Done:

- runtime SHA совпадает с release manifest;
- повторный запуск не создает дублей;
- job failure виден без SSH;
- full-history scan не выполняется на каждом коротком запуске.

### Этап 4. Устранить drift community read model — 2–3 дня, P1

Изменения:

- выкатить локальный contract `all/30d` в worker;
- после dry-run/apply удалить или архивировать legacy `7d/90d` snapshots;
- убрать live fallback либо сделать его идентичным worker, включая visits;
- current level и dynamics строить из unified rating events/state;
- добавить station-to-community mapping для visit facts;
- в API вернуть `updatedAt`, `dataThrough`, `calculationVersion`, `sourceVersion`.

Done:

- для 83 сообществ создается 664, а не 1 328 snapshots;
- snapshot и fallback дают одинаковый результат на golden dataset;
- tournament level delta виден в dynamics;
- visit не начисляется несвязанному сообществу.

### Этап 5. Reconciliation и backfill — 1–2 дня, gated apply

Порядок:

1. Dry-run unified ledger по всей доступной истории.
2. Сравнение `player_ratings` ↔ Viva ↔ game/tournament source.
3. Отдельный отчет: missing events, duplicate revisions, Viva drift, false `SYNCED` candidates.
4. Подтверждение apply.
5. Apply idempotent events/projections.
6. Postcheck и выборочная ручная сверка.

Никакой backfill apply не должен входить в кодовый release автоматически.

### Этап 6. Наблюдаемость и rollout — 1–2 дня, P1

Метрики:

- `rating_event_applied_total{source}`;
- `rating_projection_status_total{status}`;
- `rating_projection_lag_seconds`;
- `community_rating_job_duration_seconds`;
- `community_rating_snapshot_age_seconds`;
- `community_rating_facts_total{type}`;
- `rating_reconciliation_drift_total{kind}`.

Rollout:

- canary на одном тестовом сообществе и одном турнире;
- затем новые события без backfill;
- затем controlled backfill;
- 24-часовой soak;
- только после этого отключение legacy repair как штатного процесса.

## Рекомендуемый порядок реализации

```text
P0: truthful Viva status
  -> P0: unified game+tournament ledger
  -> P1: versioned worker deployment
  -> P1: community read-model alignment
  -> gated reconciliation/backfill
  -> observability + legacy shutdown
```

Оценка: 8–15 инженерных дней без учета согласования продуктовой формулы и времени на controlled backfill.

## Проверки аудита

Выполнено:

- live active-flow markers на `lk-primary-147`;
- crontab и сохраненные nightly reports за 7–9 июля;
- public community rating API postcheck;
- сравнение SHA/contract production worker и локального worker;
- анализ active `/lk/onboarding/level` handler;
- `npm run test:community-rating` — 67/67 PASS;
- result lifecycle, rating sync, breakdown и period UI — 49/49 PASS.

Ограничение:

- новый прямой Mongo postcheck не запускался; для weekly-цифр использованы уже сохраненные production postcheck-файлы;
- успешность Viva PUT нельзя доказать текущим audit contract до исправления этапа 1.
