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
                    │  games.js │ tournaments.js │ onboarding.js │
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

---

## Потоки данных — ключевые сценарии

### Авторизация
```
PhoneStep → AuthContext.sendCode() → Keycloak SMS
CodeStep  → AuthContext.login()   → Keycloak token → Cookie
MyApp     → Cabinet (isAuthenticated = true)
```

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
