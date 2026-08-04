# 🔴 Node-RED Потоки — Справочник

## Что это и зачем

Node-RED — визуальный инструмент автоматизации. В этом проекте он выступает бэкенд-слоем между фронтендом (личный кабинет) и базой данных (MongoDB). Потоки обрабатывают HTTP-запросы от фронта и MAX-бота.

---

## Модульный workflow (обязательный)

Текущий рабочий процесс зафиксирован в отдельном регламенте:

- `docs/NODERED_MODULAR_WORKFLOW.md`

Коротко:

1. Источник: `node-red/modular/source.flow.json`
2. Метаданные pulled source: `node-red/modular/source.flow.meta.json`
3. Канон: `node-red/modular/lk.flow.modular.json`
4. Блочные импорты: `node-red/modular/imports/*.import.json` и `*.nodes.import.json`
5. Проверка целостности: `node-red/modular/validation.json`

Команда пересборки:

```bash
npm run nodered:modular:build
```

---

## Файлы для импорта

> Импортировать через Node-RED UI: Меню → Import → вставить содержимое файла

### Актуальные объединённые потоки (накопительные версии)

| Файл | Что включает |
|------|-------------|
| `ЛК03_03_26.with_games.json` | Базовый поток + игры |
| `ЛК03_03_26.with_games_chat.json` | + чат в играх |
| `ЛК03_03_26.with_games_chat_results.json` | + результаты матчей |
| `ЛК03_03_26.with_games_chat_results_communities.json` | + сообщества |
| `ЛК03_03_26.with_games_chat_results_communities_support.json` | + поддержка + MAX (полный) |

**Рекомендуется:** импортировать последний файл из списка — он включает всё.

### Отдельные модульные потоки (для точечных обновлений)

| Файл | Назначение |
|------|-----------|
| `node-red/modular/imports/lk_games.import.json` | Рекомендуемый tab+nodes import для LK Games, включая result lifecycle |
| `node-red/modular/imports/lk_games.nodes.import.json` | Рекомендуемый nodes-only import для точечного обновления LK Games на `147` |
| `lk_games_nodes_import.json` | Legacy import игровых нод |
| `lk_game_chat_nodes_import.json` | Legacy import чата игр |
| `lk_game_results_nodes_import.json` | Legacy import result-контура; не использовать вместо modular `lk_games*.import.json` |
| `lk_communities_nodes_import.json` | Legacy import сообществ |
| `lk_support_dialog_nodes_import.json` | Legacy import поддержки |
| `lk_max_webhook_nodes_import.json` | Legacy import MAX-бота + роутера |
| `поток-lk.mongodb4.json` | MongoDB трансформации |

### Исторические fix-файлы (архив, не импортировать повторно)
`node-red.communities.fix-*.json`, `node-red.games.live-ratings-*.json`, `node-red.results.grade-threshold-fix-*.json`, `node-red.communities.admin-tools-*.json`

---

## Структура функций по модулям

### 📁 `scripts/nodered_games_nodes/`
| Файл | Назначение |
|------|-----------|
| `fn_list_query.js` | Формирование запроса списка игр |
| `fn_list_normalize.js` | Нормализация ответа со списком |
| `fn_get_by_id_query.js` | Запрос игры по ID |
| `fn_get_by_id_resp.js` | Ответ на запрос игры |
| `fn_create.js` | Создание новой игры |
| `fn_patch.js` | Изменение игры (join/leave/update) |
| `fn_live_ratings_*.js` | 6 файлов для live-рейтингов (авторизация, запрос, парсинг, кэш) |

### 📁 `scripts/nodered_chat_nodes/`
| Файл | Назначение |
|------|-----------|
| `fn_chat_get_*.js` | Получение сообщений чата |
| `fn_chat_post_*.js` | Отправка нового сообщения |
| `fn_chat_read_*.js` | Отметка сообщений прочитанными |
| `fn_chat_list_*.js` | Список чатов |

### 📁 `scripts/nodered_max_nodes/`
| Файл | Назначение |
|------|-----------|
| `fn_max_webhook_prepare.js` | Обработка входящего MAX-webhook |
| `fn_max_support_route.js` | Маршрутизация по состоянию клиента |
| `fn_max_client_lookup_prepare.js` | Поиск клиента по телефону/MAX-ID |
| `fn_max_outbox_pull_*.js` | Извлечение очереди исходящих ответов |
| `fn_max_outbox_dispatch_prepare.js` | Подготовка отправки в MAX |
| `fn_max_outbox_ack_prepare.js` | Подтверждение доставки |

---

## API эндпоинты (SERV2 / support)

### Игры
- `GET /api/games` — список игр
- `GET /api/games/:id` — игра по ID
- `POST /api/games` — создать игру
- `PATCH /api/games/:id` — обновить (join/leave)
- `GET /api/games/:id/ratings` — live-рейтинги
- `POST /api/games/:id/result` — записать результат

### Чат
- `GET /api/game-chat/:gameId` — список чатов
- `GET /api/game-chat/:gameId/messages` — сообщения
- `POST /api/game-chat/:gameId/messages` — отправить
- `POST /api/game-chat/:gameId/read` — отметить прочитанными

### Поддержка (Support)
- `GET /api/support/clients/resolve` — найти клиента
- `GET /api/support/connectors` — список коннекторов
- `GET /api/support/connectors/:connector/stations/:stationId/dialogs` — диалоги станции
- `GET /api/support/dialogs/:id/messages` — история диалога
- `POST /api/support/dialogs/events` — записать событие (входящее/исходящее)
- `POST /api/support/dialogs/:id/reply` — ответ администратора
- `GET /api/support/analytics/daily` — дневная аналитика
- `GET /api/support/outbox/pull?connector=MAX_BOT` — очередь для MAX

### Push (FCM)
- `POST /lk/push/register` — зарегистрировать/обновить device token
- `POST /lk/push/unregister` — деактивировать token при logout
- `POST /lk/push/admin/send` — отправить push из ЦУП по токену/фильтрам

### Журнал согласий авторизации

- `POST /lk/analytics/auth-consents` — идемпотентно зафиксировать принятие текущего набора документов после авторизации.
- `OPTIONS /lk/analytics/auth-consents` — CORS preflight.
- Bearer-токен проверяется через Keycloak `clients/userinfo`; `subject`, телефон и client ID из тела запроса не принимаются.
- Коллекция: `lk_auth_consents`; immutable `_id = tenant + lossless encoded verified subject + documentSetVersion`.
- Текущая внутренняя версия набора документов: `2026-07-14`.
- До записи проверяются `sub`, client `widget` и tenant `iSkq6G`: bearer проходит `clients/userinfo`, а client/tenant берутся только из проверенного token context/userinfo, не из request body.
- Frontend связывает staged-запись с hash конкретного OAuth `state` или SMS-телефона, после первого неуспешного POST повторяет доставку с bounded backoff, а также на `online` и возврате вкладки.
- Source functions: `scripts/nodered_auth_consent_nodes/`; patch: `scripts/patch_nodered_auth_consents_flow.mjs`.
- Focused import генерируется как `node-red/modular/imports/lk_auth_consents.nodes.import.json` только после fresh pull live flow с `147`; default patch path fail-closed проверяет origin metadata, SHA-256 исходного flow и свежесть pull не более 30 минут.

### Трансляция результатов турнира

- `GET /lk/tournaments/broadcast/status?tournamentId=<id>` — вернуть сохранённое состояние трансляции.
- `POST /lk/tournaments/broadcast/start` — запустить трансляцию; body для обычной станции: `{ "tournamentId": "...", "stationId": "..." }`; для Сколково обязательно добавляется `"target": "right_arena" | "left_arena" | "both"`.
- `POST /lk/tournaments/broadcast/stop` — остановить ранее сохранённые active targets; body: `{ "tournamentId": "...", "stationId": "..." }`, новый выбор target не принимается.
- `OPTIONS /lk/tournaments/broadcast/:action` — CORS preflight для status/start/stop.
- Пользовательский Bearer проверяется через Viva `GET /end-user/api/v1/iSkq6G/profile`. После этого сервер проверяет право `Проводит турниры` либо совпадение с organizer сохранённого турнира.
- `boxId` не принимается от frontend. Он разрешается по каноническому `stationId` из server-side проекции настроек станций ЦУП (`CUP_STATION_SETTINGS_JSON`): legacy-поле `tournamentBroadcastBoxId` для одной приставки или `tournamentBroadcastTargets.right_arena/left_arena` для Сколково.
- Для Сколково target разрешён только при точном station ID `0d5504f6-ea6f-44bb-a9e4-947faf0273ab`; имя станции и `stationId` из request body не дают право включить multi-target режим.
- Повторный start при сохранённой активной трансляции Сколково отклоняется: fresh transition возвращает `BROADCAST_OPERATION_IN_PROGRESS`, остальное active state — `BROADCAST_ALREADY_ACTIVE`; перед выбором другого target требуется штатный stop.
- Внешний Bearer хранится только в `TOURNAMENT_BROADCAST_BEARER_TOKEN`; frontend его не получает.
- Внешний API задаётся через `TOURNAMENT_BROADCAST_API_BASE_URL`. Node-RED вызывает `POST /integrations/v1/devices/{box_id}/tournament/start|stop`.
- Для `both` server-side proxy отправляет две команды, агрегирует ответы и только затем обновляет `tournaments.params.broadcast`. При частичном start выполняется компенсирующий stop уже запущенной приставки; если компенсация или stop частично не удались, сохраняются `status=partial` и только безопасные `activeTargets`, чтобы следующий stop мог завершить очистку.
- Перед Skolkovo start выполняется атомарный Mongo claim: `active=true`, `status=starting`, intended `activeTargets` и 60-секундный recovery lease. Device fan-out начинается только после `acknowledged=true`, `matched=1`, `modified=1`; финальная запись использует CAS. Fresh `starting` блокирует start/stop с `409 BROADCAST_OPERATION_IN_PROGRESS`, а после lease stop восстанавливает все intended targets.
- Каждая исходящая device-команда явно несёт runtime-поле `msg.requestTimeout=20000`; конфигурационное поле HTTP Request node оставлено только как дополнительная документация и не считается источником таймаута. Join ограничен 25 секундами. Любой неполный Skolkovo start, включая transport timeout, запускает compensating stop для всех intended targets; claim очищается только после подтверждённой компенсации и Mongo CAS.
- HTTP 200 возвращается только после Mongo `updateOne` с явным `acknowledged=true` и положительным matched/modified evidence. Тексты ошибок device API не проксируются в браузер: наружу возвращаются только фиксированные безопасные сообщения.
- Source functions: `scripts/nodered_tournament_broadcast_nodes/`; patch: `scripts/patch_nodered_tournament_broadcast_flow.mjs`; focused import: `node-red/modular/imports/lk_tournament_broadcast.nodes.import.json`.

---

## MAX-бот — схема работы

```
MAX webhook (входящий)
    │
    ▼
fn_max_webhook_prepare.js
    │  msg.maxUpdate = { userId, phone, text, type }
    ▼
fn_max_client_lookup_prepare.js
    │  GET /api/support/clients/resolve?maxId=...
    ▼
fn_max_support_route.js
    │  Состояния: NEW → UNVERIFIED → VERIFIED → STATION_SELECTED
    │  Действия:
    │  ├── /start → отправить кнопку "Поделиться контактом"
    │  ├── contact → нормализация, resolve клиента, переход в VERIFIED
    │  ├── VERIFIED без станции → запросить выбор станции
    │  ├── station_selected → переключить диалог, сохранить историю
    │  └── message → POST /api/support/dialogs/events
    ▼
(каждые 5 секунд)
GET /api/support/outbox/pull?connector=MAX_BOT
    │
    ▼
fn_max_outbox_dispatch_prepare.js → отправить в MAX API
    │
    ▼
fn_max_outbox_ack_prepare.js → подтвердить доставку
```

---

## Патч-скрипты

При обновлении исходников в `scripts/nodered_*_nodes/` нужно пересобрать flow-файлы. Для live-совместимого LK Games/result контура сначала pull с `147`, затем patch, потом build/validate:

```bash
node scripts/patch_nodered_games_flow.mjs
node scripts/patch_nodered_chat_flow.mjs
node scripts/patch_nodered_results_flow.mjs
node scripts/patch_nodered_communities_flow.mjs
node scripts/patch_nodered_support_flow.mjs
node scripts/patch_nodered_max_flow.mjs
```

Скрипт берёт содержимое JS-файлов и вставляет их в соответствующие function-ноды в JSON-потоке.

Для актуального пути релиза `147` см. `docs/NODERED_MODULAR_WORKFLOW.md`: каноничный import для LK Games теперь находится в `node-red/modular/imports/lk_games.import.json` и `lk_games.nodes.import.json`.
