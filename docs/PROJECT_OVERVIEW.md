# 🏸 PadlHub LK — Обзор проекта

## Что это такое

**PadlHub LK** — личный кабинет клиента падел-клуба (padlhub.ru), реализованный как встраиваемый виджет.
Собирается в единый файл `bundle.js`, который вставляется в Tilda-страницу через HTML-блок.

---

## Технологический стек

| Слой | Технологии |
|------|-----------|
| Frontend | React 19, TypeScript, Vite 7 |
| Сборка | IIFE-бандл (единый `bundle.js`, CSS вшит внутрь) |
| Аутентификация | Keycloak (SMS-коды) |
| Backend API | ViVaCRM REST API + SERV2 (padlhub.su/seliger) |
| Автоматизация | Node-RED (потоки для игр, чатов, сообщества, поддержки, MAX-бота) |
| Аналитика | Собственный сервис (SERV2 `/analytics/events`) |

---

## Режимы работы приложения

Один и тот же `bundle.js` обрабатывает три URL-сценария:

### 1. Личный кабинет (`/lk_new`)
Основной режим. Показывает полный кабинет: профиль, бронирования, абонементы, сообщества, чат поддержки.

### 2. Приглашение в игру (`/game_join?joinGame=<GAME_ID>`)
Упрощённый режим для гостевых ссылок. Если пользователь не авторизован — показывает форму входа, после — карточку игры с кнопками «Присоединиться» / «Отказаться».

### 3. Быстрое создание игры (`/game_create?stationId=<ID>`)
Открывает форму создания игры напрямую. Если передана станция — пропускает шаг выбора.

### 4. Публичные standalone-страницы
Отдельные IIFE-бандлы обслуживают публичную запись на турниры (`tournament-signup.js`), расписание групповых тренировок (`group-schedule.js`), однодневное расписание Padel Day (`padel-day-schedule.js`) и витрины турнирных абонементов.

---

## Структура кода (`src/`)

```
src/
├── main.tsx                    # Точка входа, bootstrap с обработкой ошибок
├── MyApp.tsx                   # Корневой компонент, маршрутизация по URL
├── consts/api_config.tsx       # Все env-переменные в одном месте
├── context/
│   └── AuthContext.tsx         # Состояние авторизации, логин/логаут
├── components/
│   ├── auth/                   # Форма входа (телефон + SMS-код)
│   ├── cabinet/                # Главный экран кабинета и все его секции
│   ├── games/                  # Страница игр и приглашения
│   ├── tournaments/            # Страница турниров
│   ├── onboarding/             # Онбординг нового пользователя
│   └── UI/                     # Общие UI-компоненты (Modal, ErrorBoundary и др.)
├── utils/
│   ├── apiClient.ts            # Все вызовы к API (≈5800 строк)
│   ├── communityApi.ts         # API сообществ (отделён для читаемости)
│   ├── analytics.ts            # Отправка аналитики и ошибок
│   ├── paymentSync.ts          # Синхронизация статуса оплаты
│   ├── cookies.ts              # Работа с куками (токен авторизации)
│   └── ...                     # Прочие утилиты
├── hooks/
│   └── useCountdown.ts         # Хук обратного отсчёта (для повторной отправки кода)
└── types/
    └── gamesOverlay.ts         # TypeScript-типы для модуля игр
```

---

## Оверлей-модули (отдельные бандлы)

Три функциональных модуля подгружаются как отдельные JS-файлы во время выполнения:

| Модуль | Глобальное имя | ENV-переменная | Назначение |
|--------|---------------|----------------|-----------|
| Games | `LKWidgetGames` | `VITE_GAMES_BUNDLE_URL` | Создание/просмотр игр, чат |
| Tournaments | `LKWidgetTournaments` | `VITE_TOURNAMENTS_BUNDLE_URL` | Турниры |
| Onboarding | `LKWidgetOnboarding` | `VITE_ONBOARDING_BUNDLE_URL` | Первый вход нового клиента |

В dev-режиме модули загружаются через `import()` из локального кода, в production — через `<script>` с удалённого сервера.

---

## Node-RED потоки (backend-автоматизация)

В корне проекта находятся JSON-файлы для импорта в Node-RED и их исходники в `scripts/`:

| Файл импорта | Назначение |
|---|---|
| `node-red/modular/imports/lk_games.import.json` / `lk_games.nodes.import.json` | Актуальный modular import для LK Games, включая result lifecycle |
| `lk_games_nodes_import.json` | Legacy import игрового контура (не использовать для релиза на `147`) |
| `lk_game_chat_nodes_import.json` | Legacy import чата игр |
| `lk_game_results_nodes_import.json` | Legacy import result-контура (исторический, не использовать вместо modular `lk_games*.import.json`) |
| `lk_communities_nodes_import.json` | Legacy import API сообществ |
| `lk_support_dialog_nodes_import.json` | Legacy import диалогов поддержки |
| `lk_max_webhook_nodes_import.json` | Legacy import интеграции с MAX-ботом |
| `ЛК03_03_26.*.json` | Полные объединённые потоки (нарастающие версии) |
| `поток-lk.mongodb4.json` | MongoDB-трансформации |

**Скрипты-обёртки** (`scripts/patch_nodered_*.mjs`) автоматически патчат flow-файлы при обновлении.

Турнирная механика также включает server-side proxy трансляции результатов на Android-приставку. Frontend не знает integration Bearer и не передаёт `boxId`: устройство выбирается на Node-RED по station ID из проекции настроек ЦУП.

Для LK Games и связанных referral flow действует отдельное release-правило:

- перед пересборкой import-артефактов нужно сначала забрать текущий live flow с сервера `147` в `node-red/modular/source.flow.json`;
- только после этого накладывать локальные patch-скрипты и генерировать `node-red/modular/imports/*.json`;
- рекомендуемая команда: `npm run nodered:modular:prepare-147 -- /root/.node-red/flows.json`.
- `prepare-147` пишет и проверяет `node-red/modular/source.flow.meta.json`, чтобы релиз не собирался из stale snapshot.

### Результаты игр

- Канонический backend source of truth для ввода результата: `lk_games.resultRosterSnapshot`.
- Snapshot хранит всех связанных игроков, включая organizer, active roster, waitlist и допустимые замены между сетами.
- `clientId` и `phoneNorm` остаются только в backend-данных; frontend работает через opaque `memberKey`.
- В одном сете всегда играют две пары, но между сетами состав может меняться, включая игроков из waitlist.
- Frontend для результата должен отправлять только пары по сетам и счет; backend сам резолвит игроков, получает их актуальные уровни и рассчитывает rating impact.
- Legacy-поля игры можно временно сохранять для совместимости, но они не должны использоваться как runtime source of truth для result flow.

---

## Конфигурация окружения (`.env`)

```env
VITE_API_BASE=https://api.vivacrm.ru          # Основной CRM API
VITE_KEYCLOAK_BASE=https://kc.vivacrm.ru       # Аутентификация
VITE_TENANT_KEY=iSkq6G                          # Идентификатор тенанта
VITE_SERV2=https://padlhub.su/seliger           # Второй бэкенд (игры, аналитика)
VITE_SERV2_FALLBACK=https://lk-reserve.89-108-64-209.sslip.io/seliger
VITE_SERV2_FALLBACK_TIMEOUT_MS=2500             # Через сколько мс пробовать reserve для SERV2 GET
VITE_GAMES_BUNDLE_URL=https://padlhub.su/lk/games.js
VITE_TOURNAMENTS_BUNDLE_URL=https://padlhub.su/lk/tournaments.js
VITE_ONBOARDING_BUNDLE_URL=https://padlhub.su/lk/onboarding.js
VITE_CABINET_URL=https://padlhub.ru/lk_new
```

`.env.dev` — аналог для dev-сборки (`build:dev`); dev-бандлы сначала собираются во временный `dist-dev/`, а затем копируются в `dist/` как `*-dev.js`. Во время сборки дополнительно создаются `release.json` и `release-dev.json`, которые используются внешним загрузчиком для принудительного обновления Safari.

---

## Команды

```bash
npm install           # Установить зависимости
npm run dev           # Dev-сервер
npm run build         # Собрать оба комплекта: боевой и dev-с-суффиксом в dist/
npm run build:dev     # Пересобрать только dev-комплект (временно в dist-dev/, затем в dist/*-dev.js)
npm run build:analyze # Сборка с анализатором бандла (dist/stats.html)
```

---

## Деплой

1. `npm run build` → в `dist/` появляются оба комплекта: `bundle.js`/`games.js`/`tournaments.js`/`tournament-signup.js`/`group-schedule.js`/`padel-day-schedule.js`/`onboarding.js`/`communities.js`/`tournament-subscription-referral.js` и `bundle-dev.js`/`games-dev.js`/`tournaments-dev.js`/`tournament-signup-dev.js`/`group-schedule-dev.js`/`padel-day-schedule-dev.js`/`onboarding-dev.js`/`communities-dev.js`/`tournament-subscription-referral-dev.js`, плюс `release.json` и `release-dev.json`
2. Рекомендуемая топология выкладки: `prod`-комплект только на `lk-primary-147`, `dev`-комплект только на `lk-reserve-89`
3. Вставить в Tilda через блок T123 (HTML) — шаблон в `README_DEPLOY.md` или `docs/tilda-loader.html`; он умеет работать и с `prod`, и с `dev`, читает `release.json` или `release-dev.json` и добавляет `?v=...` к URL скриптов

---

## Связанные документы

| Файл | Описание |
|------|---------|
| `README_DEPLOY.md` | Деплой, Tilda-вставка, invite-ссылки |
| `MAX_SUPPORT_SCENARIOS.md` | Сценарии MAX-бота и поддержки |
| `SUPPORT_DIALOGS_MAX.md` | Техническое описание support-слоя и API эндпоинтов |
| `ARCHITECTURE.md` | Детальная схема компонентов и потоков данных |
| `MAIN_STABILIZATION.md` | Восстановление `main`, clean-release guard и правила переноса dirty-изменений |
| `STABILIZATION_BASELINE_2026-07-25.md` | Исходные SHA, размер quarantine-слоя и результаты baseline-проверок |
| `PRODUCTION_RECOVERY_LEDGER_2026-07-26.md` | Live release/Node-RED SHA, artifact cohorts и очередь восстановления |
