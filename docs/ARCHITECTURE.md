# 🏗️ ARCHITECTURE — PadlHub LK

## Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│                         TILDA PAGE                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  <div id="root">  +  <script src="bundle.js">        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼────────┐
                    │   bundle.js      │  ← Vite IIFE, CSS внутри
                    │   (main.tsx)     │
                    └─────────┬────────┘
                              │
                    ┌─────────▼────────┐
                    │   MyApp.tsx      │  ← URL-маршрутизация
                    └───┬───────┬─────┘
                        │       │
              ┌─────────▼─┐  ┌──▼──────────┐
              │ AuthForm  │  │  Cabinet     │
              │ (не авт.) │  │  (авт.)      │
              └───────────┘  └──────┬───────┘
                                    │
              ┌─────────────────────▼───────────────────────┐
              │              Cabinet.tsx                      │
              │  Profile │ Bookings │ Subscriptions           │
              │  Communities │ SupportChat │ Onboarding btn  │
              └───────────────────────────────┬─────────────┘
                                              │  overlay
                    ┌─────────────────────────▼────────────────┐
                    │         Overlay Modules (remote JS)        │
                    │  games.js │ tournaments.js │ group-schedule.js │
                    │  onboarding.js                                  │
                    └──────────────────────────────────────────┘
```

---

## Слой авторизации

**Файл:** `src/context/AuthContext.tsx`

```
AuthProvider
  ├── Проверка куки {TENANT_KEY}AuthToken при старте
  ├── sendCode(phone)  → GET Keycloak /realms/prod/sms/authentication-code
  ├── login(phone, code) → POST Keycloak /realms/prod/sms/...  → устанавливает куку
  └── logout() → удаляет куку, сбрасывает состояние
```

Токен хранится в куке `{TENANT_KEY}AuthToken` (например, `iSkq6GAuthToken`).
Все запросы к API автоматически берут токен через `getCookie()`.

---

## Слой API (`src/utils/apiClient.ts` — ~5800 строк)

Единый файл с типами и функциями для всех API-вызовов.

### Два бэкенда

| Константа | URL | Назначение |
|-----------|-----|-----------|
| `API_BASE` | api.vivacrm.ru | CRM: профиль, бронирования, абонементы |
| `SERV2` | padlhub.su/seliger | Игры, чат, сообщества, поддержка, аналитика |

### Ключевые группы функций

| Группа | Функции | Назначение |
|--------|---------|-----------|
| Профиль | `apiFetchProfile`, `apiUpdateProfile` | Данные пользователя |
| Бронирования | `apiFetchBookings`, `apiCancelBooking` | История и управление записями |
| Абонементы | `apiFetchSubscriptions`, `apiBuySubscription` | Подписки клуба |
| Игры | `apiFetchPadelGames*`, `apiCreatePadelGame*` | Падел-игры и их чат |
| Сообщества | `apiFetchCommunities*` и тд | Клубные сообщества |
| Поддержка | `apiFetchSupportDialogs*`, `apiCreateSupportDialogEvent` | Диалоги со службой поддержки |
| Онбординг | `apiFetchOnboardingStations` | Данные для первого входа |
| Трансляция турнира | `apiFetchTournamentBroadcastState`, `apiSetTournamentBroadcastState` | Защищённый server-side proxy управления Android-приставкой |

### Трансляция результатов турнира

`TournamentsPage` не вызывает API приставки напрямую. Кнопка в менеджере турнира отправляет пользовательский Bearer, `tournamentId` и `stationId` на SERV2. Node-RED проверяет профиль Viva и доступ к турниру, берёт `boxId` из серверной проекции настроек станции ЦУП, подставляет отдельный integration Bearer и только затем вызывает Android integration API. Ответ в браузер содержит только `active`, `stationId`, `tournamentId` и `updatedAt`.

Источник `stationId → tournamentBroadcastBoxId` — настройки станции ЦУП. Для Node-RED они публикуются как `CUP_STATION_SETTINGS_JSON`; тестовые tournament/box override разрешены только отдельными server env и не входят в frontend или flow JSON.

---

## Компоненты кабинета

### `Cabinet.tsx` (~66KB — главный контроллер)
Оркестрирует всё. Загружает профиль, бронирования, подписки. Управляет какую «панель» показывать.

### `components/auth/`
| Файл | Назначение |
|------|-----------|
| `AuthForm.tsx` | Контейнер формы входа |
| `PhoneStep.tsx` | Ввод телефона |
| `CodeStep.tsx` | Ввод SMS-кода с обратным отсчётом |
| `PhoneInput.tsx` | Нормализация/форматирование номера |

### `components/cabinet/`
| Файл | Назначение |
|------|-----------|
| `Cabinet.tsx` | Главный экран (координатор) |
| `UserProfile.tsx` | Отображение профиля, уровень, баллы |
| `ProfileEditForm.tsx` | Редактирование данных профиля |
| `BookingsContainer.tsx` | Список активных бронирований |
| `BookingHistory.tsx` | История прошлых бронирований |
| `BookingCard.tsx` | Карточка одного бронирования |
| `SubscriptionsContainer.tsx` | Список абонементов |
| `SubscriptionInformation.tsx` | Детали абонемента |
| `BuySubscription.tsx` / `BuySubscroptionCard.tsx` | Покупка абонемента |
| `CommunitiesSection.tsx` | Сообщества (~124KB, самый большой компонент) |
| `SupportChatWidget.tsx` | Чат поддержки (polling каждые 12с) |
| `OnboardingModal.tsx` | Модалка онбординга |
| `TournamentsTodayModal.tsx` | Турниры на сегодня |
| `Advertisement.tsx` | Рекламный блок |
| `ButtonModele.tsx` | Кнопки навигации по секциям |

### `components/games/`
| Файл | Назначение |
|------|-----------|
| `GamesPage.tsx` | Список игр, создание, фильтрация (~299KB) |
| `GameJoinPage.tsx` | Страница принятия приглашения |

---

## Оверлей-система

`MyApp.tsx` управляет оверлеем — полноэкранным контейнером `<div id="lk-overlay">`.

```
openOverlayModule(module, src, globalName, data)
  ├── DEV: import() локального компонента
  └── PROD: loadWidget(src, globalName)
              ├── Если скрипт ещё не загружен → createScript()
              └── widget.mount({ targetId, onClose, data })
```

При закрытии: `widget.unmount()` + `root.unmount()` + очистка контейнера.

---

## Аналитика (`src/utils/analytics.ts`)

Все события отправляются на `SERV2/analytics/events`.

Каждое событие содержит: `event`, `timestamp`, `sessionId`, `tenantKey`, `page`, `device`, `user`, `payload`.

Ключевые события:
- `widget_bootstrap_started/rendered` — запуск виджета
- `auth_code_requested/sent` — отправка кода
- `module_open_requested/opened/closed` — открытие оверлей-модуля
- `payment_sync_background` — фоновая синхронизация оплаты

---

## Платёжная синхронизация (`src/utils/paymentSync.ts`)

Очередь задач в `localStorage`. При возврате с платёжной страницы (`?paymentRef=...`) или при фокусе/видимости окна — отправляет накопленные задачи подтверждения оплаты на бэкенд.

---

## Node-RED архитектура

```
Входящий запрос (HTTP / MAX-webhook)
        │
        ▼
   Node-RED Flow
        ├── fn_*_prepare.js    ← Подготовка параметров запроса
        ├── MongoDB node        ← Запрос к базе данных
        └── fn_*_response.js   ← Формирование ответа

Скрипты (scripts/nodered_*_nodes/) — исходники функций
Patch-скрипты (scripts/patch_nodered_*.mjs) — сборка/патч flow-файлов
```

### Потоки по назначению

| Поток | Ключевые операции |
|-------|-------------------|
| `games` | CRUD игр, live-рейтинги, join/leave |
| `chat` | Сообщения в игре (get/post/read) |
| `results` | Запись результатов матчей |
| `communities` | Сообщества: список, вступление, посты |
| `support` | Диалоги поддержки, SLA, аналитика |
| `max` | Webhook MAX-бота, очередь исходящих ответов |

### Каноническая модель результата игры

- Источник истины для ввода результата хранится в `lk_games.resultRosterSnapshot`.
- `resultRosterSnapshot` является private backend-блоком: внутри допустимы `clientId`, `phoneNorm`, organizer binding, waitlist, historical replacements и booking context.
- Во frontend нельзя отдавать `phoneNorm`, `clientId`, `allowedPhoneNorms`, `allRelatedPhones` и raw `playerPool`.
- Для result UI backend отдает только sanitized roster c opaque `memberKey`, `displayName`, `photo`, `sourceRole`, `rosterState`.
- В одном сете всегда играют ровно 4 слота, но между сетами состав может меняться, включая substitutions из waitlist.
- Frontend отправляет только `sessionId`, `sessionRevision`, `sets` и `setPairings` по `memberKey[]`; backend сам валидирует, что каждый `memberKey` существует в snapshot.
- Legacy-поля (`metadata.teamSlots`, `metadata.playerPool`, `allRelatedPhones` и похожие) можно сохранять как compatibility data, но они не должны участвовать в runtime resolution результата.
- Расчет рейтинга выполняется backend-ом по всем distinct игрокам, которые реально участвовали в `setPairings` по сегментам сетов.
- `lk_game_result_sessions` хранит sanitized draft/session view, а `lk_game_results` хранит immutable result aggregate со snapshot-ref и рассчитанными rating segments.

---

## Потоки данных — ключевые сценарии

### Авторизация
```
PhoneStep → AuthContext.sendCode() → Keycloak SMS
CodeStep  → AuthContext.login()   → Keycloak token → Cookie
MyApp     → Cabinet (isAuthenticated = true)
```

После успешного получения Viva/Keycloak token frontend отправляет staged-согласия на
`POST /lk/analytics/auth-consents`. Staged-запись привязана к hash конкретного OAuth `state` или
SMS-телефона; после привязки к verified `sub` доставка повторяется с bounded backoff, при `online`
и возврате вкладки. Node-RED проверяет Bearer через Keycloak `clients/userinfo`, дополнительно
fail-closed проверяет client `widget` и tenant `iSkq6G`, затем идемпотентно сохраняет серверную дату,
verified `sub`, версии и URL документов в `lk_auth_consents`.
До получения token очередь не содержит PII и переживает OAuth redirect через browser storage.

### Открытие игр
```
Cabinet.onOpenGames() 
  → MyApp.openOverlayModule("games", GAMES_BUNDLE_URL)
  → loadWidget() → script tag → window.LKWidgetGames
  → widget.mount({ targetId: "lk-overlay", data: { openGameId } })
```

### Чат поддержки
```
SupportChatWidget (mount)
  → apiFetchSupportDialogs() → выбор диалога по станции
  → apiFetchSupportDialogMessages() → история
  → setInterval(12s) → полинг новых сообщений
Отправка:
  → apiCreateSupportDialogEvent({ channel: "WEB", connector: "WEB_LK" })
```

### Обратный callback оплаты
```
URL: /lk_new?paymentRef=XYZ
MyApp (useEffect) → processPendingPaymentSyncQueue({ forcePaymentRef })
  → apiClient.confirmPayment() → удаляет ?paymentRef из URL
```
