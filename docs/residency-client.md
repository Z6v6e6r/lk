# Резидентство в клиентском ЛК: экран пропуска и серверный шлюз

Ветка: `agent/residency-client-20261105` (пакет B+D программы резидентства).
Риск: **CRITICAL** по границе (ссылается на auth-контекст Viva и вызывает внутренний
маршрут CUP с integration token), поэтому изменения ограничены клиентом LK и новым
Node-RED-потоком; CUP, lk2, Tilda и прод не меняются.

Источники контрактов (read-only):

- `docs/resident-services.md` (ветка `agent/resident-pass-20261105`) — выдача пропуска,
  внутренний маршрут CUP, коды ошибок, конфигурация.
- `docs/residency-check.md` (ветка `agent/residency-check-20261105`) — станционный экран
  сотрудника, формат QR-ссылки, станционный контекст.

## Что реализовано в этой ветке

1. **B — шлюз `LK → CUP`** (`node-red/imports/lk_residency_pass.import.json`, исходники
   `scripts/nodered_residency_pass_nodes/`, детерминированный сборщик
   `scripts/build_nodered_residency_pass_import.mjs`). Браузер не видит ни
   `X-Resident-Services-Integration-Token`, ни адрес CUP.
2. **D — экран резидента** внутри действующего клиентского ЛК: секция «Резидентство» в
   кабинете, кнопка «Показать QR», глубокие ссылки станции, экран QR с таймером,
   автоперегенерацией, перепроверкой при возврате из фона, offline-режимом и раздельными
   состояниями.

## Аутентификация (не меняется)

- Клиент LK аутентифицируется Viva Keycloak (`VivaAuthProvider`, SMS/OAuth), токен лежит
  в cookie `{TENANT_KEY}AuthToken` и уходит как `Authorization: Bearer <LK user token>`
  в `apiClient.request({ auth: true })`.
- CUP-C проверяет тот же LK Bearer через `LkIdentityService` (RS256, issuer, tenant,
  `clientId`), поэтому браузерный Bearer можно передать дальше без обмена на другой
  пользовательский токен.
- Шлюз дополнительно проверяет Bearer через Keycloak `clients/userinfo`
  (тот же приём, что у `/lk/analytics/auth-consents`): статус 200, JSON, непустой
  `sub`, `azp|client_id == widget`, tenant claim `== iSkq6G`; иначе 401/403. Это
  fail-closed защита от «токена другого клиента/тенанта», а не замена проверки CUP.

## Где живёт шлюз

Новый отдельный Node-RED поток на действующем LK-бэкенде `padlhub.su` (тот же инстанс,
что обслуживает `/lk/...`; dev — `lk-reserve-89`). Публичные маршруты:

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| POST | `/lk/residency/passes` | создать персональный пропуск (одноразовый QR) |
| GET | `/lk/residency/passes/:passId` | опциональная проверка состояния пропуска |
| OPTIONS | `/lk/residency/passes` | CORS preflight (создание) |
| OPTIONS | `/lk/residency/passes/:passId` | CORS preflight (статус) |

Поток ставится **импортом** отдельного import-файла в Node-RED; импорт/рестарт — отдельное
согласованное действие владельца, эта ветка его не выполняет.

Переменные окружения Node-RED (значения задаются на хосте, в репозиторий не попадают):

```text
RESIDENT_CLIENT_ENABLED=true                       # false/отсутствует -> 503 RESIDENT_CLIENT_DISABLED
RESIDENT_CLIENT_CUP_API_BASE_URL=                  # обязателен, содержит /api (как CUP_API_BASE_URL)
RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN=             # обязателен, >= 32 байт, только server-side
RESIDENT_CLIENT_CUP_PASS_STATUS_PATH=              # опц., напр. /internal/subscriptions/resident-passes/; пусто -> statusAvailable=false
RESIDENT_CLIENT_KEYCLOAK_USERINFO_URL=             # default https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/userinfo
RESIDENT_CLIENT_VIVA_API_BASE_URL=                 # default https://api.vivacrm.ru
RESIDENT_CLIENT_EXPECTED_CLIENT_ID=                # default widget
RESIDENT_CLIENT_TENANT_KEY=                        # default iSkq6G
RESIDENT_CLIENT_RATE_LIMIT_PER_MINUTE=             # default 20 (на верифицированного subject)
```

Срез CUP-пути: `${RESIDENT_CLIENT_CUP_API_BASE_URL}/internal/subscriptions/resident-passes`
(в CUP глобальный префикс `api` уже содержится в `.../api`).

## Контракт клиент ↔ шлюз

### Создание пропуска

```http
POST /lk/residency/passes
Authorization: Bearer <LK user token>
Content-Type: application/json

{"clientSubscriptionId":"<точный Viva client subscription id>"}
```

200 (единственный раз возвращает токен):

```json
{
  "schemaVersion": 1,
  "passId": "resident_pass:<uuid>",
  "passToken": "rsp1_<random>",
  "issuedAt": "<ISO>",
  "expiresAt": "<ISO, <= 120s и <= activeTo>",
  "subscriptionInstanceId": "subscription_instance:<...>",
  "residency": {
    "subscriptionTypeId": "...",
    "subscriptionTypeTitle": "...",
    "activeFrom": "<ISO>",
    "activeTo": "<ISO>"
  }
}
```

Ошибки — `{ "code": "<stable>", "message": "<без ПДн>" }`:

| HTTP | code | Смысл для экрана |
| --- | --- | --- |
| 400 | `RESIDENT_CLIENT_REQUEST_INVALID` | ошибка клиента, не показывать «купите» |
| 401 | `RESIDENT_CLIENT_AUTH_REQUIRED` | сессия истекла → войти заново |
| 403 | `RESIDENT_CLIENT_FORBIDDEN` | не тот клиент/тенант |
| 409 | `RESIDENT_CLIENT_SUBSCRIPTION_INVALID` | абонемент не принадлежит/не активен |
| 404 | `RESIDENT_PASS_NOT_FOUND` (из CUP) | резидентство не найдено |
| 409 | `RESIDENT_TERM_EXPIRED` | срок резидентства истёк |
| 403 | `RESIDENT_NOT_ACTIVE` | резидентство неактивно |
| 429 | `RESIDENT_CLIENT_RATE_LIMITED` | слишком часто, повторить позже |
| 503 | `RESIDENT_CLIENT_NOT_CONFIGURED` | шлюз не настроен |
| 503 | `RESIDENT_CLIENT_DISABLED` | шлюз выключен |
| 503 | `RESIDENT_CLIENT_AUTH_UNAVAILABLE` | Keycloak недоступен |
| 503 | `RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE` | Viva/CUP недоступны |
| 503 | `RESIDENT_CLIENT_UPSTREAM_INVALID` | некорректный ответ CUP |
| 409 | `RESIDENT_CLIENT_SUBSCRIPTION_FROZEN` | абонемент заморожен |
| 503 | `RESIDENT_EVIDENCE_STALE`/`RESIDENT_EVIDENCE_INVALID`/`RESIDENT_MAPPING_*`/`RESIDENT_POLICY_*`/`RESIDENT_TYPE_NOT_FOUND` | данные временно недоступны (проброс кодов CUP) |
| 504 | `RESIDENT_CLIENT_UPSTREAM_TIMEOUT` | таймаут CUP |

Клиент дополнительно синтезирует `RESIDENT_CLIENT_SUBSCRIPTIONS_UNAVAILABLE`, когда список
абонементов ЛК ещё/уже недоступен, и не пытается угадывать резидентство.

Ответы шлюза: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. В ответе нет
ни integration token, ни адреса CUP, ни upstream-заголовков/тела ошибки. Логи шлюза
содержат только `event/code/httpStatus/durationMs/размер` и не содержат токенов,
Bearer, id подписки, субъекта и ПДн (проверяется guard-тестом).

### Проверка состояния пропуска (опционально)

```http
GET /lk/residency/passes/:passId
Authorization: Bearer <LK user token>
```

```json
{"schemaVersion":1,"statusAvailable":true,"state":"ACTIVE|CONSUMED|EXPIRED|UNKNOWN",
 "issuedAt":"<ISO|null>","expiresAt":"<ISO|null>","consumedAt":"<ISO|null>"}
```

Если `RESIDENT_CLIENT_CUP_PASS_STATUS_PATH` не задан — шлюз отвечает
`{"statusAvailable":false,"state":"UNKNOWN"}` и **не** обращается к CUP. Экран в этом
случае работает в деградированном режиме (см. «Выдача и остановка автогенерации»).

## Как определяется clientSubscriptionId

Клиент LK уже знает свои абонементы (`apiFetchSubscriptions` → `Subscription.subscriptionId`
— это точный Viva client subscription id; это же значение LK передаёт в
`/lk/subscription-bookings` как `clientSubscriptionId`).

Алгоритм экрана (без нового контракта):

1. Кандидаты — активные абонементы: `status` активен, `activationDate <= now < expirationDate`
   и `holdUntil` пуст/в прошлом.
2. Порядок — неавторитетная эвристика (CUP всё равно решает): сначала названия, похожие на
   «резидент»/`resident`, затем по убыванию `expirationDate`.
3. Экран по очереди (не более 3 кандидатов) вызывает `POST /lk/residency/passes` с явным
   `clientSubscriptionId`; переходит к следующему кандидату **только** при
   `RESIDENT_PASS_NOT_FOUND`/`RESIDENT_NOT_ACTIVE`/`RESIDENT_TERM_EXPIRED`; на 5xx/429
   останавливается и показывает «недоступно». Успешный id запоминается в `sessionStorage`,
   чтобы следующие генерации шли одним запросом.
4. Шлюз не доверяет присланному id: он читает `GET /end-user/api/v1/<tenant>/subscriptions`
   с Bearer пользователя и убеждается, что id принадлежит активному абонементу клиента
   (иначе 409 `RESIDENT_CLIENT_SUBSCRIPTION_INVALID`). CUP независимо проверяет владение
   (`clientRefHash`), состояние резидентства, политику, mapping и свежесть.

**Зафиксированное допущение:** CUP не сообщает клиенту, какой абонемент резидентский,
поэтому при нескольких активных абонементах возможен 1–2 «холостых» запроса. Если CUP
позже отдаст residency-признак абонемента (или маршрут «создать пропуск по владельцу»),
шаги 2–3 заменяются одним запросом без изменения экрана.

## QR-ссылка и станционный контекст

QR кодирует URL станционного экрана сотрудника (контракт C/E):

```text
https://padlhub.su/admin/residency/check#pass=<passToken>[&stationId=<stationId>]
```

Токен передаётся **во фрагменте** URL: фрагмент не уходит на сервер, не попадает в
access-log, не становится Referer и не требует очистки серверной части. Сотрудник
сканирует QR обычной камерой; экран E читает `location.hash` и очищает history.

- `VITE_RESIDENCY_CHECK_URL` переопределяет базу (default выше) и задаётся **без query и
  fragment**: клиент сам добавляет `#pass=…` и `&stationId=…`.
- `stationId` попадает в QR, если экран открыт по станционной ссылке
  `https://padlhub.ru/lk_new?residency=1&stationId=<id>`; сотрудник получает станцию
  предвыбранной. Клиент не хранит и не пересылает stationId никуда, кроме QR-ссылки.
- Контекст станции сохраняется в `sessionStorage` (`padlhub.residency.station.v1`) до
  успешного логина: незалогиненный пользователь видит форму входа, после входа кабинет
  сам открывает экран резидента с тем же stationId. Никаких privileged-токенов в
  `sessionStorage`, `localStorage` и `window` не появляется — только id станции.

## Состояния экрана (раздельные, без «купите заново»)

| Состояние | Причина | Что видит клиент |
| --- | --- | --- |
| `loading` | запрос пропуска | «Проверяем резидентство…» |
| `active` | 200, пропуск действует | QR, станция, тип и срок резидентства, таймер |
| `selecting` | несколько активных абонементов | выбор из активных абонементов |
| `no_subscription` | нет активных абонементов | «Нет активного абонемента» |
| `not_resident` | `RESIDENT_PASS_NOT_FOUND` | «Абонемент не даёт резидентство» |
| `frozen` | `holdUntil` в будущем | «Абонемент заморожен до …» |
| `term_expired` | `RESIDENT_TERM_EXPIRED` | «Срок резидентства истёк» + срок |
| `unavailable` | 503/504/`RESIDENT_EVIDENCE_*` | «Данные временно недоступны. Это не про покупку» + «Повторить» |
| `session_expired` | 401 | «Войдите снова» |
| `rate_limited` | 429 | «Слишком часто, подождите» |
| `offline` | сеть/offline | «Нет интернета»; действующий QR остаётся, просроченный — нет |
| `error` | прочее | нейтральная ошибка + повтор |

Offline: показывается только QR, чей `expiresAt` ещё в будущем; при истечении QR
перекрывается и помечается «истёк», никогда не выглядит действующим.

Состояние «нет фото» относится к станционному экрану E (фото резидента для сверки): клиентский
экран фото не показывает и не запрашивает профиль, поэтому в D его нет. Ошибка источника Viva
(503) — это `unavailable`, а не «нет резидентства» и не приглашение купить заново.

## Выдача и остановка автогенерации

- Пока экран видим, пользователь онлайн и пропуск не подтверждён — по истечении TTL
  создаётся новый пропуск (автоперегенерация), таймер идёт от серверного
  `issuedAt/expiresAt` (смещение часов вычисляется по первому ответу).
- При возврате вкладки из фона (`visibilitychange`) — немедленная перепроверка: пропуск
  просрочен → новый; статус подтверждён → «Выдано».
- Подтверждение выдачи: экран опрашивает `GET /lk/residency/passes/:passId` (только если
  `statusAvailable`); на `CONSUMED` показывает «Выдано» с временем и **останавливает**
  автогенерацию до явного действия «Показать новый QR».
- **Статус зависимости:** маршрут добавляется отдельным исполнителем в CUP-C (ветка
  `ph-admin`), в этой ветке CUP не меняется. Шлюз B уже реализует проксирование через
  `RESIDENT_CLIENT_CUP_PASS_STATUS_PATH`; если переменная не задана (или маршрут ещё не
  развёрнут: 404/503/сеть), шлюз отвечает `statusAvailable=false`, и экран остаётся в
  degraded-режиме: он не может отличить «выдано» от «истекло», поэтому автоперегенерация
  ограничена 3 циклами, после чего требуется явное действие кнопкой «Показать новый QR».
  Требуемый контракт CUP (реализуется в `ph-admin`, не в этой ветке):

  ```http
  GET /api/internal/subscriptions/resident-passes/:passId
  Authorization: Bearer <LK user token>
  X-Resident-Services-Integration-Token: <server token>

  200 {"schemaVersion":1,"passId":"...","state":"ACTIVE|CONSUMED|EXPIRED",
       "issuedAt":"<ISO>","expiresAt":"<ISO>","consumedAt":"<ISO|null>","stationId":"<id|null>"}
  404 {"error":{"code":"RESIDENT_PASS_NOT_FOUND",...}}   # чужой/несуществующий пропуск
  ```

  Проверка владения — по `clientRefHash`/tenant вызывающего LK Bearer (как в preview).

## Публикация и URL

- Новых страниц/бандлов и Tilda-блоков нет: экран живёт в существующем IIFE-бандле
  `bundle.js` (loader `docs/tilda-loader.html`), страница — действующая `https://padlhub.ru/lk_new`
  (`VITE_CABINET_URL`, dev `https://padlhub.ru/lk_dev`).
- Точка входа: секция «Резидентство» в кабинете (после «Абонементы и подписки») и
  станционная ссылка `/lk_new?residency=1&stationId=<id>` (алиасы `resident=1`,
  `residentPass=1`).
- Новые build-time переменные (все опциональны, default в коде):
  `VITE_RESIDENCY_PASS_ENABLED` (`true` включает экран; по умолчанию **выключен** до
  готовности шлюза и `RESIDENT_SERVICES_ENABLED`),
  `VITE_RESIDENCY_PASS_API_BASE` (default — origin SERV2),
  `VITE_RESIDENCY_CHECK_URL` (default `https://padlhub.su/admin/residency/check`).
- Порядок включения: импорт потока в Node-RED и его env → `RESIDENT_SERVICES_ENABLED=true`
  и правила преимуществ в CUP → сборка LK с `VITE_RESIDENCY_PASS_ENABLED=true` обычным
  frontend-выпуском → проверка на одном телефоне.

## Риски и откат

- **Риск:** клиент может указать чужой `clientSubscriptionId`. Контроль: проверка владения
  в шлюзе (Viva) + `clientRefHash`/tenant в CUP; чужой id даёт 409/404, пропуск не создаётся.
- **Риск:** утечка integration token. Контроль: токен читается только из env Node-RED,
  не попадает в ответ, в логи и в бандл (guard-тест на отсутствие в import JSON и в
  ответах/варнингах).
- **Риск:** открытый QR после выдачи. Контроль: TTL ≤ 120 c, просроченный QR никогда не
  показывается действующим, после подтверждения автогенерация останавливается.
- **Откат:** `VITE_RESIDENCY_PASS_ENABLED=false` + пересборка (секция и ссылки исчезают),
  `RESIDENT_CLIENT_ENABLED=false` на Node-RED (503 без обращения к CUP), удаление потока —
  отдельным согласованным импортом. Данные CUP не меняются.

## Проверки (LOCAL)

```bash
npm run test:residency-client    # модель состояний/таймер/офлайн/выдача + клиент шлюза
npm run test:residency-gateway   # guard-тесты Node-RED функций и сборщика import JSON
npx tsc -b
npx eslint src/residency scripts/tests/residency*.mjs scripts/tests/residency*.ts
npx vite build --mode dev        # бандл, без публикации
```

Не выполнялись и не заявляются: импорт потока в Node-RED, deploy, публикация, Tilda,
STAGING/PRODUCTION-проверки, реальные вызовы CUP/Viva.
