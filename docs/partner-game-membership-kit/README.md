# Partner API: офлайн-комплект проверки контракта

Статус: **OFFLINE ONLY**. Эти три файла нужны, чтобы подготовить клиент без сервера,
Docker, Viva и доступа к игре. Комплект не является
production SDK, HTTP-клиентом, валидатором произвольных запросов или разрешением на
подключение. Боевой URL, credentials и персональные данные сюда не входят.

## Запуск

Скопируйте всю эту папку и выполните из неё (Node.js 22+, без `npm install`):

```sh
node contract-selftest.mjs --self-test
```

Ожидается exit code `0` и ровно одна строка:

```text
OFFLINE_CONTRACT_VECTORS_PASS vectors=5 network=NOT_USED live_security=NOT_TESTED
```

`vectors.json` содержит пять фиксированных входов и ожидаемые canonical body,
SHA256, полную строку подписи, HMAC, wire body и его размер в UTF-8 bytes.
`contract-selftest.mjs` вычисляет их независимо от backend и сравнивает с сохранёнными
значениями. Вы должны получить те же значения **своей реализацией**, а не только
запустить приложенный пример. Исходный опубликованный POST vector не изменён.
Успешный self-test не удостоверяет происхождение изменённого комплекта.

| Vector | Что сравнить |
| --- | --- |
| `POST_BASE` | Добавление synthetic `player-001`, включая локальную проекцию внешней оплаты |
| `POST_RETRY` | Те же method/path/body/Idempotency-Key; новые timestamp, nonce, correlation и подпись |
| `DELETE_OWNED` | Путь с synthetic membership UUID; wire body строго `{}`: 2 bytes |
| `GET_OPERATION` | Путь с synthetic operation UUID; wire body отсутствует: 0 bytes, но подписывается `{}` |
| `POST_UNICODE` | Кириллица и emoji; размер тела считается в UTF-8 bytes, не в символах |

Все значения вымышлены. Public test key — UTF-8 literal
`public-test-vector-key-32-bytes!!`, **не base64-decoded** и никогда не боевой ключ.
Timestamp и nonce намеренно фиксированы; retry «новый» только относительно первого
fixture. Не отправлять эти запросы на живую среду и не регистрировать demo identity
в её keyring. CLI не принимает ключи, URL или произвольный fixture path и не читает
переменные окружения для настройки интеграции; неверный вызов даёт закрытую ошибку.

## Байтовый контракт и HTTP

Canonical JSON: ключи объектов рекурсивно сортируются как JS UTF-16 code units,
без locale sorting; строки экранируются как `JSON.stringify`, без Unicode
normalization. Массивы сохраняют порядок. Числа — только safe integers; `-0` → `0`.
Это собственный диалект проекта, не общее обещание совместимости с RFC 8785.
Порядок ключей и whitespace в корректном POST wire JSON могут отличаться: хешируется
canonical representation, не исходная строка. Duplicate keys и невалидный UTF-8
запрещены; `JSON.parse` этого примера не заменяет серверный raw guard.

Строка подписи — ровно 11 строк через LF, **без LF в конце**: version, audience,
clientId, keyId, timestamp, nonce, METHOD, exact path, lowercase body SHA256,
Idempotency-Key, correlation. HMAC-SHA256 выдаётся как `v2=` + base64url без `=` padding.
Path — только точный относительный API path, без host/query/fragment/percent encoding
или нормализации сегментов. Не менять JSON после вычисления его canonical hash.

На **всех трёх методах**, включая GET, нужны восемь proof headers:
`X-PadlHub-Client-Id`, `X-PadlHub-Audience`, `X-PadlHub-Key-Id`,
`X-PadlHub-Timestamp`, `X-PadlHub-Nonce`, `X-PadlHub-Signature`,
`Idempotency-Key`, `X-Correlation-ID`. Каждый ровно один раз. `Host` отдельно должен
совпасть с утверждённым ingress. POST/DELETE: `Content-Type: application/json`
без `charset`, явный `Content-Length` в UTF-8 bytes. GET: body отсутствует,
Content-Length отсутствует либо `0`; Content-Type можно опустить. Не использовать
chunked transfer или content encoding. Демонстрационные UUID не являются реальными
membership/operation ID: в интеграции сохраняются ID из ответов API.

## Повторы и права

- Новая бизнес-команда: новый Idempotency-Key. Каждая HTTP-попытка: актуальный Unix
  timestamp, новый криптографически случайный nonce, correlation UUID и подпись.
- Обрыв до получения ответа: повторить ту же команду с прежним Idempotency-Key и
  прежним body, но новым proof. Не создавать вторую бизнес-команду «на всякий случай».
- `202 UNKNOWN`/незавершённая операция: читать её через GET, передать в reconciliation;
  не выполнять слепые provider retry или автоматический DELETE/возврат денег.
- `409 REQUEST_REPLAY_DETECTED`: не пересылать захваченный HTTP request заново.
  `IDEMPOTENCY_CONFLICT`: остановиться и исправить несоответствие команды, а не
  обходить конфликт случайной заменой ключа.
- `401/403`: остановить mutation и проверить доступ с владельцем интеграции.
  Удалять можно только собственный membership этого integration client, не игрока
  из LK, Viva или чужой системы. `PAID` — ваше заявление о внешнем расчёте, не
  банковское или фискальное подтверждение и не проведение платежа в Viva.

HMAC + nonce защищают от повторов после приёма оригинала. Защита от пересылки
оригинала раньше клиента требует отдельной транспортной аутентификации mTLS и
проверенной привязки клиента. Self-test **не доказывает** mTLS, durable replay409,
idempotency/recovery, audit persistence, отсутствие повторного Viva call или
недоступность обходного порта.

## Самостоятельная интеграция клиента

Анкета, согласование P0 и отчёт о прохождении vectors **не требуются**. PadlHub
предоставляет методы и фиксированный контракт; вы отвечаете за реализацию своего
клиента. Vectors служат для самостоятельной проверки. Credentials, request dumps
и персональные данные присылать не нужно.

1. **P0 для клиента:** HMAC/mTLS, key custody, время/nonce, стабильные ID, внешняя
   оплата, retry/idempotency/UNKNOWN и соблюдение серверных ограничений.
2. **P1 для клиента:** backoff/лимиты, наблюдаемость без секретов, сохранение operationId,
   обработка отзыва доступа и совместимость версий.
3. **P2:** bulk/webhooks/group payments не входят в текущий API и не блокируют выпуск.

Работа endpoint, серверная безопасность, audit, Mongo и взаимодействие PadlHub–Viva
остаются ответственностью PadlHub. Отсутствие обязательной анкеты не заменяет наши
интеграционные проверки и не означает, что live endpoint уже включён.

Остальные документы комплекта: [присоединение к существующей игре](../partner-game-membership-integration-guide/JOIN_EXISTING_GAMES.md),
[подпись](../partner-game-membership-integration-guide/SIGNING.md),
[ошибки](../partner-game-membership-integration-guide/ERRORS.md),
[повторы](../partner-game-membership-integration-guide/IDEMPOTENCY.md).

Боевой endpoint активирован; рабочий адрес, credentials и mTLS-сертификат выдаются
индивидуально и не входят в этот комплект. Self-test проверяет только контракт подписи
и не заменяет приёмку из
[ACCEPTANCE_TESTS.md](../partner-game-membership-integration-guide/ACCEPTANCE_TESTS.md).
