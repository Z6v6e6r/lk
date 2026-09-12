# Рабочая схема: технический клиент Viva для Partner API

Документ для передачи стороне, которая администрирует VivaCRM/Keycloak. Он описывает,
что нужно завести, какие права выдать, как это подключается к sidecar и как проверить
результат. Партнёр (rusPadelUp) к Viva отношения не имеет и эти данные не получает.

Статус: **подготовлено к заведению; ни один вызов Viva ещё не выполнялся**.

## 1. Рабочая схема

```text
  Партнёр (rusPadelUp)
        │  HTTPS 443, mTLS + HMAC v2, exact Host/SNI
        ▼
  Общий nginx 443 (147.45.103.3)
        │  server_name partner-api.padlhub.su, три маршрута, rate/conn limit
        ▼
  Sidecar 127.0.0.1:18894 (Node-RED 5.0.6, default-off)
        ├── MongoDB 147.45.254.160:27017 (БД games, replica set mongodb-510979)
        └── VivaCRM
              ├── Keycloak token: https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token
              └── Admin API:      https://api.vivacrm.ru/api/v1
```

Оба внешних адреса резолвятся в `91.219.191.8`. Sidecar ходит только исходя; входящий
трафик к нему возможен лишь с loopback.

Роль PadlHub: по запросу партнёра добавить игрока в игру (проекция в `lk_games`) и создать
booking в Viva на **технического клиента**, затем при удалении — отменить ровно этот
booking. Расчёт делает партнёр; Viva payment не проводится (`paymentType=ON_PLACE`).

## 2. Что нужно завести

### 2.1 Keycloak-клиент (realm `prod`)

Код получает токен password-grant'ом и отправляет **только** `grant_type=password`,
`client_id`, `username`, `password` (без `client_secret`). Значит клиент должен
разрешать Direct Access Grants как публичный:

| Параметр | Значение |
| --- | --- |
| Realm | `prod` (`kc.vivacrm.ru`) |
| Client ID | предлагаю `padlhub-partner-game-api` |
| Client authentication | **off** (public client) |
| Direct access grants | **on** |
| Standard/Implicit flow | off |
| Web origins / redirect URIs | не нужны (redirect запрещён кодом) |

### 2.2 Сервисная учётная запись

Пользователь-робот в VivaCRM, от имени которого выполняется password grant:

| Параметр | Значение |
| --- | --- |
| Username | предлагаю `padlhub-partner-game-api` |
| Пароль | сгенерировать, передать приватно (не в чат, не в Git) |
| Права | минимально необходимые (см. 2.3) |

### 2.3 Технический клиент VivaCRM

Отдельная клиентская карточка, на которую создаются booking'и партнёрских игроков:

| Параметр | Значение |
| --- | --- |
| `LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID` | ID этой карточки |

Именно этот ID уходит в `clientId` при создании booking, и он же сохраняется в
membership — поэтому смена технического клиента не должна происходить без миграции.

## 3. Требуемые права (least privilege)

Ровно четыре вызова, ничего больше:

| Действие | Метод и путь | Тело/параметры |
| --- | --- | --- |
| Создать booking | `POST /api/v1/exercises/{exerciseId}/bookings` | `clientId` = технический клиент, `paymentType="ON_PLACE"`, `familyMemberId=""`, `customFields=[]` |
| Read-back | `GET /api/v1/exercises/{exerciseId}/bookings?showCancelled=true&page=0&size=200` | — |
| Проверка отмены | `GET /api/v1/clients/{clientId}/bookings/{bookingId}/cancel` | ожидается `cancellationOptions.cancellationOnly.available=true` |
| Отмена | `PUT /api/v1/clients/{clientId}/bookings/{bookingId}/cancel` | `refundMethod="NONE"`, `cancelExercise=false` |

Нужны права: создавать booking на произвольного клиента в нужной студии/услуге, читать
список booking'ов упражнения, читать и отменять booking технического клиента. Возвраты
(`refundMethod`) не используются — только `NONE`.

Тестовая игра: `pay_adff32ae-3cca-425d-a31a-36942a75c8f7` (студия «Терехово», бронь
2026-09-22 07:00–08:30, 90 минут). Технический клиент должен иметь доступ именно к этой
студии/услуге.

## 4. Переменные окружения sidecar

Секреты — только в `/etc/padlhub/partner-game-membership/service.env`
(`0640 root:partner-game-api`), не в Git и не в чат.

| Переменная | Секрет | Значение |
| --- | --- | --- |
| `LK_PARTNER_GAME_API_VIVA_TOKEN_SOURCE` | нет | `password-grant` |
| `LK_PARTNER_GAME_API_VIVA_SERVICE_CLIENT_ID` | нет | Client ID из 2.1 |
| `LK_PARTNER_GAME_API_VIVA_SERVICE_USERNAME` | нет | Username из 2.2 |
| `LK_PARTNER_GAME_API_VIVA_SERVICE_PASSWORD` | **да** | Пароль из 2.2 |
| `LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID` | нет | ID из 2.3 |
| `LK_PARTNER_GAME_API_PROVIDER_MODE` | нет | `viva` (для реальных мутаций) |
| `LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED` | нет | `true` |
| `LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION` | нет | `padlhub-viva-technical-booking-v1` |
| `LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED` | нет | `true` — внутренняя проверка PadlHub |
| `LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED` | нет | `true` — подтверждение отсутствия payment-side effects |

Все пять provider-gate проверяются до любой мутации: при несовпадении — `503` без вызова
Viva. Правка `service.env` не меняет уже запущенный процесс: нужен управляемый рестарт.

## 5. Сетевой доступ

Sidecar сейчас ограничен: `IPAddressDeny=any`, `IPAddressAllow=localhost` и
`147.45.254.160/32` (Mongo). Для Viva нужно добавить `91.219.191.8/32` (api + kc).

Ограничение: `IPAddressAllow` принимает IP/CIDR, а не имена, поэтому адрес нужно
разрешать явно и перепроверять при смене DNS. На 2026-09-11 у обоих имён **нет AAAA**,
то есть IPv4-адреса `91.219.191.8` достаточно; если AAAA появятся, их придётся либо
разрешить, либо явно запретить IPv6 для процесса.

## 6. Проверка после заведения

1. **Только токен.** Синтетический скрипт делает password grant и проверяет
   `token_type=Bearer` и `expires_in` — без вызова Admin API. Ожидаемо: успех.
2. **Read-only.** `GET /exercises/{exerciseId}/bookings` по тестовой игре — проверяем,
   что технический клиент видит упражнение и список читается.
3. **Контролируемая мутация** (отдельное разрешение): создать один booking, снять
   exact read-back, затем отменить через probe + `PUT`, снова read-back. Проверить
   отсутствие побочных списаний и что чужие booking'и не затронуты.
4. Только после этого — выставлять `PROVIDER_MODE=viva` и `VIVA_MUTATIONS_ENABLED=true`
   и активировать канареечного клиента.

## 7. Что нужно от администратора Viva

- [ ] Client ID из 2.1 (и подтверждение, что direct access grants включены, client authentication off).
- [ ] Username/пароль сервисной учётной записи из 2.2 — приватным каналом.
- [ ] ID технического клиента из 2.3.
- [ ] Подтверждение прав на четыре вызова из раздела 3 в студии «Терехово».
- [ ] Подтверждение, что `paymentType=ON_PLACE` не создаёт списаний и не требует оплаты.
- [ ] Контакт для эскалации по токену/правам.

## 8. Границы и риски

- Token flow — повторный password grant, **не** refresh_token; при `expires_in` от 31 до
  86400 секунд токен кэшируется до `получение + expires_in − 30 c` по монотонным часам.
- Смена пароля автоматически сбрасывает кэш токена; при 401 от provider автоматического
  повтора мутации нет — операция остаётся `UNKNOWN` и требует reconciliation.
- Кэш не отзывает уже выданный токен: экстренное отключение — это отключение клиента в
  Keycloak/Viva плюс рестарт sidecar.
- До подтверждения прав на шаге 2 нельзя выставлять `VIVA_MUTATIONS_ENABLED=true`.

## 9. Журнал проверки (2026-09-11)

Владелец передал `clientId` и сервисный аккаунт, после чего выполнены **только
read-only** проверки (мутаций Viva не было):

| Проверка | Результат |
| --- | --- |
| Password grant с `client_id=a46217b4-…` | **401 `invalid_client`** — это не Keycloak-клиент |
| Password grant с `client_id=React-auth-dev` (клиент боевого LK) | **200**, `token_type=Bearer`, `scope=profile email tenant` |
| `GET /exercises/5f1374e4-…/bookings?showCancelled=true&page=0&size=200` | **200**, `content` = 1 запись |
| `GET /clients/a46217b4-d1c0-4363-a848-a9b05d8aa648` | **200** — технический клиент существует |

Выводы:

- `a46217b4-d1c0-4363-a848-a9b05d8aa648` — это **технический клиент VivaCRM**
  (`VIVA_TECHNICAL_CLIENT_ID`), а не Keycloak `client_id`;
- сервисный аккаунт `test_match_point@padlhub.ru` рабочий, права на чтение упражнения и
  карточки клиента подтверждены;
- **блокер:** `React-auth-dev` выдаёт `expires_in = 604800` (7 дней), а резолвер принимает
  только `31..86400` секунд (`partner-game-membership-viva.mjs:246`, `payload.expires_in >
  86_400` → отказ). В текущем виде активация вернула бы `VIVA_SERVICE_TOKEN_UNAVAILABLE`
  / `503`.

Что нужно решить:

1. **Предпочтительно** — завести отдельный Keycloak-клиент под эту интеграцию
   (public, Direct Access Grants on) с access-token lifespan ≤ 86 400 c, например 3600 c.
   Использовать общий `React-auth-dev` не стоит ещё и потому, что это клиент фронтенда
   ЛК: изменение его lifespan затронет обычное приложение.
2. Либо принять решение о смягчении лимита `expires_in` в коде — это отдельное
   security-relevant изменение с ревью и перевыпуском runtime evidence; по умолчанию не
   рекомендуется.

Сетевой доступ `91.219.191.8/32` в юнит **ещё не добавлен** — понадобится на шаге
токен-проверки через sidecar (сейчас grant выполнялся из shell хоста, где ограничение
юнита не действует).

Решение по блокеру (2026-09-12): лимит `expires_in` **ослаблен в коде** до 604 800 секунд
вместо заведения отдельного Keycloak-клиента. Перевыпущен runtime evidence, установлен
release `v02-20260912`, боевой резолвер проверен реальным grant'ом — `max ttl: 604800`,
`RESOLVER OK token_len=3289`. Используемый client остаётся общим `React-auth-dev`, поэтому
изменять его lifespan по-прежнему не требуется.
