# 📦 Компоненты — Быстрый справочник

## Принцип организации

```
src/components/
├── UI/          ← Переиспользуемые примитивы (не бизнес-логика)
├── auth/        ← Всё, что связано со входом
├── cabinet/     ← Основной экран после входа
├── games/       ← Игры и приглашения
├── tournaments/ ← Турниры
└── onboarding/  ← Онбординг
```

---

## UI компоненты (`src/components/UI/`)

### `AppErrorBoundary.tsx`
React Error Boundary. Оборачивает модули, перехватывает ошибки рендера, отправляет в аналитику. Принимает проп `module` (строка) для идентификации.

### `Modal.tsx`
Простая модалка. Принимает `isOpen`, `onClose`, `children`.

### `CalendarDateBadge.tsx`
Значок с датой для отображения в карточках бронирований.

---

## Auth компоненты (`src/components/auth/`)

### `AuthForm.tsx`
Контейнер. Переключает между `PhoneStep` и `CodeStep`. Принимает `onLogin` callback.

### `PhoneStep.tsx`
Ввод телефона. Вызывает `AuthContext.sendCode()`. При успехе переходит к `CodeStep`.

### `CodeStep.tsx`
Ввод 4-значного SMS-кода. Вызывает `AuthContext.login()`. Встроен обратный отсчёт для повторной отправки (через `useCountdown`).

### `PhoneInput.tsx`
Controlled input с форматированием российского номера телефона.

---

## Cabinet компоненты (`src/components/cabinet/`)

### `Cabinet.tsx` ⭐ Главный
**Размер:** ~66KB. Загружает при монтировании: профиль, бронирования, абонементы.  
**Входные пропсы:**
- `onOpenGames(options?)` — открыть оверлей игр
- `onOpenTournaments()` — открыть оверлей турниров
- `onOpenOnboarding(data)` — открыть оверлей онбординга

**Управляет состоянием:** активная вкладка (профиль / бронирования / абонементы / сообщества / поддержка).

### `UserProfile.tsx`
Аватар, имя, телефон, уровень, баллы лояльности, кнопка редактирования.

### `ProfileEditForm.tsx`
Форма редактирования: имя, дата рождения, пол, email, custom fields из CRM.

### `BookingsContainer.tsx` (~17KB)
Активные бронирования. Кнопки: отменить, создать игру из брони, добавить в календарь.

### `BookingHistory.tsx`
Прошлые записи с пагинацией.

### `BookingCard.tsx`
Карточка одного бронирования. Показывает статус, дату, студию, стоимость.

### `SubscriptionsContainer.tsx`
Список купленных абонементов → клик → `SubscriptionInformation`.

### `SubscriptionInformation.tsx`
Детали: название, остаток визитов, срок действия, доступные студии.

### `BuySubscription.tsx` + `BuySubscroptionCard.tsx`
Покупка абонемента. `BuySubscroptionCard` — карточка одного варианта.

### `CommunitiesSection.tsx` ⭐
**Размер:** ~124KB (крупнейший компонент). Полная система сообществ.
- Список сообществ (публичных, своих)
- Создание/редактирование сообщества
- Управление участниками (приглашение, модерация, бан)
- Лента постов (фото, игры, турниры)
- Настройки приватности и правил

### `SupportChatWidget.tsx`
**Поллинг:** каждые 12 секунд.  
Показывает: список диалогов по станциям → выбор → история сообщений.  
Отправка через `POST /api/support/dialogs/events` с `channel: "WEB"`.

### `OnboardingModal.tsx` (~26KB)
Пошаговый онбординг нового клиента. Выбор станции, заполнение профиля, ознакомление с возможностями.

### `TournamentsTodayModal.tsx`
Попап с турнирами на сегодня. Показывается автоматически при входе если есть турниры.

### `Advertisement.tsx`
Рекламный/промо-блок. Получает данные из profila (customFields).

### `ButtonModele.tsx`
Кнопки переключения вкладок в кабинете. Отображает счётчики/badge.

---

## Games компоненты (`src/components/games/`)

### `GamesPage.tsx` ⭐
**Размер:** ~299KB (самый большой файл проекта).  
Полная система управления играми:
- Список открытых игр с фильтрами
- Создание игры (выбор студии, времени, слота, добавление игроков)
- Присоединение/выход
- Чат внутри игры
- Live-рейтинги
- Запись результатов

**Пропсы:**
- `onBack()` — закрыть оверлей
- `openGameId?` — сразу открыть конкретную игру
- `openChat?` — открыть чат игры
- `createFromBooking?` — создать игру из данных брони
- `publicCreateEntry?` — режим быстрого создания (с /game_create)
- `presetStudioId/Name?` — предвыбранная студия

### `GameJoinPage.tsx`
Страница приглашения (для /game_join). Показывает карточку игры, позволяет присоединиться или отказаться. После действия — ссылка в кабинет.

---

## Утилиты (`src/utils/`)

| Файл | Экспорты | Назначение |
|------|----------|-----------|
| `apiClient.ts` | ~100 функций + типов | Все API-запросы |
| `communityApi.ts` | `apiFetchCommunities*` и др. | API сообществ |
| `analytics.ts` | `trackAnalyticsEvent`, `trackClientError`, `identifyAnalyticsUser` | Аналитика |
| `paymentSync.ts` | `processPendingPaymentSyncQueue` | Синхронизация оплаты |
| `cookies.ts` | `getCookie`, `setCookie`, `deleteCookie` | Работа с куками |
| `customFields.ts` | `parseCustomFields` и др. | CRM custom fields |
| `calendarEvent.ts` | `addToCalendar` | Добавление в системный календарь |
| `gameInviteClipboard.ts` | `copyGameInviteLink` | Копирование ссылки приглашения |

---

## Хуки (`src/hooks/`)

### `useCountdown.ts`
`useCountdown(seconds)` → `{ remaining, start, reset }`.
Используется в `CodeStep` для отсчёта до повторной отправки SMS.
