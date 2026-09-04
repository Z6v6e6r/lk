# LK1 DEV deploy/post-check gate

Этот гейт является только source-level handoff для будущих раздельно
авторизуемых переходов. Он не выполняет host read, install, `daemon-reload`,
start/enable, ingress, activation, передачу canary IDs/secrets или внешние
записи. Его текущий валидный результат — только
`PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW`.

Source binding исправлен на dedicated CUP `https://127.0.0.1:3037` и Mongo database
`lk1_subscription_dev_fixture`. Synthetic managed entitlement/activation contract
реализован и физически проверен на локальном fixture-owned loopback. Это не
является host runtime evidence: `hostRuntimeExposed=false`, deploy/start всё ещё
запрещены без следующих раздельных gate.

## Зафиксированная граница

- target: `lk-reserve-89`, user `lk1-subscription-dev`, service
  `lk1-subscription-dev-nodered.service`;
- Node-RED: `/srv/lk1-subscription-dev/node-red/flows.json`,
  `127.0.0.1:1882`;
- fixtures: только `127.0.0.1:27030` и `127.0.0.1:3037-3039`;
- production host `lk-primary-147`, shared flow `/root/.node-red/flows.json`,
  listener `0.0.0.0:1880`, production DNS/origins и любой non-loopback egress
  запрещены;
- production binding остаётся `UNBOUND_AFTER_ROUTER_AMENDMENT`;
- frozen source/candidate/manifest tuple должен совпасть с source-only release
  receipt v2, source authorization и candidate source identity;
- cross-environment write budget равен нулю.

## Что требуется до будущей установки

Read-only preflight от 2026-09-04 является неизменяемым историческим архивом и зафиксировал
systemd 245, disabled/inactive units, отсутствие reserved listeners и inputs,
неизменность shared flow и отсутствие TLS credentials. Его timestamp не может
авторизовать будущую установку. Непосредственно перед отдельно авторизованной
установкой fresh v2 capture через pinned BatchMode SSH должен заново связать
repository HEAD/tree, candidate tuple, validator/capture hashes, host identity,
systemd fragment hashes, отсутствие drop-ins, reserved listeners, TLS/authorization
inputs, ingress routes и drift shared flow. Результат записывается только в private
temporary artifact `0700/0600`; любое несовпадение останавливает переход.

Статический source gate не заявляет runtime network enforcement. systemd 245
подтверждает только совместимость file-based authorization transport;
`networkIsolationRuntimeVerified=false` и `serviceStartBlocked=true` сохраняются
до отдельно авторизованной отрицательной non-loopback пробы.

## Раздельные post-check фазы

1. `INSTALLED_STOPPED`: byte-identical host readback, units всё ещё
   disabled/inactive, listeners отсутствуют, shared ресурсы неизменны.
2. `STARTED_DEFAULT_OFF`: точные service identities, только loopback listener
   ownership, ожидаемые routes/graph, ноль production connections и ноль idle
   writes.
3. `CANARY_ACTIVE`: ровно две server-owned subscription identities (UUID или
   stable HMAC), обязательная control subscription, третья подписка обходит
   managed path, production connections равны нулю, меняются только ожидаемые
   fixture counters.
4. `ROLLBACK_TO_ABSENT`: ingress снимается до listener exposure, сервисы
   останавливаются в зафиксированном порядке, units/listeners возвращаются в
   stopped/absent state, shared ресурсы не меняются, evidence/logs сохраняются,
   данные не удаляются.

Каждая фаза требует отдельной точной авторизации. Runtime observation после
start/activation длится 600-900 секунд. До фактического выполнения её состояние
остаётся `NOT_RUN`; нельзя заявлять `DEV_DEPLOYED` или `DEV_ACTIVE`.

## Локальная проверка

```bash
npm run nodered:lk1-subscription-dev:deploy-postcheck-gate
npm run test:lk1-subscription-dev-deploy-postcheck-gate
npm run test:lk1-subscription-dev-host-preflight
```

Test-команды читают tracked JSON/JS и не обращаются к host. Сам host-preflight CLI
намеренно принимает только `--capture-via-ssh`; его запуск является отдельным
read-only host gate и здесь не выполнялся. Успешная локальная валидация не означает
готовность к deploy.

Непосредственно перед отдельно авторизованным install обязателен новый
`node scripts/validate_lk1_subscription_dev_host_preflight.mjs --capture-via-ssh`;
полученный v2 artifact должен быть проверен deploy gate с тем же exact HEAD/tree.
Capture принудительно использует pinned ED25519 host key и отличает защитный
`IPAddressDeny=0.0.0.0/0` от запрещённого wildcard bind в ExecStart/environment.
Только отдельно собранный stopped-install candidate может затем выполнить
manifest-bound atomic install; source-only gate сам по-прежнему ничего не меняет.
