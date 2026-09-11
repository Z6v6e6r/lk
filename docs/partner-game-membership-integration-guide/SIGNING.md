# Подпись запросов

Каждый запрос подписывается HMAC-SHA256 по канонической строке. TLS обязателен, но
сам по себе не защищает запрос после терминации, поэтому подпись и nonce нужны на
уровне приложения. Дополнительно пилот требует mTLS: сертификат и HMAC-ключ — разные
факторы, терять ни один нельзя.

## Заголовки

Все восемь proof-заголовков нужны **на всех трёх методах, включая GET**. Каждый —
ровно один раз; дублирование critical-заголовков отклоняется.

| Заголовок | Формат | Назначение |
| --- | --- | --- |
| `X-PadlHub-Client-Id` | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}` | Выданный M2M client ID |
| `X-PadlHub-Audience` | `[a-z0-9][a-z0-9._:-]{2,127}` | Точная audience окружения |
| `X-PadlHub-Key-Id` | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}` | Версия ключа для ротации |
| `X-PadlHub-Timestamp` | ровно 10 цифр, Unix seconds | Окно ±90 секунд |
| `X-PadlHub-Nonce` | `[A-Za-z0-9_-]{22,128}` | Новый криптослучайный base64url |
| `X-PadlHub-Signature` | `v2=` + base64url (43 символа) | HMAC-SHA256 |
| `Idempotency-Key` | lowercase UUID | Идентификатор бизнес-команды |
| `X-Correlation-ID` | lowercase UUID | Трассировка попытки |

`Host` должен совпадать с утверждённым ingress. `Content-Type: application/json` — без
`charset`. Для POST/DELETE нужен точный `Content-Length` в UTF-8 байтах; GET — без тела
(`Content-Length` отсутствует или `0`). Chunked transfer и content encoding использовать
нельзя.

UUID — lowercase, версия 1–5, вариант `8/9/a/b` (обычный `crypto.randomUUID()` подходит).

## Канонический JSON

Хешируется каноническое представление тела, а не исходная строка. Диалект проекта:

- ключи объектов рекурсивно сортируются как JS UTF-16 code units (обычный `Array#sort()`);
- строки экранируются как `JSON.stringify`, без Unicode-нормализации;
- массивы сохраняют порядок;
- числа — только safe integers; `-0` превращается в `0`;
- дубли ключей и невалидный UTF-8 запрещены (их ловит серверный raw guard).

Это не RFC 8785. `sha256` считается от UTF-8 байтов канонической строки, hex в нижнем
регистре.

Пример: тело

```json
{
  "externalPlayerId": "player-001",
  "displayName": "Test Player",
  "payment": { "reference": "pay-001", "paidAt": "2026-09-01T08:59:00.000Z", "amountMinor": 250000, "currency": "RUB" }
}
```

канонизируется в

```json
{"displayName":"Test Player","externalPlayerId":"player-001","payment":{"amountMinor":250000,"currency":"RUB","paidAt":"2026-09-01T08:59:00.000Z","reference":"pay-001"}}
```

`sha256` = `38e85283a47d9c00aab3a4dbda49757cbd3f031c32f524376420e245d9ca6d66`.

## Строка подписи

Ровно 11 строк, соединённых `\n`, **без завершающего `\n`**:

```text
PADLHUB-PARTNER-GAME-V2
<audience>
<client-id>
<key-id>
<unix-seconds>
<nonce>
<UPPERCASE-METHOD>
<exact-path-without-query>
<sha256(canonical-json-body)>
<idempotency-key>
<correlation-id>
```

`path` — точный относительный путь API, без host, query, fragment, percent-encoding и
нормализации сегментов. Для GET и DELETE body в подписи — канонический `{}`
(`DELETE` отправляет body ровно `{}` — 2 байта; `GET` body не отправляет, но
подписывает `{}`).

Подпись: `v2=` + `base64url(HMAC-SHA256(secret, canonical-string))`, без `=`-паддинга.
Секрет — минимум 32 байта. Секрет передаётся вне API и никогда не попадает в request,
flow или репозиторий. Сравнение подписи на сервере — constant-time.

### Формат секрета

- Боевые ключи в нашем keyring хранятся как **base64url**-строка.
- Публичный тестовый ключ офлайн-комплекта — литеральная UTF-8 строка
  `public-test-vector-key-32-bytes!!` (33 байта), **не** base64url.

В `sign.mjs` формат задаётся явно: `--secret-format base64url` (по умолчанию) или
`--secret-format utf8`.

## Проверенный пример

Публичный vector (только для contract test, боевым не является):

```text
clientId:    partner-test
audience:    padlhub-partner-game-test
keyId:       key-2026-09
timestamp:   1788253200
nonce:       MDEyMzQ1Njc4OWFiY2RlZjAxMjM0
method:      POST
path:        /lk/integrations/v1/open-games/game-001/members
signature:   v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo
```

`sign.mjs` воспроизводит эти значения; см. [QUICKSTART.md](QUICKSTART.md).

## `sign.mjs`

```sh
node sign.mjs \
  --client-id partner-test --audience padlhub-partner-game-test \
  --key-id key-2026-09 --secret 'public-test-vector-key-32-bytes!!' --secret-format utf8 \
  --method POST --path /lk/integrations/v1/open-games/game-001/members \
  --body ./member.json --json
```

`--json` печатает `headers`, `canonicalBody`, `signatureInput` и `bodySha256`. Без
`--json` печатает готовые `curl -H ...` строки. `--timestamp`, `--nonce`,
`--idempotency-key` и `--correlation-id` можно задать вручную (по умолчанию —
текущее время и случайные значения).

## Частые ошибки

- Подписать исходный JSON, а не каноническую форму, — сервер хеширует каноническую.
- Переиспользовать nonce или timestamp для новой попытки — нужен новый proof.
- Добавить `?query` в path — query и fragment запрещены.
- Base64url с `=`-паддингом в подписи — не нужен.
- Забыть один из восьми заголовков на GET.
- Переслать перехваченный wire-запрос заново — nonce уже использован, будет
  `409 REQUEST_REPLAY_DETECTED`.
