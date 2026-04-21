# 🔴 Node-RED Потоки — Справочник

## Что это и зачем

Node-RED — визуальный инструмент автоматизации. В этом проекте он выступает бэкенд-слоем между фронтендом (личный кабинет) и базой данных (MongoDB). Потоки обрабатывают HTTP-запросы от фронта и MAX-бота.

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
| `lk_games_nodes_import.json` | Только игровые ноды |
| `lk_game_chat_nodes_import.json` | Только чат игр |
| `lk_game_results_nodes_import.json` | Только результаты |
| `lk_communities_nodes_import.json` | Только сообщества |
| `lk_support_dialog_nodes_import.json` | Только поддержка |
| `lk_max_webhook_nodes_import.json` | MAX-бот + роутер |
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
| `fn_write_result_response.js` | Запись результата матча |
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

При обновлении исходников в `scripts/nodered_*_nodes/` нужно пересобрать flow-файлы:

```bash
node scripts/patch_nodered_games_flow.mjs
node scripts/patch_nodered_chat_flow.mjs
node scripts/patch_nodered_results_flow.mjs
node scripts/patch_nodered_communities_flow.mjs
node scripts/patch_nodered_support_flow.mjs
node scripts/patch_nodered_max_flow.mjs
```

Скрипт берёт содержимое JS-файлов и вставляет их в соответствующие function-ноды в JSON-потоке.
