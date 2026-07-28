# Задача ЦУП: блок управления уровнями игроков

## Цель

Добавить в ЦУП раздел **«Уровни игроков»**. Сотрудник с правом доступа
должен найти клиента, увидеть его текущий уровень, всю историю изменений и
выполнить обоснованную ручную корректировку.

ЦУП — источник истины:

- `player_rating_state` — единственный current state;
- `rating_events` — append-only аудит и основание каждого изменения;
- `player_ratings` — только compatibility read-model, не объект записи ЦУП;
- Viva — временная downstream-проекция numeric рейтинга, не источник текущего
  значения для уже известных ЦУП игроков.

## Репозиторий и границы

Проект ЦУП: `/Users/zver/Desktop/ph-ab`.

Не создавать второй ledger, второй state или отдельный worker. ЦУП работает с
существующими production-коллекциями базы `games` и создаёт задачи в
`rating_projection_outbox`, которые доставляет существующий versioned rating
worker.

Не включать в задачу изменение формулы рейтинга, массовые правки и удаление
событий.

## Пользовательские сценарии

### 1. Поиск и список

Вкладка **«Уровни»** содержит строку поиска и таблицу/карточки клиентов.

- Искать по телефону, имени и точному `clientId`.
- Показывать: имя, телефон, `clientId`, numeric rating, grade, дату последнего
  изменения, источник последнего изменения и статус синхронизации с Viva.
- Результаты по existing state читаются только из ЦУП.
- Поиск по имени выполняется только по локальной базе; нельзя вызывать широкий
  Viva search на каждый ввод символа.
- Debounce 300 мс, отмена stale request, loading/empty/error states,
  cursor-pagination.

### 2. Карточка игрока

По клику открывается карточка:

- current rating и вычисленный grade;
- `lastEventAt`, последнее основание и actor;
- идентификаторы игрока и ссылка в Viva (если есть `clientId`);
- badge `CUP canonical`;
- статус downstream-проекции: `SYNCED`, `PENDING`, `FAILED_RETRYABLE`;
- timeline событий с `before → after`, delta, типом, временем, actor и
  причиной/источником;
- фильтры истории: период и тип события.

История не редактируется и не удаляется из UI.

### 3. Ручная корректировка

В карточке доступна кнопка **«Изменить уровень»**.

Форма:

- numeric rating в диапазоне `1.00000..7.00000`;
- preview grade, вычисленный общей функцией рейтинга;
- обязательная причина минимум 10 символов;
- подтверждение «было → станет»;
- защита от двойного submit;
- при конфликте показать актуальное изменение и предложить обновить карточку.

После успешной записи текст должен быть truthful:

> Уровень сохранён в ЦУП. Статус синхронизации с Viva: …

Ошибка Viva не означает отмену изменения в ЦУП.

## Данные и инварианты

### Current state

Коллекция: `player_rating_state`.

Ключевые поля:

```text
playerKey, clientId, phoneNorm, name,
ratingNumeric, rating,
lastEventId, lastEventType, lastEventAt,
identityAliases, ownership=CUP_CANONICAL, updatedAt
```

`player_ratings` обновляется только как compatibility projection после
canonical state; UI ЦУП не читает его как источник истины.

### История

Коллекция: `rating_events`.

Для manual change создавать событие:

```json
{
  "eventType": "RATING_MANUALLY_CHANGED",
  "actor": { "type": "ADMIN", "id": "…", "name": "…" },
  "source": {
    "domain": "CUP_ADMIN",
    "reason": "Обязательная причина"
  },
  "change": {
    "before": 3.2,
    "delta": 0.25,
    "after": 3.45,
    "gradeBefore": "C",
    "gradeAfter": "C+"
  },
  "projectionIntent": { "viva": "REQUIRED_DURING_MIGRATION" }
}
```

`actor` брать только из серверного `@CurrentUser()`. Передача actor, причины
синхронизации или статуса outbox из браузера запрещена.

### Запись

Команда изменения принимает:

```json
{
  "ratingNumeric": 3.45,
  "reason": "Уточнение уровня после контрольной игры",
  "expectedLastEventId": "rating_evt:…",
  "idempotencyKey": "uuid-from-browser"
}
```

Требования:

1. Проверить доступ, диапазон, reason и `expectedLastEventId`.
2. Выполнить event + CAS-update canonical state + outbox в одной Mongo
   transaction. Если транзакции недоступны, endpoint должен fail closed —
   нельзя оставлять manual event без согласованного state.
3. Порядок логики: immutable event → `player_rating_state` → compatibility
   `player_ratings` → `rating_projection_outbox`.
4. При stale `expectedLastEventId` вернуть `409 RATING_STATE_CONFLICT` с
   актуальным state, без нового event.
5. Повтор того же `idempotencyKey` возвращает исходный event/state и не
   создаёт дубликат.

## Viva projection

ЦУП не вызывает Viva напрямую в HTTP-запросе изменения. Он создаёт задачу в
существующем `rating_projection_outbox`.

- Писать только поддерживаемое numeric custom field Viva:
  `eabfe27b-3f72-4496-9185-1a2ec6e6465e`.
- Буквенный grade выводится из numeric rating в ЦУП; удалённое letter field
  Viva не использовать и не ретраить.
- Outbox хранит `ratingEventId`, `playerKey`, payload, status, attempts,
  nextAttemptAt, безопасную ошибку и время sync.
- Retry endpoint не создаёт новое rating event; только переводит последнюю
  failed задачу в `PENDING`.
- Token и пароль Viva не хранятся в event/outbox/API-ответах.

## API

Использовать принятый в `ph-ab` глобальный `/api` prefix.

### `GET /api/admin/player-ratings/search`

Query: `q`, `limit=20`, `cursor`.

Ответ возвращает список state и краткий projection status. Фильтр пустой не
должен запускать unbounded search.

### `GET /api/admin/player-ratings/:playerKey`

Возвращает state, последний event и агрегированный status outbox.

### `GET /api/admin/player-ratings/:playerKey/events`

Query: `limit`, `cursor`, `eventType`, `dateFrom`, `dateTo`.

Возвращает только DTO истории, без технических credentials/payload Viva.

### `POST /api/admin/player-ratings/:playerKey/changes`

Создаёт manual event, canonical state и outbox task. Возвращает state, event
и initial projection status.

### `POST /api/admin/player-ratings/:playerKey/projection/retry`

Создаёт retry только для последней failed outbox-задачи.

## RBAC

- просмотр: существующие staff-роли;
- ручная корректировка и retry: `SUPER_ADMIN`;
- actor определяется backend-сессией;
- UI скрывает write-controls без права, но backend обязан возвращать `403`.

## Реализация в `ph-ab`

Создать изолированный модуль, например:

```text
src/player-ratings/
  player-ratings.module.ts
  player-ratings.controller.ts
  player-ratings.service.ts
  player-ratings.repository.ts
  player-ratings-projection.service.ts
  dto/
```

Зарегистрировать модуль в `src/app.module.ts`. Добавить вкладку `Уровни` рядом
с существующими admin-разделами в `client-sdk/phab-admin-panel.js` и API
wrapper в `createApi(cfg)`.

## Индексы

Проверить идемпотентно, не меняя уже существующие production-инварианты:

- `player_rating_state.playerKey` unique;
- unique partial для `clientId` и `phoneNorm`;
- поиск по нормализованному имени;
- `rating_events.idempotencyKey` unique;
- `rating_events.player.key + occurredAt desc`;
- `rating_projection_outbox.status + nextAttemptAt`.

## Тесты

Backend:

1. existing state ищется локально без Viva;
2. поиск по телефону, имени, clientId и pagination;
3. validation reason/range;
4. actor невозможно подменить body;
5. `expectedLastEventId` conflict не пишет event;
6. success создаёт event, state, compatibility projection и outbox атомарно;
7. idempotency retry не создаёт дубль;
8. failed Viva task не меняет canonical state;
9. projection retry не создаёт новое событие;
10. RBAC deny cases;
11. история immutable и курсорно пагинируется.

Frontend:

1. loading/error/empty и stale search response;
2. desktop/mobile список;
3. история и фильтры;
4. modal validation и preview grade;
5. конфликт `409`;
6. truthful wording статусов Viva;
7. keyboard/focus/Escape.

## Acceptance criteria

- ЦУП показывает текущий уровень исключительно из `player_rating_state`.
- Каждая ручная правка объяснима: кто, когда, почему, старое и новое значение.
- Нельзя изменить state без immutable event и нельзя создать event при CAS
  конфликте.
- Viva failure виден, но не отменяет confirmed state ЦУП.
- Никакой код не пишет удалённое Viva letter custom field.
- В UI нет секретов и полного технического payload outbox.
- `ph-ab` tests/build зелёные; production postcheck подтверждает event/state/
  outbox и одну numeric Viva projection.

## Rollout

1. Backend только для `SUPER_ADMIN`, UI под feature flag
   `PLAYER_RATING_ADMIN_ENABLED=false`.
2. Проверить read/search/history на current production state.
3. Выполнить контролируемую no-op/change-revert пару и проверить event, state,
   outbox и numeric Viva sync.
4. Включить UI для superadmin.
5. Наблюдать outbox, state/event drift и failed retry age минимум 7 дней.

## Не входит в первую версию

- массовое изменение уровней;
- изменение формулы и границ grade;
- удаление/редактирование истории;
- автоматическое принятие Viva как источника для existing CUP state;
- права редактирования для station admin.
