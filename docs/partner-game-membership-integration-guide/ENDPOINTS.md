# Методы API

Пространство имён: `/lk/integrations/v1`. Оно отделено от общего `/lk/games` и не
использует широкий `PATCH`. Query string и fragment запрещены.

Базовый URL выдаётся отдельно вместе с credentials; в репозитории рабочего адреса нет.
Формы путей ниже — точные и участвуют в подписи.

| Метод | Путь | Scope | Назначение |
| --- | --- | --- | --- |
| `POST` | `/lk/integrations/v1/open-games/{gameId}/members` | `members:add` | Добавить внешнего игрока |
| `DELETE` | `/lk/integrations/v1/open-games/{gameId}/members/{membershipId}` | `members:remove` | Удалить только собственный membership |
| `GET` | `/lk/integrations/v1/operations/{operationId}` | `operations:read` | Прочитать только свою операцию |

## Ограничения идентификаторов

| Поле | Формат |
| --- | --- |
| `gameId` | `[A-Za-z0-9][A-Za-z0-9._:-]{2,127}` — канонический ID игры из server-only allowlist клиента |
| `membershipId` | lowercase UUID из ответа `POST` |
| `operationId` | lowercase UUID из ответа `POST`/`DELETE` или из `GET` |
| `externalPlayerId` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, стабилен и не переиспользуется для другого человека |

`gameId` — не Mongo `_id` и не legacy-поле. Клиент может вызывать только те игры,
которые явно выданы ему в allowlist.

## POST — добавить игрока

Закрытая схема: неизвестное поле даёт `UNKNOWN_REQUEST_FIELD`.

```json
{
  "externalPlayerId": "stable-id-from-partner",
  "displayName": "Тестовый игрок",
  "payment": {
    "reference": "unique-payment-reference",
    "paidAt": "2026-09-01T08:59:00.000Z",
    "amountMinor": 250000,
    "currency": "RUB"
  }
}
```

| Поле | Правила |
| --- | --- |
| `externalPlayerId` | Стабильный ID игрока у партнёра |
| `displayName` | Отображаемое имя, непустая строка в допустимых границах |
| `payment.reference` | Уникальная ссылка на внешний расчёт; в рамках client одноразовая |
| `payment.paidAt` | Канонический UTC ISO с миллисекундами (`new Date(x).toISOString() === x`) |
| `payment.amountMinor` | Safe integer, `0 … 100000000`, минимальные единицы валюты |
| `payment.currency` | `^[A-Z]{3}$` |

`payment` **обязателен**: это декларация внешнего расчёта, а `reference` — fence
уникальности `(clientId, payment.reference)`, чтобы одна оплата не пометила двух
участников. PadlHub сумму не проверяет и денег не проводит.

Ответ при первом успехе — `201`:

```json
{
  "operationId": "<uuid>",
  "membership": {
    "membershipId": "<uuid>",
    "gameId": "<game-id>",
    "externalPlayerId": "stable-id-from-partner",
    "state": "ACTIVE",
    "paymentStatus": "PAID",
    "settlementSource": "EXTERNAL_PARTNER"
  }
}
```

## DELETE — удалить свой membership

Тело — ровно `{}` (2 байта). В body нельзя передать игрока или Viva ID: единственный
объект удаления задаёт `membershipId`. Удалить можно только тот membership, который
создал **этот же** integration client; чужой, LK- или Viva-игрок завершается
`MEMBERSHIP_NOT_OWNED` до обращения к Viva.

Ответ `200`:

```json
{
  "operationId": "<uuid>",
  "membership": {
    "membershipId": "<uuid>",
    "gameId": "<game-id>",
    "externalPlayerId": "stable-id-from-partner",
    "state": "REMOVED"
  }
}
```

## GET — состояние операции

Тело отсутствует (подпись считается по `{}`). Можно читать только свою операцию.

Ответ `200`:

```json
{
  "operation": {
    "operationId": "<uuid>",
    "action": "ADD_MEMBER",
    "state": "COMPLETED",
    "gameId": "<game-id>",
    "membershipId": "<uuid>",
    "createdAt": "2026-09-01T08:59:00.000Z",
    "updatedAt": "2026-09-01T08:59:02.000Z",
    "error": null
  }
}
```

`state` — одна из `RECEIVED`, `SLOT_RESERVED`, `VIVA_PENDING`, `COMPLETED`, `UNKNOWN`,
`FAILED`; `error` — публичный код ошибки или `null`. Неизвестная операция —
`404 OPERATION_NOT_FOUND`.

## Статусы ответа

| Статус | Значение |
| --- | --- |
| `201` | Первая успешная обработка |
| `200` | Успешный идемпотентный повтор уже завершённой операции, либо `GET` |
| `202` | `UNKNOWN`/незавершённое состояние: нужно прочитать операцию, а не слепо повторять Viva |
| `400/401/403/404/409` | Ошибка; см. [ERRORS.md](ERRORS.md) |
| `503` | Endpoint выключен (`PARTNER_API_DISABLED`) или runtime не готов |

`202` — это не ошибка и не «получилось»: результат операции неизвестен, читайте её
через `GET`.

## Состояния операции

```text
ADD:    provider READY -> RECEIVED -> SLOT_RESERVED -> Viva add -> exact read-back -> COMPLETED
REMOVE: provider READY -> RECEIVED -> VIVA_PENDING  -> Viva remove -> exact read-back -> COMPLETED
                           \-> UNKNOWN (timeout / ambiguous ACK / read-back mismatch)
                           \-> FAILED  (definite pre-mutation failure)
```

После подтверждения Viva, но ошибки локального commit операция становится `UNKNOWN`.
Система не создаёт и не отменяет booking вслепую: нужна reconciliation-процедура,
которая читает точный `exerciseId + bookingId + technicalVivaClientId`.
