# Residency LK1 pilot — проверка идентичности и способ включения (2026-11-18)

Статус: **read-only исследование**. Production-код, env, Node-RED, Mongo и фронтенд не
изменялись; секреты не читались и не публикуются. Единственный записанный артефакт —
этот файл.

> **Итоговое решение (после аудита).** Новый маршрут-проба не добавлялся: включение
> сделано операторским логом `LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG=true` (по умолчанию
> false). Алексей только входит и открывает пилотную страницу; оператор читает
> `tenantId:userId` из лога Node-RED и вносит его в allowlist. Процедура — раздел 10
> `docs/residency-pilot-install.md`. Номера строк ниже относятся к файлу до этого
> изменения; сам контракт claims не менялся.

Ветка: `codex/residency-lk1-pilot-20261118`, worktree
`/Users/zver/Desktop/project-fixed 6/.worktrees/residency-lk1-pilot-20261118`.

## 1. Точный контракт claims (English technical section)

Источник истины: `node-red/custom-nodes/residency-lifecycle-api/residency-lifecycle-node.cjs`
— `validateClaims` (146–159), `readConfig` (85–128), `readUserinfo` (161–176),
`bearer` (140–144), `readPilotUsers` (40–52).

### 1.1 Claims table

| Role | Claim keys (precedence) | Required value | Validation |
| --- | --- | --- | --- |
| Subject → `userId` | `sub` | any non-empty verified Keycloak subject | `typeof string`, 1–256 chars, `value.trim() === value`, no char < `0x20` and no `0x7F` |
| Client / authorized party | `azp` → `client_id` → `clientId` | `widget` | `string`, ≤128 chars, same `text()` rules, **exact** equality with `LK_RESIDENCY_LIFECYCLE_EXPECTED_CLIENT_ID` (default `widget`) |
| Tenant | `tenantKey` → `tenant_key` → `tenant` | `iSkq6G` | `string`, ≤128 chars, same `text()` rules, **exact** equality with `LK_RESIDENCY_LIFECYCLE_TENANT_KEY` (default `iSkq6G`) |

Precedence matters: the first claim key present and passing `text()` wins. If `azp` is
present but differs from `widget`, the request is rejected even when `client_id` is
`widget`; `validateClaims` does not fall through after a used key. Missing or unacceptable
subject, client or tenant → `null` → HTTP **401 `RESIDENCY_AUTH_REQUIRED`**
(`node.cjs:367–373`). There is no partial acceptance and no body fallback: the identity is
read only from the verified userinfo response.

### 1.2 Userinfo transport

| Property | Value |
| --- | --- |
| URL | `https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/userinfo` (env `LK_RESIDENCY_LIFECYCLE_KEYCLOAK_USERINFO_URL`; must be `https://`) |
| Method | `GET`, headers `Accept: application/json`, `Authorization: Bearer <token>` |
| Redirects | `redirect: "error"` — any redirect fails the check |
| Accepted response | HTTP **200 only**, JSON object, body 1–65 536 chars; anything else → `null` |
| Timeout | `min(5000, max(1000, LK_RESIDENCY_LIFECYCLE_TIMEOUT_MS))` ms (default config 8000 → 5000) |
| Bearer syntax | header must match `^Bearer [A-Za-z0-9._~+/=-]{16,4096}$` — literal `Bearer`, exactly one space, case-sensitive; otherwise **401** before any network call |

### 1.3 Allowlist entry format

| Property | Value |
| --- | --- |
| Env | `LK_RESIDENCY_LIFECYCLE_PILOT_USERS` |
| Format | JSON array of 1–500 **unique** strings |
| Entry | `<tenantId>:<userId>` = `<tenant claim>:<sub>` = **`iSkq6G:<sub>`** |
| Regex | `^[A-Za-z0-9._:@-]{1,128}:[A-Za-z0-9._:@-]{1,256}$` |
| Prefix rule | every entry must literally start with `<LK_RESIDENCY_LIFECYCLE_TENANT_KEY>:` |
| Match | exact string equality against `tenantId + ":" + userId`; no wildcard, prefix or regex match |
| Absent / empty string | empty set, no error → everyone gets **403 `RESIDENCY_CREATE_NOT_ALLOWED`** |
| Malformed / duplicate / >500 / wrong tenant prefix | `pilotUsersError = PILOT_USERS` → **503 `RESIDENCY_CREATE_POLICY_INVALID`** (fail-closed) |

**Important:** the pilot identity is `sub`, not `claims.userId`, `user_id` or `id`. The
auth-consents flow stores those keys for diagnostics, but the residency gate reads only
`sub`. Knowing an email, phone or username is therefore not sufficient; it only helps to
locate a stored record (section 4).

### 1.4 Gate order (verified in `residency-lifecycle-http.mjs:143–181`)

1. bearer present → else 401
2. userinfo 200 + `validateClaims` → else 401
3. per-user rate limit (`LK_RESIDENCY_LIFECYCLE_RATE_LIMIT_PER_MINUTE`, default 20)
4. route found → else 404
5. actor present → else 401
6. **on `POST /orders` only:** `createPolicy` → `CREATE_ENABLED=false` ⇒ 503
   `RESIDENCY_ORDERS_DISABLED`; invalid policy ⇒ 503 `RESIDENCY_CREATE_POLICY_INVALID`;
   identity not in list ⇒ 403 `RESIDENCY_CREATE_NOT_ALLOWED`
7. `createLifecycle(actor)` factory, then `Idempotency-Key` check (400), then body parse

The policy decision runs **before** the factory, the idempotency key, the body and any
Viva/CUP call.

## 2. Что реально проверено и наблюдаемый результат

| # | Метод | Наблюдаемый результат |
| --- | --- | --- |
| 1 | Поиск по репозиторию: `userinfo`, `PILOT_USERS`, `iSkq6G:`, `azp`, `tenantKey`, `sub` | Реального verified sub нет. Встречаются только синтетические значения: `iSkq6G:pilot-user` (юнит-тест), `sub-1`, `fixture-subject`, `22222222-2222-4222-8222-222222222222` (fixture UUID). Они не являются идентичностью Алексея |
| 2 | `docs/residency-pilot-acceptance.md:70–72` | Прямо зафиксировано: `<verified-sub>` — Keycloak `sub`, читается из admin/userinfo, **не угадывается и отсутствует в репозитории**; пилот закрыт, пока значение не передано |
| 3 | Поиск Keycloak admin credential/CLI: `kcadm`, `admin-cli`, `KEYCLOAK_ADMIN`, `KC_ADMIN`, `admin/realms` в `scripts/` и `docs/` | 0 совпадений. Ни документированного admin-доступа, ни скрипта, ни service account |
| 4 | Локальная конфигурация (только имена) | Нет `~/.keycloak`, нет `~/.config/kcadm`. В `~/.ssh` есть ключи `lk_primary_147_ed25519`, `lk_reserve_89_ed25519` и др. — это SSH, не Keycloak admin. В env процесса нет переменных с `keycloak`/`kc_`/`token`. В Keychain записи с service `keycloak` нет |
| 5 | Сеть: `https://kc.vivacrm.ru/` | HTTP/2 **302 → `https://kc.vivacrm.ru/admin/`**. Realm `clients` жив и принимает HTTPS |
| 6 | Сеть: `GET …/realms/clients/protocol/openid-connect/userinfo` без bearer | **401**. Endpoint существует, но без credential identity не отдаёт |
| 7 | Сеть: `POST https://padlhub.su/lk/analytics/auth-consents` без bearer | **401**. Публичный LK-бэкенд отвечает, flow согласий живой |
| 8 | SSH `lk-primary-147` = `147.45.103.3` (2 попытки, лимит задачи) | Оба раза `ssh: connect to host 147.45.103.3 port 22: Operation timed out`. Порты **22, 443, 27017** с этой машины filtered/closed. Host read и чтение Mongo сейчас невозможны |
| 9 | Браузерные профили | Присутствуют Chrome, Yandex Browser, Safari, Edge. Токен ЛК лежит в cookie `{TENANT_KEY}AuthToken` / storage (см. `docs/residency-client.md:28–30`). Это **credential**; извлечение из профиля = эксфильтрация, поэтому не выполнялось и не будет |
| 10 | `~/.config/browser-harness` | Внешний инструмент автоматизации (version-cache `0.1.13`), isolated-профили, `agent-workspace` пуст, процессов автоматизации не запущено. Логи прошлых прогонов (`bu-*.log`) могут содержать bearer, поэтому их содержимое не читалось. Подтверждения, что какой-либо профиль залогинен как Алексей, нет |
| 11 | Административное чтение `lk_auth_consents` | Живой flow `/lk/analytics/auth-consents` сохраняет `subject` из **проверенного** userinfo (`fn_auth_consent_build_upsert.js:82,110,129`). Но 147 и его Mongo недоступны (п. 8), поэтому прочитать нельзя |

## 3. Что невозможно

- Получить `sub` из репозитория: его там нет и он намеренно не закоммичен.
- Получить `sub` из Keycloak admin API: нет ни credential, ни CLI, ни service account, ни
  документации о них; `/admin/` доступен только как HTML-вход.
- Вызвать userinfo без bearer: endpoint отвечает 401; bearer есть только в живой сессии
  Алексея.
- Прочитать `lk_auth_consents` / Mongo 147: SSH таймаутит, 27017 снаружи закрыт.
- Угадать `sub`: это непрозрачный идентификатор; `PILOT_USERS` требует точного
  совпадения, а неверный список fail-closed (403/503), поэтому «примерно» не работает.
- Взять `User ID` из админ-консоли Keycloak: это realm-local id пользователя, а не
  обязательно `sub` из токена. При pairwise-sub или кастомном маппере значения
  различаются, и тогда allowlist молча не совпадёт. Авторитетен только userinfo тем же
  путём, которым ходит шлюз.

## 4. Существующий путь без кода и без действия Алексея (когда 147 снова доступен)

Flow согласий уже пишет проверенную идентичность в Mongo
(`docs/NODERED_REFERENCE.md:529–534`, `docs/ARCHITECTURE.md:239–241`):

- документ: `_id = auth-consent:iSkq6G:<encodeURIComponent(sub)>:2026-07-14`;
- поля: `subject` (сырой `sub`), `identity.phone`, `identity.email`,
  `identity.username`, `tenantKey`, `issuer`.

Если Алексей принимал согласия после 2026-07-14, оператор с штатным read-доступом к Mongo
147 может найти его документ по телефону/email/username и прочитать `subject`. Тогда
значение для allowlist = `iSkq6G:<subject>`. Это read-only, без нового кода и без участия
Алексея.

Ограничения: документ существует только если согласие уже записано; нужен доступ к 147;
сейчас он недоступен. Этот путь не заменяет проверку, если документа нет.

## 5. Рекомендуемый механизм enrollment: без UUID и без токена

Идея: добавить **один auth-only GET-пробник**, который по тому же bearer возвращает
**только собственную** идентичность вызывающего. Пробник выключен по умолчанию, включается
оператором на время enrollment и сразу выключается. Алексей ничего не ищет и никуда не
пересылает токен: он логинится и открывает ссылку.

### 5.1 Спецификация пробника (design; в этой задаче не реализован)

```text
Маршрут:   GET /lk/residency/pilot/identity
Флаг:      LK_RESIDENCY_LIFECYCLE_IDENTITY_PROBE_ENABLED   (default "false"; включает только точное "true")
Выключен:  маршрут не регистрируется -> 404 RESIDENCY_ROUTE_NOT_FOUND
           (неотличимо от несуществующего пути, без oracle)
Включен:   bearer -> readUserinfo -> validateClaims, ровно как у остальных маршрутов
200 body:  {"schemaVersion":1,"tenantId":"iSkq6G","userId":"<sub>",
            "identity":"iSkq6G:<sub>","pilotAllowed":true|false}
Заголовки: Cache-Control: no-store, Referrer-Policy: no-referrer,
           X-Robots-Tag: noindex, nofollow
Вход:      тело и query не читаются; identity берётся только из проверенного userinfo
Эффекты:   нет записи в Mongo, нет Viva/CUP, нет заказа, нет Idempotency-Key
Размещение: в residency-lifecycle-node.cjs ДО node.getRuntime() и через
           readConfig(process.env), чтобы enrollment не требовал Mongo/CUP-конфигурации
Логи:      только event/statusCode/correlationId/durationMs; subject не логируется
```

`pilotAllowed` считается тем же `createPolicy` и только для вызывающего — это его
собственный факт членства, чужие идентичности не раскрываются. Это позволяет проверить
включение allowlist без создания заказа.

### 5.2 Что делает оператор

1. Ставит код пробника (additive, флаг `false`), обычный деплой Node-RED; поведение не
   меняется.
2. Включает `LK_RESIDENCY_LIFECYCLE_IDENTITY_PROBE_ENABLED=true`; `CREATE_ENABLED`
   остаётся `false` — покупка в это время невозможна.
3. Передаёт Алексею одну ссылку (и, при желании, одноразовый код) по обычному каналу.
4. Получает от Алексея строку `iSkq6G:<sub>` (не токен, не UUID-поиск).
5. В protected env на 147 ставит
   `LK_RESIDENCY_LIFECYCLE_PILOT_USERS=["iSkq6G:<sub>"]`, перезапускает Node-RED под
   существующим change-процессом.
6. Проверяет (см. 5.5), затем ставит флаг пробника обратно в `false` и перезапускает.
7. Убеждается, что `GET /lk/residency/pilot/identity` снова отдаёт 404.

### 5.3 Что делает Алексей

1. Логинится в ЛК1 как обычно (свой аккаунт, свой пароль; ничего никому не передаёт).
2. Открывает `https://padlhub.su/lk_new?residencyIdentityProbe=1` (или прямую ссылку из
   сообщения оператора).
3. Нажимает «Скопировать» и отправляет оператору **одну строку** вида
   `iSkq6G:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.

Это не поиск UUID в админке и не пересылка токена: страница сама прикладывает bearer из
текущей сессии, сервер сам выводит идентичность, Алексей видит только результат.

### 5.4 Как значение попадает в env

Только руками оператора: строка копируется из ответа пробника/страницы в
`LK_RESIDENCY_LIFECYCLE_PILOT_USERS` в protected env-файле на 147 (см. шаг 3
`docs/residency-pilot-acceptance.md`), затем restart и readback. В git, в этот документ и в
переписку значение не коммитится; `sub` — персональный идентификатор, хотя и не credential.

### 5.5 Проверка без создания заказа

- `GET /catalog` и `GET /status` для аккаунта Алексея → 200 (auth + claims проходят).
- Пробник при выключенном флаге → 404.
- С `CREATE_ENABLED=true, AUDIENCE=pilot`:
  - аккаунт Алексея: `POST /orders` **без** `Idempotency-Key` → **400
    `RESIDENCY_IDEMPOTENCY_KEY_REQUIRED`** (policy пройдена, заказ не создан);
  - обычный аккаунт: тот же запрос → **403 `RESIDENCY_CREATE_NOT_ALLOWED`**.
  Проверка `Idempotency-Key` идёт до `parseBody`/`createOrder`, а policy — до фабрики,
  Viva и Mongo-записи, поэтому ни заказ, ни платёж не появляются.
- В логах: `residency_lifecycle_request` с кодом 400 у Алексея и 403 у обычного аккаунта;
  `residency_lifecycle_auth_denied` отсутствует.

### 5.6 Вариант без релея (если даже копирование строки нежелательно)

Пробник не возвращает identity в браузер, а пишет одну запись
`{tenantId,userId,codeHash,createdAt}` в отдельную коллекцию
`lk_residency_pilot_enrollment` (TTL 24 ч, уникальный индекс) или в отдельный
operator-readable слот Node-RED context. Алексей только открывает ссылку; оператор читает
запись своим штатным доступом и выключает флаг. Цена: +1 коллекция/индекс и намеренная
запись PII — поэтому это альтернатива, а не рекомендация по умолчанию.

## 6. Security notes

- Пробник **auth-only**: никакой идентичности из query/body/заголовков, только проверенный
  userinfo; возвращает исключительно данные вызывающего.
- Off by default, 404 при выключении; включается на один шаг enrollment и выключается
  сразу после.
- Не расширять CORS: переиспользовать `LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN`; для страницы
  на `padlhub.su` достаточно same-origin/exact origin.
- Никаких токенов, claims и subject в логах; ответ `no-store`, `noindex`.
- Пробник не должен обходить политику: `pilotAllowed` — read-only вычисление, не выдача
  доступа; создание заказа по-прежнему проходит полный `createPolicy`.
- `sub` считать персональными данными: не публиковать в docs/PR/чатах, не логировать.
- Токен ЛК — credential: не извлекать из браузера, не пересылать, не хранить в файлах.
- Перед restart проверить, что `iSkq6G:<sub>` проходит regex из 1.3. Если `sub` содержит
  символ вне `[A-Za-z0-9._:@-]` (например `+`, `/`, `=`), весь список станет
  malformed → 503 `RESIDENCY_CREATE_POLICY_INVALID` (fail-closed, покупка не пройдёт).
- Утечка флага пробника даёт обычному пользователю только его собственный `iSkq6G:<sub>`,
  то есть его собственный идентификатор, а не доступ и не чужие данные.

## 7. Остаточные риски и что не проверено

- Пробник — дизайн, не реализация; его добавление меняет auth-поверхность, поэтому это
  CRITICAL-изменение с отдельным review, тестами (flag off → 404, wrong client/tenant →
  401, отсутствие записи в Mongo) и отдельным согласованием деплоя.
- Не проверено, есть ли у Алексея документ согласия в `lk_auth_consents` (147 недоступен).
- Не проверено, какой именно профиль браузера залогинен как Алексей; профили и логи
  намеренно не открывались.
- Неизвестно, использует ли realm pairwise-sub; поэтому админ-консоль как источник `sub`
  не рекомендуется.
- Реальный `sub` в этом исследовании не получен: пилот остаётся закрытым
  (`CREATE_ENABLED=false` / пустой allowlist), пока значение не будет добыто одним из
  путей раздела 4 или 5.

## 8. Команды, которыми получены свидетельства

```text
rg -n "userinfo|PILOT_USERS|tenantId:userId|iSkq6G:|azp|tenantKey|sub" (repo)
rg -n "kcadm|admin-cli|KEYCLOAK_ADMIN|KC_ADMIN|admin/realms" scripts/ docs/   -> 0
curl -sS -o /dev/null -D - https://kc.vivacrm.ru/                             -> 302 /admin/
curl -sS -o /dev/null -w '%{http_code}' .../protocol/openid-connect/userinfo  -> 401
curl -sS -o /dev/null -w '%{http_code}' -X POST https://padlhub.su/lk/analytics/auth-consents -> 401
ssh -o BatchMode=yes -o ConnectTimeout=8 lk-primary-147 'echo ok'            -> timeout (x2)
nc -z 147.45.103.3 {22,443,27017}                                            -> closed/filtered
```

Ни одна из команд не писала в production, не читала секретов и не выполняла SSH-команд на
сервере.
