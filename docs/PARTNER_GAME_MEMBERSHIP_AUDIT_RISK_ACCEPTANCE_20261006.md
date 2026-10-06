# Принятие риска: аудит runtime-closure Partner API (2026-10-06)

## Решение

Владелец продукта **явно принимает** результат свежего локального аудита runtime-closure
партнёрского sidecar от 2026-10-06: **1 critical и 6 high** уязвимостей в закрытии
зависимостей. Пороги reviewed-политики подняты с `0/0` до фактических значений, признак
`unresolvedAuditAllowed` установлен в `true`, а решение записано машинночитаемо в
`scripts/partner_game_membership_production_controls.json`:

```json
"auditPolicy": {
  "maxAgeHours": 24,
  "criticalAffectedPackages": 1,
  "highReachablePackages": 6,
  "partnerRequestSurfaceDecisionRequired": true,
  "editorAdminExposureAllowed": false,
  "unresolvedAuditAllowed": true
},
"latestIsolatedRehearsal": {
  "auditAffectedPackages": { "critical": 1, "high": 6, "moderate": 13, "low": 0, "total": 20 },
  "auditDecision": "ACCEPTED_RISK_CRITICAL_1_HIGH_6_OWNER_DECISION_2026-10-06"
}
```

## Причина

Выданный партнёру доступ должен работать на **всех станциях и всех открытых играх**, а не на
одной игре из allowlist. Это изменение политики допуска правит файлы custom node и sidecar, что
по регламенту обнуляет runtime-closure: требуется свежая функциональная репетиция, свежий
runtime-manifest и свежий аудит. Свежий аудит, выполненный 2026-10-06 в pinned
linux/amd64-образе, дал 1 critical и 6 high. Прежняя чистая запись аудита (2026-09-11,
0/0/7) после перевыпуска закрытия недействительна, а политика `0/0` заблокировала бы
выпуск. Владелец решил принять риск, а не ждать исправления зависимостей.

## Что именно принято

| Уровень | Пакет | Прямая зависимость | Advisory | Исправление |
| --- | --- | --- | --- | --- |
| **critical** | `proxy-addr` | нет | proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet | доступно обновление |
| **high** | `axios` | нет | Axios: Prototype pollution gadget in fetch adapter can alter outbound requests; Axios: Prototype-Pollution Gadget in the Default Instance Allows Inherited Object.prototype.method to Override HTTP Meth | требуется node-red@4.1.8 |
| **high** | `brace-expansion` | нет | brace-expansion: Quadratic-time expansion of the `{a},b}` rewrite causes CPU denial of service; brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion; brace-e | доступно обновление |
| **high** | `http-cache-semantics` | нет | http-cache-semantics max-stale handling can disclose cross-user cached responses | доступно обновление |
| **high** | `node-red` | да | @node-red/editor-api; @node-red/nodes; @node-red/runtime; @node-red/util; express; node-red-admin | требуется node-red@4.1.8 |
| **high** | `node-red-admin` | нет | axios | требуется node-red@4.1.8 |
| **high** | `undici` | нет | undici vulnerable to Denial of Service via unhandled error in WebSocket permessage-deflate decompression; undici vulnerable to downstream response splitting via retry interceptor; undici vulnerable to | доступно обновление |

Ключевое для оценки: по `node-red` **исправленной версии нет** (уязвимый диапазон
`>=3.0.0-beta.1`; предложение npm «node-red@4.1.8» — это понижение версии, остающееся внутри
уязвимого диапазона). По остальным пакетам обновления существуют.

## Компенсирующие меры (не ослабляются)

- sidecar слушает только loopback `127.0.0.1:18894`, наружу порт не публикуется;
- mTLS: клиентский CA наш, лист клиента привязан к `clientId` на ingress, чужая пара даёт `403`;
- IP-allowlist на ingress: только адреса партнёра и наши probe-хосты;
- HMAC v2 с nonce-леджером, окном ±90 c, идемпотентностью и проверкой владения членством;
- admin/editor UI Node-RED отключены, палитра отключена, production-конфиг не поднимает портов;
- Viva — только выделенным техническим клиентом, мутации включены осознанно;
- durable-аудит каждого запроса, `clientId` из сертификата, выключатель на клиента
  (`enabled=false` в keyring + отсутствие в анкоре) и список исключений игр/станций.

## Границы принятия

Риск принят **только** для этого закрытия и **только** в этих границах: loopback-sidecar,
mTLS, allowlist. Он не распространяется на публикацию порта, включение editor/admin,
ослабление ingress и на любые другие сервисы. Появление исправленной версии `node-red`
или иного закрытия отменяет это принятие.

## Пересмотр

Пересмотреть: при следующем релизе Partner API, при выходе исправленного `node-red`, либо не
позднее **2026-11-05** — что наступит раньше. Пересмотр обязан либо понизить пороги обратно,
либо продлить принятие новой датой и обоснованием.
