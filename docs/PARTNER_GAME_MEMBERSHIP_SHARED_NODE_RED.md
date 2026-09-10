# Partner API в общем Node-RED: отдельный поток

Статус: локальный кандидат, `default-off`. Это не инструкция для production
import и не подтверждение deploy/activation.

Кандидат создаёт новую вкладку `Partner Game Membership API` с тремя HTTP-In
маршрутами и не меняет существующие nodes или wires. Store имеет
`requireIngressProof: true`: он не открывает Mongo и не получает Viva token,
пока scoped middleware не подтвердит исходный request.

## Что переиспользуется

Viva access token читается для каждого запроса из существующего global context
`vivacrm_access_token` и `vivacrm_token_expires_at`; новый технический пароль
или запись token в общий context не создаются. Mongo client API остаётся своим,
поэтому соединение, транзакции и lifecycle существующих потоков не разделяются.

## Обязательные условия до import

`scripts/partner_game_membership_shared_runtime/settings.cjs` является
fail-closed адаптером к существующему `settings.js`, а не заменой файла. До
генерации/импорта он требует проверить фактические runtime settings:

1. `httpNodeRoot` — `/` либо не задан;
2. `httpAdminRoot` — `false` либо отдельный путь вроде `/admin`; default `/`
   запрещён;
3. `httpNodeCors` и `httpNodeMiddleware` не заданы;
4. partner listener получает соединение только от loopback Nginx; внешний
   mTLS/allowlist остаётся самостоятельным ingress gate;
5. custom node и adapter загружают один и тот же installed
   `partner-game-membership-ingress.cjs` instance.

Пункт 2 обязателен: Node-RED 4.0.9 монтирует admin body parsers в root раньше
HTTP-In middleware. При admin root `/` exact signed body уже разобран и API
отклоняет request, поэтому адаптер отказывается стартовать вместо ослабления
проверки. Existing `httpNodeMiddleware` также запрещён: иначе нельзя доказать,
что он не меняет raw request или не содержит самостоятельную защиту, которую
новый route случайно обойдёт.

## Локальная проверка

`scripts/patch_partner_game_membership_shared_flow.mjs` строит candidate в
памяти. Он откажется при существующей вкладке, id collision и любом возможном
пересечении HTTP namespace. Физический тест запускает isolated Node-RED 4.0.9:
обычный POST `/ordinary` отвечает один раз, а корректно оформленный partner
request доходит до default-off handler и получает `503 PARTNER_API_DISABLED`.

Реальный import, изменение settings, restart, Nginx, ключи, Mongo/Viva write
и activation в этот этап не входят.
