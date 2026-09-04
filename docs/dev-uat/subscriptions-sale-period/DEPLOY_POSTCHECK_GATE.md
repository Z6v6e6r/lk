# LK1 DEV deploy/post-check gate

Этот гейт является только source-level handoff для будущих раздельно
авторизуемых переходов. Он не выполняет host read, install, `daemon-reload`,
start/enable, ingress, activation, передачу canary IDs/secrets или внешние
записи. Его текущий валидный результат — только
`PREPARED_SOURCE_ONLY_BLOCKED`.

Гейт выявляет два несовместимых runtime target binding: frozen candidate всё ещё
указывает CUP на запрещённый shared listener `127.0.0.1:3036`, а dedicated CUP
зарезервирован на `127.0.0.1:3037`; candidate Mongo использует базу
`dev-lk1-subscription-canary`, тогда как provisioning фиксирует
`lk1_subscription_dev_fixture`. Кроме того, complete managed runtime contract не
экспонирован. До согласования и пересборки frozen candidate deploy запрещён.

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

Отдельно авторизованный fresh read-only preflight должен заново зафиксировать
repository identity, candidate manifest, host identity, поддержку systemd
`LoadCredential`, disabled/inactive units, отсутствие listeners и authorization
inputs, неизменность shared ресурсов, отсутствие production routes/origins и
review rollback-to-absent. Любое несовпадение останавливает переход; исторический
bootstrap receipt не заменяет свежую проверку.

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
```

Команды только читают tracked JSON/JS файлы и валидируют их между собой. Они не
содержат SSH, network, installer или service-control операций. Успешная локальная
валидация означает, что блокеры и будущие проверки сформулированы согласованно;
она не означает готовность к deploy.
