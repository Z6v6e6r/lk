# FCM Integration (Android / Capacitor)

## Что уже добавлено в проект

- Клиентская интеграция FCM через `@capacitor/push-notifications`.
- Инициализация push после авторизации пользователя (`AuthContext`).
- Получение FCM token, подписка на события:
  - `registration`
  - `registrationError`
  - `pushNotificationReceived`
  - `pushNotificationActionPerformed`
- Runtime permission для Android 13+ (`POST_NOTIFICATIONS`).
- CLI-скрипт отправки push через FCM HTTP v1:
  - `scripts/fcm/send-fcm.mjs`

## Как это работает

1. Пользователь авторизуется в приложении.
2. `AuthContext` запускает `initializePushNotifications()`.
3. Приложение запрашивает permission на уведомления.
4. FCM возвращает device token.
5. Токен сохраняется локально и (если настроен endpoint) отправляется на backend:
   - `VITE_PUSH_REGISTRATION_URL`
6. При logout вызывается de-registration:
   - `VITE_PUSH_UNREGISTRATION_URL`

## Обязательная настройка

1. Firebase Console:
   - создать/проверить Android app с package name: `com.cabinet.app`
2. Положить `google-services.json` в:
   - `android/app/google-services.json`
3. Настроить env для backend token mapping:
   - `VITE_PUSH_REGISTRATION_URL`
   - `VITE_PUSH_UNREGISTRATION_URL`

Пример:

```env
VITE_PUSH_REGISTRATION_URL=https://padlhub.su/lk/push/register
VITE_PUSH_UNREGISTRATION_URL=https://padlhub.su/lk/push/unregister
```

## Контракт backend endpoint (рекомендуемый)

`POST VITE_PUSH_REGISTRATION_URL`

```json
{
  "token": "FCM_TOKEN",
  "platform": "android",
  "tenantKey": "iSkq6G",
  "appVersion": "release-id-or-null",
  "timezone": "Europe/Moscow",
  "userAgent": "...",
  "registeredAt": "2026-05-17T20:00:00.000Z"
}
```

- Авторизация: `Authorization: Bearer <AuthToken>`
- На backend токен нужно привязать к user/client по bearer token.

`POST VITE_PUSH_UNREGISTRATION_URL`

```json
{
  "token": "FCM_TOKEN",
  "tenantKey": "iSkq6G",
  "platform": "android",
  "unregisteredAt": "2026-05-17T20:00:00.000Z"
}
```

## Endpoint для отправки из ЦУП

`POST /lk/push/admin/send`

```json
{
  "title": "Новая игра",
  "body": "Открылась запись на 20:30",
  "data": {
    "type": "game_invite",
    "gameId": "123"
  },
  "clientId": "client-uuid",
  "limit": 20
}
```

Варианты адресации:
- `token` / `tokens` — отправка по явному токену/списку;
- фильтры `clientId`, `userId`, `phone`, `email`, `subject`, `identityKey`;
- `allowBroadcast=true` — рассылка по всем активным токенам (с ограничением `limit`).

Node-RED env для отправки FCM:

```env
PUSH_FCM_SERVICE_ACCOUNT_PATH=/absolute/path/firebase-service-account.json
PUSH_FCM_SEND_SCRIPT=/absolute/path/scripts/fcm/send-fcm.mjs
PUSH_FCM_PROJECT_ID=padlhub
```

## Как протестировать

1. Установить приложение на Android-устройство.
2. Авторизоваться в приложении.
3. Убедиться, что token зарегистрирован:
   - либо в вашем backend после вызова `VITE_PUSH_REGISTRATION_URL`,
   - либо взять token из хранилища (`localStorage` ключ `${TENANT_KEY}_fcm_push_token_v1`) в WebView debug.
4. Отправить тестовый push:

```bash
node scripts/fcm/send-fcm.mjs \
  --service-account ./secrets/firebase-service-account.json \
  --token "<FCM_TOKEN>" \
  --title "Тест FCM" \
  --body "Пуш доставлен"
```

5. Проверить сценарии:
   - foreground: событие `pushNotificationReceived`
   - background/killed: уведомление в системной шторке
   - tap по уведомлению: событие `pushNotificationActionPerformed`

## Пример data push

```bash
node scripts/fcm/send-fcm.mjs \
  --service-account ./secrets/firebase-service-account.json \
  --token "<FCM_TOKEN>" \
  --title "Новая игра" \
  --body "Откройте приглашение" \
  --data type=game_invite \
  --data gameId=123
```

`android_channel_id` для payload в FCM должен быть `lk_default` (или передайте `--android-channel-id`).
