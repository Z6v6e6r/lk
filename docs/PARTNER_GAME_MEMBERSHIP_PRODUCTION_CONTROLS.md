# Production controls: Partner Game Membership API v0.2

Статус: **UNBOUND / AUDIT_BLOCKED / activation BLOCKED**. Документ и
`scripts/partner_game_membership_production_controls.json` задают минимальный
fail-closed контракт, но не содержат production hostname, CIDR, сертификат, путь
размещения, получателей packet, секреты или разрешение на изменение production.

## Что доказано изолированно

3 сентября 2026 года пакет custom-node с release identity
`9f3fab0bb20eef372ea0aa40db26e43a7fa45600efec29f7c7a1707d43cb9398`
проверен на Linux arm64, Node `22.23.2`, npm `10.9.8` и Node-RED `4.1.14`:

| Проверка | Результат |
| --- | --- |
| Exact package install/load | PASS, `@padlhub/node-red-partner-game-membership-api@0.2.0`, `mongodb@7.2.0` |
| POST при отсутствующих runtime secrets и `LK_PARTNER_GAME_API_ENABLED != true` | `503 PARTNER_API_DISABLED`, `Cache-Control: no-store`, Mongo/Viva calls отсутствуют |
| Graceful stop | `Stopping flows` → `Stopped flows` |
| Rehearsed flow rollback | `404`, Partner nodes/routes в rehearsed flow: `0` |
| Package + palette-cache quarantine | `404`, Partner palette matches: `0` |
| Cleanup | test containers: `0`, listener `127.0.0.1:18894`: `0`, package hashes неизменны |
| Production side effects | `0` |

Node-RED `4.1.14` функционально совместим, но **не закрывает security gate**. Свежий
`npm audit --omit=dev` exact closure вернул `25` affected package records:
`0 critical / 15 high / 9 moderate / 1 low`. Кроме registry/npm tooling, в отчёте
остались request-path зависимости `express@4.22.2`, `body-parser@1.20.6` и
`qs@6.15.3`. Прямой loopback response также унаследовал общий
`Access-Control-Allow-Origin: *`. Поэтому версия 4.1.14 не объявляется безопасной сама
по себе: production остаётся `AUDIT_BLOCKED`, а внешний ingress обязан скрыть CORS и
не публиковать Node-RED editor/admin.

Нормализованные exact `package-lock`, `npm ls`, полный audit report, runtime manifest и
`functional-rehearsal.json` хранятся в `scripts/partner_game_membership_runtime/`,
проверяются по SHA и включаются в private packet. Functional evidence привязан к exact
custom-node release, но его scope ограничен load/default-off/removal compatibility. Он
не доказывает поведение нового flow, собранного из следующего fresh live snapshot;
этот candidate требует отдельного deploy-stage read-back. Перед каждым
production-кандидатом audit повторяется на exact
lock/runtime не старше 24 часов. Нужен либо patched exact runtime, либо письменный
bounded reachability decision с доказательством, что через три Partner routes не
достижим ни один critical/high advisory. Неопределённость означает отказ.

## Машиночитаемый контракт

Проверка:

```bash
npm run validate:partner-game-membership-production-controls
npm run validate:partner-game-membership-runtime
npm run validate:partner-game-membership-production-binding -- \
  --binding /absolute/private-production-binding.json \
  --packet-root /absolute/private-parent/partner-v02-packet
```

Validator использует закрытые схемы и отклоняет неизвестные поля, route widening,
non-loopback upstream, CORS/editor exposure, proxy retry, ослабление лимитов,
необработанные duplicate proof headers, ложный audit PASS, заполнение ingress/custody
в репозитории, credential handling и любую deploy/activation авторизацию.

Генератор приватного packet копирует exact bytes в
`production-controls.contract.json`, фиксирует SHA-256 в `deployment-plan.json` и
сохраняет состояния `UNBOUND/AUDIT_BLOCKED/BLOCKED`. Этот файл — policy template, а не
production binding. Фактические hostname/CIDR/certificate/path/owners оформляются
отдельным приватным evidence overlay без секретных значений. Второй validator требует
exact controls/runtime/audit/functional hashes, mTLS, socket-peer identity,
отрицательный readback, фактические packet bytes/modes/semantics и разные
test/production fingerprints. Packet/host custody проверяется фактически, но ingress
hashes/readback booleans и audit reachability decision остаются декларациями с
состояниями `DECLARED_EVIDENCE_UNVERIFIED` и
`AUDIT_BLOCKED_DECISION_UNVERIFIED`. Поэтому validator не является deploy gate.
Production CLI запускают на bound Linux host от `root`:
realpath packet обязан точно совпасть с `custody.targetDirectory`, owner UID равен `0`,
`targetHostname` совпадает с текущим hostname, а `targetHostIdentitySha256` — с SHA-256
локального `/etc/machine-id`; runtime platform/architecture совпадают с проверенными
`linux/arm64` и текущими `process.platform/process.arch`. Успешный schema-lint возвращает
только `DECLARED_EVIDENCE_UNVERIFIED_AUDIT_BLOCKED_NOT_AUTHORIZED` и не даёт
deploy/activation authorization. До deploy нужен отдельный live verifier, который
читает exact ingress config/readback/certificate/CA и подписанный audit reachability
artifact, а также сам повторяет отрицательные сетевые probes.

## Ingress contract

Разрешены только три пары method/path:

| Метод | Exact path pattern |
| --- | --- |
| `POST` | `/lk/integrations/v1/open-games/:gameId/members` |
| `DELETE` | `/lk/integrations/v1/open-games/:gameId/members/:membershipId` |
| `GET` | `/lk/integrations/v1/operations/:operationId` |

Обязательные свойства:

- отдельный exact Host/SNI; альтернативный/shared hostname не маршрутизирует Partner
  paths, прямое подключение к Node-RED извне невозможно; upstream только
  `http://127.0.0.1:1880`;
- TLS 1.2+ и mTLS обязательны; approved source CIDR только усиливает mTLS;
- exact подписанный audience совпадает с server-only environment audience;
- inbound `Forwarded`/`X-Forwarded-*` удаляются, trusted chain строится заново из
  socket peer; trusted proxy и socket-peer CIDR для loopback upstream закреплены как
  exact `127.0.0.1/32` и `::1/128`, а внешний source allowlist принимает только exact
  host CIDR;
- Node-RED editor/admin, OPTIONS, query string, все другие методы и routes недоступны;
- `application/json`; body не больше 16 KiB, request line 2 KiB, headers 16 KiB;
- максимум 4 concurrent request, 2 request/s и burst 10 на client; одновременно
  максимум 8, 5 request/s и burst 20 на подтверждённый source IP, чтобы подмена
  произвольного `clientId` не обходила защиту;
- proxy retry выключен; timeout upstream 15 секунд;
- duplicate `Content-Type` или любого proof/audience/idempotency/correlation header
  отклоняется; duplicate JSON keys отклоняются до Node-RED body parser;
- raw path и canonical JSON semantics передаются без rewrite до HMAC verification;
- upstream `Access-Control-Allow-Origin` скрывается, response остаётся `no-store`;
- access log не содержит body, signature, nonce, key, idempotency, displayName,
  payment reference или исходный IP.

Значения pilot-консервативны. Их можно ужесточить. Ослабление — отдельное изменение
контракта, tests и security review; оно не выполняется через приватный runtime overlay.

## Packet и secret custody

`source.flow.json` и `candidate.flow.json` содержат полный production flow, поэтому весь
packet классифицируется как `SECRET_BEARING`, даже если семь Partner nodes и custom
package не содержат секретов.

До любого transfer должны быть связаны и независимо подтверждены:

1. именованные получатели с минимальными правами;
2. шифрованный и аутентифицированный канал;
3. exact host alias, hostname, SHA-256 `/etc/machine-id` и root-only destination;
4. directory `0700`, files `0600`, запрет symlink;
5. срок хранения, deletion owner, custody owner и incident owner;
6. правило ротации при утечке и проверяемое удаление staging copy.

Packet сначала полностью собирается в sibling temporary directory. Последним пишется
`packet.manifest.json` с hash/mode каждого payload-файла; после fsync каталог появляется
по final path одним atomic rename. Инъецированный pre-publish failure не оставляет ни
final, ни временный packet.

Локальный генератор не принимает world-writable parent вроде `/private/tmp`. Оператор заранее
создаёт отдельный canonical parent, принадлежащий текущему пользователю, с mode `0700`,
а в `--out` передаёт ещё не существующий дочерний путь:

```bash
install -d -m 0700 /absolute/private-parent
npm run nodered:partner-game-membership:v02-packet -- \
  --workspace /absolute/external/workspace \
  --out /absolute/private-parent/partner-v02-packet
```

После transfer production binding проверяется повторно уже на target host: packet должен
находиться ровно по bound `custody.targetDirectory`, принадлежать UID `0` и совпадать с
manifest не только по hashes/modes, но и по controls, runtime evidence, custom release,
source/candidate exact-graph contract и fail-closed deployment plan.

Partner не получает production packet. Ему передаются только публичная документация,
golden vector, несекретные test client/policy IDs и отдельно выпущенные test HMAC secret
и mTLS certificate через утверждённый секретный канал. Production client ID, key и
certificate выпускаются отдельно и не повторяют test material. Два ранее раскрытых
действующих credential этим этапом не
отображались, не копировались, не экспортировались, не проверялись против live-систем и
не изменялись. Автоматизированные byte-scans могли читать candidate только локально.

## Последовательность live gates

```text
exact pushed SHA + green exact-head CI
        ↓
fresh production flow/readback + exact runtime audit
        ↓
private ingress binding rehearsal + private custody binding
        ↓
separate deploy authorization
        ↓
install/import/restart while global API remains OFF
        ↓
readback: hashes, routes, editor isolation, 503 default-off, logs
        ↓
Viva/Mongo/reconciliation evidence + separate activation authorization
        ↓
one client + one test game canary with expiring access
```

Любой drift, `UNKNOWN`, missing owner или failed gate возвращает этап в `BLOCKED`.
Deploy и activation — разные разрешения; deploy никогда не включает endpoint.

См. также:

- [API contract](./PARTNER_GAME_MEMBERSHIP_API.md)
- [Threat model](./PARTNER_GAME_MEMBERSHIP_THREAT_MODEL.md)
- [Test plan](./PARTNER_GAME_MEMBERSHIP_TEST_PLAN.md)
- [Вопросы внешней команде](./PARTNER_GAME_MEMBERSHIP_EXTERNAL_TEAM_QUESTIONS.md)
- [Редактируемая схема production gates](./assets/partner-game-membership-production-gates.drawio)
