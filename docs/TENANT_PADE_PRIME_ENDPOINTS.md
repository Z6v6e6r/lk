# Падел Прайм — эндпоинты и вставка в Tilda

Тенант `Dvjlor`, slug `pade_prime`. Всё, что относится к клубу, живёт под префиксом
`/pade-prime`, изолировано от ПадлХАБа по путям и по коллекциям `pp_*`.
Тестовый хост: `https://lk-reserve.89-108-64-209.sslip.io` (каталог `/pade-prime-test/`).

## 1. Статика (фронт)

| Файл | Назначение | Статус |
| --- | --- | --- |
| `padel-prime-lk.js` | кабинет + маршрутизация (Тильда грузит его) | собран, выложен |
| `pade-prime-games.js` | оверлей игр (`LKWidgetGames`) | собран, выложен |
| `communities.js` | оверлей сообществ (`LKWidgetCommunities`) | собран, выложен |
| `onboarding.js` | онбординг (`LKWidgetOnboarding`) | собран, выложен |
| `levels-info.js` | экран уровней (`LKWidgetLevelsInfo`) | собран, выложен |
| `padel-prime-release.json` | манифест версии для лоадера | **нужно публиковать при каждом релизе** |
| `index.html` | тестовая страница кабинета | выложен |
| `game_join/index.html` | тестовая страница приглашения | выложена |

Публикация манифеста: `node scripts/write-release.mjs dist-padel-prime padel-prime-release.json`.

## 2. Node-RED контур клуба (SERV2)

Базовый URL: `https://padlhub.su/pade-prime` (прод-хост) и
`https://lk-reserve.89-108-64-209.sslip.io/pade-prime` (тест, проксируется в тот же контур).
Все пути ниже — с префиксом `/pade-prime`; nginx: 147 → `127.0.0.1:1880`, 89 → `padlhub.su`,
CORS `*`, `OPTIONS` → 204.

### Проверено живыми GET (18.11, 07:56 МСК)

| Метод | Путь | Ответ | Смысл |
| --- | --- | --- | --- |
| GET | `/pade-prime/lk/games?public=find&limit=1` | 200 `{"total":0,"games":[]}` | публичный список игр клуба |
| GET | `/pade-prime/lk/games?phone=<phone>` | 200 `{"total":0,"identityFiltered":true}` | игры игрока |
| GET | `/pade-prime/lk/games/<id>` | 404 `{"error":"..."}` | эндпоинт жив, игры нет |
| GET | `/pade-prime/lk/chats/by-phone?phone=<phone>` | 401 `CHAT_AUTH_TOKEN_REQUIRED` | чат закрыт без токена |
| GET | `/pade-prime/lk/communities` | 200 `{"total":0}` | список сообществ |

### Входит в клон, требует Bearer (проверяется только живым входом)

Игры: `POST /lk/games`, `POST /lk/games/confirm`, `PATCH /lk/games/<id>`, `POST /lk/games/draft(s)`,
`POST /lk/games/records`, `POST /lk/games/<id>/roster-command`, `POST /lk/games/<id>/roster-payment-confirm`,
`POST /lk/games/<id>/organizer/transfer`, `POST /lk/games/<id>/cancellation/status`.
Результаты: `GET /lk/games/<id>/result/state`, `POST /lk/games/<id>/result/submit|confirm|dispute|revert`,
`POST /lk/games/<id>/result/session/open`, `PATCH /lk/games/<id>/result/session/<sid>`.
Чат: `GET|POST /lk/games/<id>/chat/messages`, `POST /lk/games/<id>/chat/read`.
Сообщества: `GET /lk/communities/<id>`, `GET /lk/communities/<id>/feed`, `/feed/<postId>/thread`,
`/messages`, `/events`, `/event-admission`, `/ranking`, `/players/<pid>/rating`,
`POST /lk/communities/join-by-invite`.

### Сознательно отсутствует в этапе 1 (вырезано профилем)

`/lk/subscriptions/*`, `/lk/subscription-bookings*`, `/lk/trial-group-bookings`, `/lk/games/split/*`,
`/lk/games/payment/confirm`, `/lk/internal/staff/*`, `/lk/tournaments/*`, `/lk/onboarding/*`,
`/lk/analytics/*`, `/lk/support/*`, `/lk/media/*`, `/lk/push/*`, `/lk/padel-day/*`.

Живая проверка это подтверждает: перечисленные пути отдают 404 на `/pade-prime`.
Включение любого из них — отдельная работа: таб в клон, коллекции с префиксом `pp_`,
словарные id Viva, для платежей — отдельное ревью.

### Известная проблема (не блокер этапа 1, но чинить до включения сообществ)

`GET /pade-prime/lk/communities/<id>` для несуществующего id **не отвечает** (соединение
висит, 000 после 15 с). На прод-ЛК1 — то же самое, то есть поведение унаследованное,
не следствие клона. Перед боевым включением сообществ надо закрыть error-path этой функции
ответом 404, иначе клиент будет ждать до таймаута.

## 3. Прямые вызовы Viva (Node-RED не участвует)

- Вход: `https://kc.vivacrm.ru` — realm `clients`, client `widget`, PKCE; cookie `DvjlorAuthToken`.
- Кабинет: `https://api.vivacrm.ru/end-user/api/v1/Dvjlor/{profile,profile/photo,bookings,subscriptions,
  exercises,exercises/period,studios,products/*,transactions}`.
- Для нового домена клуба обязательны: origin в allowlist `client_id=widget` и CORS на стороне Viva.

## 4. Вставка в Tilda

Готовый блок: `deploy/tilda/padel-prime-lk.html`. Внутри — один конфиг `BASE_URL`;
всё остальное (версия из манифеста, таймауты, экран ошибки в палитре клуба) уже написано.

| Страница Тильды | Путь | Что вставить | Как приложение понимает режим |
| --- | --- | --- | --- |
| Кабинет | `/lk` (или любой путь, не совпадающий со служебными) | блок целиком, больше ничего | обычный режим кабинета |
| Приглашение в игру | `/game_join` | тот же блок | путь заканчивается на `VITE_PUBLIC_INVITE_PATH`, либо есть `?joinGame=<id>` |
| Поиск игры | `/finde_game` | тот же блок | путь заканчивается на `/finde_game` |
| Создание игры | `/game_create` | тот же блок | путь заканчивается на `/game_create`, опционально `?stationId=<id>` |

Важно: путь приглашения зашит в бандл при сборке. Сейчас `VITE_PUBLIC_INVITE_PATH=/pade-prime-test/game_join`
(под тестовый хост). При переезде на домен клуба пересобрать с
`VITE_PUBLIC_INVITE_PATH=/game_join`, `VITE_CABINET_URL=<домен>/lk` и скопировать блок,
заменив `BASE_URL` на их каталог статики.

Требования к странице: только блок, без собственных `#root`; HTTPS; не пропускать код через
визуальный редактор, вырезающий JS; не накладывать второй глобальный header/footer.

## 5. Чек-лист приёмки страницы

1. `GET <BASE_URL>/padel-prime-release.json` — 200 (или осознанно отсутствует).
2. `GET <BASE_URL>/padel-prime-lk.js` — 200, `application/javascript`.
3. Открыть страницу: экран входа с шильдиком «ПАДЕЛ ПРАЙМ», тема `data-theme="padel-prime"`.
4. Вход учёткой клуба → кабинет без ошибок; «Игры» и «Сообщества» открываются (пустые списки).
5. `GET /pade-prime/lk/games?public=find&limit=1` из консоли страницы — 200, без CORS-ошибок.
