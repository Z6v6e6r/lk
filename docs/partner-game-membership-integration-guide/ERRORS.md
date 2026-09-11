# Коды ошибок и повторы

Тело ошибки:

```json
{ "error": { "code": "GAME_NOT_OPEN", "message": "…", "operationId": "<uuid|null>", "correlationId": "<uuid>" } }
```

`message` — для человека, не для ветвления логики. Ветвитесь по `code`. `operationId`
может присутствовать, если операция уже создана — тогда её состояние читается через
`GET`.

## 400 — исправить запрос

| Код | Значение |
| --- | --- |
| `INVALID_REQUEST_BODY` | Тело не объект или нарушает закрытую схему |
| `UNKNOWN_REQUEST_FIELD` | Неизвестное поле (схема закрытая) |
| `INVALID_EXTERNAL_PLAYER_ID` / `INVALID_DISPLAY_NAME` | Недопустимое значение игрока |
| `INVALID_PAYMENT_REFERENCE` / `INVALID_PAYMENT_AMOUNT` / `INVALID_PAYMENT_CURRENCY` / `INVALID_PAYMENT_TIME` | Недопустимое поле `payment` |
| `INVALID_IDEMPOTENCY_KEY` / `INVALID_CORRELATION_ID` | Не lowercase UUID |
| `INVALID_REQUEST_PATH` | Неизвестный маршрут |
| `AMBIGUOUS_AUTH_HEADER` / `INVALID_AUTH_HEADER` | Заголовки proof отсутствуют, дублированы или некорректны |
| `INVALID_JSON_NUMBER` / `INVALID_JSON_VALUE` | Не safe integer или недопустимое JSON-значение |
| `RAW_*` (`RAW_BODY_SIZE`, `RAW_HEADERS_SIZE`, `RAW_JSON_DUPLICATE_KEY`, `RAW_HEADER_DUPLICATE`, `RAW_JSON_INVALID`, `RAW_CONTENT_TYPE_INVALID`, `RAW_FRAMING_INVALID`, `RAW_HOST_INVALID`, `RAW_PEER_INVALID`, `RAW_SECURITY_HEADER_INVALID`, `RAW_JSON_COMPLEXITY`, …) | Отказ защитного слоя ingress до бизнес-логики |

**Повтор:** исправить причину и отправить новую бизнес-команду с новым proof. Слепой
повтор того же тела бессмысленен.

## 401 — подпись и время

| Код | Значение |
| --- | --- |
| `INVALID_SIGNATURE` | HMAC не совпал |
| `INVALID_AUDIENCE` | `X-PadlHub-Audience` не совпал с серверной |
| `INVALID_TIMESTAMP` | Формат timestamp или выход за окно ±90 с |
| `REQUEST_EXPIRED` | Запрос просрочен |
| `INVALID_NONCE` | Nonce не по формату |

**Повтор:** синхронизировать часы, проверить keyId/секрет/audience и каноническую
строку, затем отправить **новую попытку** с новым timestamp, nonce, correlation и
подписью, сохранив прежний `Idempotency-Key` и тело.

## 403 — доступ

| Код | Значение |
| --- | --- |
| `SCOPE_DENIED` | У клиента нет нужного scope |
| `CLIENT_DISABLED` | Integration client отключён |
| `STATION_ACCESS_DENIED` | Станция игры не в allowlist клиента |
| `GAME_ACCESS_DENIED` | Игра не в allowlist клиента |
| `MEMBERSHIP_NOT_OWNED` | Membership создан не этим client |

**Повтор:** не повторять. Проверить доступ с владельцем интеграции.

## 404 — не найдено

`ROUTE_NOT_FOUND`, `GAME_NOT_FOUND`, `OPERATION_NOT_FOUND`. Повтор не помогает.

## 409 — конфликты и неоднозначность

| Код | Значение | Действие |
| --- | --- | --- |
| `REQUEST_REPLAY_DETECTED` | Nonce уже использован (повтор перехваченного запроса) | Не пересылать тот же wire-запрос; новая попытка — новый proof |
| `IDEMPOTENCY_CONFLICT` | Тот же `Idempotency-Key`, но другой method/path/body | Остановиться и исправить команду |
| `MEMBER_ALREADY_ACTIVE` | Игрок уже активен в игре | Прочитать операцию/состояние |
| `PAYMENT_REFERENCE_ALREADY_CLAIMED` | `payment.reference` уже использован | Не переиспользовать ссылку |
| `MEMBERSHIP_STATE_CONFLICT` / `MEMBERSHIP_BINDING_INCOMPLETE` | Состояние membership не допускает действие | Прочитать операцию |
| `GAME_NOT_OPEN` / `GAME_SCHEDULE_UNKNOWN` / `GAME_IDENTITY_CONFLICT` | Игра не открыта, нет расписания или противоречивая identity | Не повторять; проверить игру |
| `GAME_FULL` / `GAME_CAPACITY_CONFLICT` / `GAME_CAPACITY_INVALID` / `GAME_CAPACITY_UNKNOWN` / `GAME_RESERVATION_FENCE_FAILED` | Ограничение/гонка по вместимости | Не повторять вслепую |
| `VIVA_EXERCISE_UNKNOWN` | Viva не подтвердила упражнение | Проверить через операцию |

## 202 — результат неизвестен

Не ошибка. `GET` операции, затем reconciliation. **Слепой provider retry и
автоматическая компенсация запрещены.**

## 5xx и транспорт

| Статус / код | Значение | Действие |
| --- | --- | --- |
| `503 PARTNER_API_DISABLED` | Endpoint выключен kill switch | Backoff; это не временная перегрузка |
| `503 VIVA_RUNTIME_NOT_CONFIGURED` / `VIVA_TECHNICAL_CLIENT_NOT_CONFIGURED` / `KEY_CONFIGURATION_INVALID` / `AUDIT_UNAVAILABLE` / `MONGO_PREREQUISITES_MISSING` / `VIVA_SERVICE_TOKEN_UNAVAILABLE` | Runtime не готов | Backoff и эскалация владельцу |
| `429` | Превышен rate limit | Backoff; учитывать `Retry-After`, если он есть |
| `408` / `502` / `504` | Обрыв, недоступность или таймаут | Результат **неизвестен**: прочитать операцию через `GET` |
| `413` | Тело/заголовки больше лимита | Уменьшить запрос |

## Общие правила

1. Повтор HTTP-запроса и повтор бизнес-команды — разные вещи: см.
   [IDEMPOTENCY.md](IDEMPOTENCY.md).
2. Любой неоднозначный исход (timeout, `5xx`, обрыв) переводит операцию в `UNKNOWN`;
   единственный правильный путь — `GET` и reconciliation.
3. Не выполняйте автоматический `DELETE` или возврат денег как компенсацию.
4. Всплески `INVALID_SIGNATURE`, `REQUEST_REPLAY_DETECTED`, `SCOPE_DENIED` стоит
   алертить на своей стороне: это признак ошибки клиента или атаки.
