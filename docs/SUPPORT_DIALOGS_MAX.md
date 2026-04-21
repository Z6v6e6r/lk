# MAX + Support Dialogs

## Что добавлено

В репозиторий добавлен отдельный `Node-RED` слой для мультиканальных диалогов и новый `support` backend в `ph-ab`:

- `support_clients`
  Один клиент с несколькими телефонами, email и канальными идентификаторами.
- `support_dialogs`
  Открытый диалог клиента по станции с SLA, непрочитанными и последней классификацией.
- `support_messages`
  Полная история входящих и исходящих сообщений, включая MAX, TG, email, Mango/Bitrix.

## Новые import-файлы

- `lk_support_dialog_nodes_import.json`
  Отдельный импорт только support-диалогов.
- `lk_max_webhook_nodes_import.json`
  MAX webhook + MAX router для контакта/станции.
- `ЛК03_03_26.with_games_chat_results_communities_support.json`
  Большой объединённый flow с добавленным support-слоем.

## Эндпоинты

- `GET /api/support/clients/resolve`
  Поиск клиента по телефону, email или канальному идентификатору.
- `POST /api/support/dialogs/events`
  Универсальная точка записи входящих/исходящих событий из MAX, TG, email, Mango, Bitrix.
- `GET /api/support/connectors`
  Список коннекторов для ЦУП.
- `GET /api/support/connectors/:connector/stations`
  Станции по коннектору.
- `GET /api/support/connectors/:connector/stations/:stationId/dialogs`
  Диалоги станции.
- `GET /api/support/dialogs/:dialogId/messages`
  История сообщений диалога.
- `POST /api/support/dialogs/:dialogId/reply`
  Ответ администратора с фиксацией SLA и подготовкой dispatch-пакета.
- `GET /api/support/analytics/daily`
  Дневная аналитика по обращениям, темам, приоритетам, станциям и времени ответа.
- `GET /api/support/outbox/pull?connector=MAX_BOT`
  Очередь исходящих ответов для MAX.

## MAX сценарий

`lk_max_webhook_nodes_import.json` делает следующее:

1. Принимает входящий webhook MAX или сообщение через `link in`.
2. Нормализует сообщение в `msg.maxUpdate`.
3. Смотрит текущее состояние клиента через `GET /api/support/clients/resolve`.
4. Отправляет событие в `POST /api/support/dialogs/events`.
5. Формирует сервисные ответы:
   - `/start` -> запрос контакта;
   - контакт получен -> запрос выбора станции;
   - сообщение без номера -> предупреждение о необходимости авторизации;
   - сообщение без станции -> просьба выбрать станцию.
6. Каждые 5 секунд тянет `GET /api/support/outbox/pull?connector=MAX_BOT`,
   отправляет ответы сотрудников в MAX и подтверждает их через `ack`.

## Как подключить к текущему MAX node-red flow

Нужно:

1. Поднять `ph-ab` с новым модулем `src/support/*`.
2. В `Node-RED` импортировать `lk_max_webhook_nodes_import.json`.
3. В конфиге flow указать `SUPPORT_API_BASE_URL` и `SUPPORT_INTEGRATION_TOKEN`.
4. В `maxbot-config` прописать настройки бота MAX.

## AI-классификация

Сейчас в `POST /lk/support/dialogs/events` встроена эвристическая классификация:

- тема;
- тональность;
- приоритет:
  - `CRITICAL`
  - `IMPORTANT`
  - `MEDIUM`
  - `SUGGESTION`

Если внешний AI уже есть, можно передавать в запросе поле `ai`, и оно заменит эвристику.

## Важно

- Сообщения до подтверждения телефона тоже сохраняются.
- После получения телефона диалог и клиент переводятся в авторизованный режим.
- Для reply API готовится `dispatch`-payload, который можно отправлять в MAX/TG/email через внешние sender-узлы.
