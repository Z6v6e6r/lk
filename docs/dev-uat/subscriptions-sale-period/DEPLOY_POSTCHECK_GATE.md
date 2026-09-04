# LK1 DEV deploy/post-check gate

Этот гейт является только source-level handoff для будущих раздельно
авторизуемых переходов. Он не выполняет host read, install, `daemon-reload`,
start/enable, ingress, activation, передачу canary IDs/secrets или внешние
записи. Его текущий валидный результат — только
`PREPARED_SOURCE_ONLY_READY_FOR_STOPPED_INSTALL_REVIEW`.

Source binding исправлен на dedicated CUP `127.0.0.1:3037` и Mongo database
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

Historical read-only preflight от 2026-09-04 зафиксировал systemd 245,
disabled/inactive units, отсутствие reserved listeners и inputs, неизменность
shared flow. Checked-in snapshot не является текущим gate; его исходная
валидность была ограничена одним часом. Непосредственно перед отдельно
авторизованной установкой fresh preflight должен заново зафиксировать
repository identity, candidate manifest, host identity, поддержку systemd
совместимый authorization transport, disabled/inactive units, отсутствие listeners и authorization
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
npm run test:lk1-subscription-dev-host-preflight
```

Первые две source-команды читают tracked JSON/JS файлы и валидируют их между собой.
Исторический host snapshot проверяется на согласованность в момент capture, но
deploy/post-check gate явно выводит `HOST_PREFLIGHT_CURRENT=NOT_CLAIMED`. Успешная локальная валидация
означает, что блокеры и будущие проверки сформулированы согласованно; она не
означает готовность к deploy.

Непосредственно перед отдельно авторизованной stopped-install операцией fresh
read-only evidence должен быть получен отдельной командой. Она сама выполняет
`BatchMode` SSH только к закреплённому alias `lk-reserve-89`, не принимает
caller-authored JSON, проверяет clean repository HEAD/tree, frozen release tuple,
hash текущего validator и remote read-only script, а observed shared-flow hash
сравнивает с trusted baseline provisioning contract. Host-команды только читают
identity, unit/listener/input state и hashes; install, `daemon-reload`, start,
ingress, activation и любые host writes отсутствуют. Команда требует отдельной
авторизации host-read, сохраняет результат в созданный ею private `0700`
temporary directory и файл `0600` с одним hardlink:

```bash
npm run nodered:lk1-subscription-dev:host-preflight -- \
  --capture-via-ssh
```

Команда требует текущий snapshot не старше одного часа и выводит
`LK1_DEV_HOST_PREFLIGHT=PASS_CURRENT` и точный `EVIDENCE_PATH`. Checked-in snapshot не является текущей
авторизацией и не должен обновляться только ради evergreen source CI.
