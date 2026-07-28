# Задача Codex: серверная покупка кастомного абонемента турнира

## Контекст

В ЛК для кастомной цены турнира клиентский бандл больше не ищет видимый продукт Viva. Если у турнира в skin/custom payload есть цена, бандл показывает синтетический продукт `Энергия турниры` и отправляет покупку на сервер PadelHub:

`POST /api/tournaments/:exerciseId/custom-energy-checkout`

Запрос идет на `https://padlhub.su/api` с Bearer-токеном ЛК и заголовками:

- `X-PadlHub-Auth-Source: lk-keycloak`
- `X-PadlHub-Tenant-Key: <TENANT_KEY>`

## Payload от бандла

```json
{
  "source": "lk-tournament-signup",
  "authProvider": "lk-keycloak",
  "tenantKey": "iSkq6G",
  "exerciseId": "VIVA_EXERCISE_ID",
  "studioId": "VIVA_STUDIO_ID",
  "paymentMethod": "SMS",
  "client": {
    "id": "VIVA_CLIENT_ID",
    "phone": "79123456789",
    "firstName": "Имя",
    "lastName": "Фамилия",
    "middleName": null,
    "email": null
  },
  "product": {
    "name": "Энергия турниры",
    "type": "SUBSCRIPTION",
    "kind": "TOURNAMENT_CUSTOM_ENERGY"
  },
  "pricing": {
    "currency": "RUB",
    "priceLabel": "2 500 ₽",
    "amount": 2500,
    "amountMinor": 250000,
    "baseAmount": 20000,
    "baseAmountMinor": 2000000,
    "discountAmount": 17500,
    "discountAmountMinor": 1750000,
    "discountReason": "Участие в турнире «Название турнира» 09.05.2026"
  },
  "tournament": {
    "id": "TOURNAMENT_ID",
    "exerciseId": "VIVA_EXERCISE_ID",
    "sourceTournamentId": "SOURCE_TOURNAMENT_ID",
    "linkedCustomTournamentId": "CUSTOM_TOURNAMENT_ID",
    "title": "Название турнира",
    "startsAt": "2026-05-09T07:00:00+03:00",
    "endsAt": "2026-05-09T08:00:00+03:00",
    "date": "2026-05-09",
    "dateLabel": "09.05.2026",
    "studioId": "VIVA_STUDIO_ID",
    "studioName": "ТестMiniApp",
    "publicUrl": "/api/tournaments/public/slug"
  },
  "returnUrls": {
    "successUrl": "https://padlhub.ru/tournaments?...",
    "failUrl": "https://padlhub.ru/tournaments?..."
  }
}
```

## Что реализовать на сервере

1. Добавить endpoint `POST /api/tournaments/:exerciseId/custom-energy-checkout`.
2. Проверить auth пользователя по Bearer-токену ЛК, `tenantKey`, `exerciseId`, `client.phone`, `pricing.amountMinor`, `pricing.discountAmountMinor`.
3. Через существующее Viva admin API найти или подтвердить клиента по телефону/id.
4. Через существующее Viva admin API оформить клиенту скрытый турнирный абонемент `Энергия турниры`.
5. Создать транзакцию через Viva admin API с оплатой `SMS`, ценой `baseAmountMinor`, скидкой `discountAmountMinor` и причиной скидки из `pricing.discountReason`.
6. В причину скидки обязательно писать: `Участие в турнире «<название турнира>» <дата>`.
7. Если admin transaction API поддерживает redirect URL, передать `returnUrls.successUrl`/`returnUrls.failUrl`; если нет, просто вернуть ссылку из `cardPaymentInfo.paymentUrl`.
8. Вернуть бандлу ссылку оплаты из Viva/ЛК.

## Response для бандла

Бандл умеет извлечь ссылку из разных вложенностей, но лучше вернуть явный JSON:

```json
{
  "ok": true,
  "exerciseId": "VIVA_EXERCISE_ID",
  "clientId": "VIVA_CLIENT_ID",
  "subscriptionId": "CLIENT_SUBSCRIPTION_ID",
  "transactionId": "VIVA_TRANSACTION_ID",
  "paymentUrl": "https://...",
  "toPayMinor": 250000,
  "paymentExpiresAt": "2026-05-09T07:20:00+03:00"
}
```

Если Viva возвращает полностью оплаченную транзакцию без ссылки, вернуть `paid: true` и `toPayMinor: 0`.

## HAR

Текущий HAR `/Users/zver/Desktop/Энергия-турниры.har` подтверждает проблему: для exercise `3a664d2f-e073-40c6-9378-ed533ec13625` end-user endpoint `products/subscriptions?exerciseId=...` возвращает пустой список, а skin турнира содержит `priceLabel: "10"`.

HAR оформления `/Users/zver/Desktop/Оформление Энергии турнирной.har` показывает админский поток:

- поиск клиента: `GET /api/v2/search/clients?q=<phone>`;
- поиск скрытого продукта: `GET /api/v1/products?size=5&sort=name,asc&name=Энергия т&studioId=<studioId>&clientPhone=<phone>`;
- карточка продукта: `GET /api/v1/products/subscriptions/14578ead-79a7-4a23-871f-4e470e86af97?clientId=<clientId>&studioId=<studioId>`;
- продукт: `id=14578ead-79a7-4a23-871f-4e470e86af97`, `name=Энергия турниры`, `type=INDIVIDUAL`, `showToUser=false`, `cost=2000000`, `visits=1`, `availableTypes=[{ id: 839, name: "Падел Турнир" }]`;
- проверка договоров: `GET /api/v1/contracts/clients/<clientId>?productIds=14578ead-79a7-4a23-871f-4e470e86af97`;
- создание транзакции: `POST /api/v1/transactions`.

Фактический Viva transaction payload из HAR:

```json
{
  "clientPhone": "+79104303190",
  "paymentMethod": "SMS",
  "products": [
    {
      "id": "14578ead-79a7-4a23-871f-4e470e86af97",
      "count": 1,
      "customAmount": null,
      "type": "SUBSCRIPTION",
      "discount": 1500000
    }
  ],
  "studioId": "ed0e3bd4-6edb-43a9-8fe4-8fc3e7febec8",
  "discountReason": "Турнир падл хаю 5 мая",
  "offlineTillId": null,
  "deposit": 0
}
```

В ответе Viva ссылка лежит в `cardPaymentInfo.paymentUrl`, срок оплаты в `paymentDueDate`, сумма к оплате в `toPay` в копейках. Токены, cookie и персональные данные из HAR не коммитить.
