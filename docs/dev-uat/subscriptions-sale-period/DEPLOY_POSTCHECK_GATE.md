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

Read-only preflight от 2026-09-04 зафиксировал
systemd 245, disabled/inactive units, отсутствие reserved listeners и inputs,
неизменность shared flow. Tracked JSON статически проверяется воспроизводимо, а
его execution-time свежесть ограничена одним часом. Непосредственно
перед отдельно авторизованной установкой fresh preflight должен заново зафиксировать
repository identity, candidate manifest, host identity, поддержку systemd
совместимый authorization transport, disabled/inactive units, отсутствие listeners и authorization
inputs, неизменность shared ресурсов, отсутствие production routes/origins и
review rollback-to-absent. Любое несовпадение останавливает переход; исторический
bootstrap receipt не заменяет свежую проверку.

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
npm run nodered:lk1-subscription-dev:host-preflight
npm run test:lk1-subscription-dev-deploy-postcheck-gate
npm run test:lk1-subscription-dev-host-preflight
```

Команды только читают tracked JSON/JS файлы и валидируют их между собой. Они не
содержат SSH, network, installer или service-control операций. Успешная локальная
валидация означает, что блокеры и будущие проверки сформулированы согласованно;
она не означает готовность к deploy.

Непосредственно перед отдельно авторизованным install обязательны execution-time
команды `node scripts/validate_lk1_subscription_dev_host_preflight.mjs --require-fresh`
и `node scripts/validate_lk1_subscription_dev_deploy_postcheck_gate.mjs --require-fresh-host-evidence`.
