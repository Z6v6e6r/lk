# Partner API: локальный Nginx 1.24 candidate и свежий audit

Дата: 6 сентября 2026. Это продолжение существующей Partner-ветки, **не выпуск**.
Production verifier по-прежнему возвращает `UNSUPPORTED_INGRESS_ADAPTER`;
deploy/activation остаются `false`. Боевые Nginx, Node-RED, Mongo и Viva не меняются.

## Граница реализации

`scripts/partner_game_membership_nginx_candidate.mjs` — чистый versioned generator:
закрытый input, только `scope=LOCAL_FIXTURE`, два различных `.invalid` hostname,
canonical public X.509 PEM, отдельный approved SHA-256 DER SPKI и явные тестовые часы.
Проверяются RSA ≥2048, срок, CA/leaf, подпись/issuer, client/server EKU и точные SAN.
Реальные ключи, snippets, includes, production hostname и произвольные пути не принимаются.

Выход — **полный локальный конфиг**, не готовый include для общего сервера:

| Слой | Реализованный механизм | Ограничение |
| --- | --- | --- |
| Transport | TLS 1.2/1.3, early data/tickets/cache off; default SNI rejects handshake | Не аудит установленного Ubuntu package и не полная TLS scan |
| Identity | mTLS + exact public leaf после независимого SPKI SHA-256; exact SNI и HTTP Host | Synthetic CA/leaf, без production revocation workflow |
| Routing | Три raw method/path, без query/rewrite/OPTIONS/editor | Только loopback fixture `8443 → 18894` |
| Limits | Client 2 r/s, burst 10, concurrency 4; source 5 r/s, burst 20, concurrency 8 | Независимое source enforcement и часть границ ещё не доказаны |
| Raw request | Existing guard до Node-RED parser: duplicate proof headers/JSON, 16 KiB | HMAC и paid-membership бизнес-flow не исполняются этим fixture |
| Response/log | CORS скрыт, no-store; логи только requestId/status/limiter flags | Нельзя подменять этим production audit/custody |

У Nginx literal `map` сравнивается без учёта регистра. Поэтому canonical PEM
сопоставляется через **anchored case-sensitive `~` regex**, а не literal или SHA-1
`ssl_client_fingerprint`. Разрешённый PEM alphabet после percent-encoding не содержит
regex metacharacters. [Nginx map](https://nginx.org/en/docs/http/ngx_http_map_module.html),
[SSL variables](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#variables).

## Воспроизводимый локальный запуск

```bash
node scripts/audit_partner_game_membership_runtime.mjs --install-and-audit-locked-runtime
node scripts/rehearse_partner_game_membership_nginx_candidate.mjs \
  --audited-runtime-root /absolute/owned/partner-runtime-audit-output
```

Это opt-in команды, **не обычный unit suite**. До запуска согласуются Docker/network
authority и heavy-slot. Audit устанавливает exact lock в свежем приватном каталоге,
без lifecycle scripts и host npmrc/credentials; registry задаётся явно.
Docker bridge **не является registry-only egress firewall**.

Nginx rehearsal повторно использует этот установленный runtime read-only, проверяя
audit receipt и hashes. Два ограниченных own containers делят одну `network:none`
namespace: Node Linux/amd64 `4d676821…`, Nginx 1.24 `2e26275e…`; по 1 CPU, 512 MiB,
128 PID, non-root, read-only rootfs, dropped capabilities, no-new-privileges,
**0 host ports**. Downloads/SSH/provider/DB отсутствуют. Создаются только synthetic
сертификаты в private `0700` fixture; keys/CSRs удаляются после подтверждённого cleanup.

`nginx -t` выполняется перед стартом fixture master; обе process/container identity
проверяются до/после matrix. Наблюдатель реального Node-RED считает все upstream
requests и отдельно dispatch, возвращает fixture-only `503`. Этот ответ проверяет
маршрут, не business readiness. Все HTTP-узлы обязаны реально существовать после
`flows:started`; отсутствие узла блокирует startup.

TLS transport принимает только явный серверный TLS alert либо полностью завершённый
HTTP response. Timeout/reset, обрезанный Content-Length/chunked body, неоднозначный
framing и неожиданные bytes после HEAD не равны PASS. Отказ client-cert проверяется
по `upstreamCalls=0`; `socket.authorized` подтверждает серверный сертификат, а не mTLS
допуск клиента. HTTP 400/403 при client-cert отказе допустим только в этой связке.
[Nginx certificate error processing](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#error_processing).

## Открытые проверки и блокеры

Физический run завершён `2026-09-06T09:40:57.487Z`: **47 PASS + 1
KNOWN_BLOCKER_CONFIRMED**, всего 48 rows, не «48 зелёных». Проверены positive
TLS1.2/1.3, no/wrong/unbound cert, SNI/Host/shared-host, три routes, запрещённые
methods/query/encoding/editor, duplicate proof headers/JSON, body 16384/16385 bytes,
known forwarding, no-store/CORS и client rate (11 accepted / 9 rejected).
66 access-log records соответствуют закрытой схеме без body/headers/nonce/IP.
Оба own containers удалены, synthetic keys/CSRs удалены, installed runtime tree
и copied fixture sources не изменились. До реального HMAC/payment/provider handler
этот observer-fixture не доходит.

Receipt SHA: `197250e27b914705e9d22babd233edc95edcb263e5fb1c6d1ecc13fe6b474807`;
probes SHA: `69d25c7770f73b8ad3a3e3bf4864e5a707d1a8056a54efd962afe7d08fb72476`.
Эта квитанция не входит в immutable install packet и не открывает deploy gate.

| Статус | Что остаётся |
| --- | --- |
| OPEN CONTROL | Произвольные `X-Forwarded-*` ещё не стираются: известные имена очищаются, wildcard-header probe намеренно сохраняет `KNOWN_BLOCKER_CONFIRMED` |
| NOT PROVEN | Source rate/concurrency независимо от более строгого client limiter; нужны разные допущенные synthetic identities |
| NOT TESTED | TLS ниже 1.2, absent SNI, client concurrency, source CIDR denial, request-line/header limits, upstream idle timeout/no-retry, absolute request deadline |
| NOT IMPLEMENTED | Controlled production config application/worker-generation collector, external vantage/direct-sidecar proof, production certificate revocation |

Не следует включать `proxy_pass_request_headers off` без нового решения: это может
стереть duplicate-header evidence до raw guard. Нельзя ослаблять existing forwarding
contract ради зелёного fixture. `proxy_read_timeout=15s` — интервал между чтениями,
**не общий wall-clock deadline**. [Nginx proxy timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout).

`nginx -t/-T` и даже успешный reload не доказывают applied worker generation общего
сервера. Старые workers могут завершать запросы после HUP; production требует
отдельного controlled-application receipt и внешних probes.
[Nginx process control](https://nginx.org/en/docs/control.html).

## Свежий runtime audit: фактическая квитанция

- Audit завершён `2026-09-06T09:09:03.738Z`, Linux/x64, Node `22.23.2`, npm `10.9.8`,
  Node-RED `5.0.6`; installed packages `291`, version/install/tree exit `0`.
- `npm audit` завершён exit `1`: **7 moderate**, 0 critical/high/low; это findings,
  а не сбой исполнения. Remediation зависимостей не проводилась.
- Image reference/container ID используют index `83f487e0…`; platform image —
  `4d676821…`. Эти наблюдения не взаимозаменяемы.
- `executionEvidence` сохраняет actual argv/time/exit/stdout+stderr hashes, source
  hashes, before/after container policy, raw receipt/observation hashes и cleanup.
  Numeric UID заменён на проверенный `nonRootUser`; private host paths не копируются.
- Audit report SHA: `6d9f6bddd4ac0d8f5cb485a7978c6744849de8091f9547ed9ce14a07c9ed643c`.
- Runtime manifest SHA: `bdb3bce1c7b50211ac2070ec143b4d6f3a182490ac86cd78294bee96b96f97a9`.
- Raw receipt SHA: `c7759e03484dcb220d39e680229dabd743a9e41120f80114b572a69abf5f1fd6`.
- Проверенный custom7 release, functional/dependency-tree/guarded files не изменены;
  их исторические даты не обновлены. Свежий audit не делает их новым запуском.

Validator сравнивает **весь** `audit.runtime`, проверяет exact schema и independently
pinned execution receipt; пересчёт caller-side manifest hashes не допускает подмену
Linux на macOS, image, cleanup, времени либо production claims. Следующий audit
требует новых наблюдений и review; механическая замена `capturedAt` запрещена.

Новые unit tests: certificate/host/scope injection, immutable local-only output,
case-sensitive leaf, complete HTTP framing, pre-Docker failure cleanup и resealed
runtime proof tampering. Предварительные physical failures сохраняются как FAIL,
не суммируются с успешными probes: client half-close дал `499`, fixture без x/y —
`Circular config node dependency` и upstream `404`.

## Следующий gate

Verification этого source checkpoint: `npm run test:partner-game-membership-api`
**299/299 PASS**, runtime/controls validators PASS, `npm run lint` — 0 errors /
387 warnings в существующем коде, `npm run build` — prod/dev PASS (включая TypeScript)
с инертными `ci.invalid` compile-time values. Общие frontend dependencies использованы
read-only; package-lock SHA у task/shared checkout совпадает. Никакой npm install
в shared checkout не выполнялся. Physical receipt независимо проверен security
reviewer; runtime pins — release reviewer. Новых P0–P2 source findings нет; OPEN
controls остаются release blockers, а не считаются закрытыми замечаниями безопасности.

Сначала закрыть локальные OPEN/NOT_TESTED и review; затем отдельно согласовать
integration exact-head, publication и production application. Старый опубликованный
disabled packet остаётся неизменным. Новый audit/control SHA потребует **нового**
пакета из clean approved pushed commit; переписывать прежний packet нельзя.

[Матрица тестов](PARTNER_GAME_MEMBERSHIP_TEST_PLAN.md) ·
[Вопросы партнёру по критичности](PARTNER_GAME_MEMBERSHIP_EXTERNAL_TEAM_QUESTIONS.md) ·
[Редактируемая инфографика](assets/partner-game-membership-ingress-evidence.drawio).

Инфографика: четвёртая страница existing `.drawio`; structural validator — 0 errors,
0 warnings. PNG preview не получен: установленный draw.io `31.1.5` завершался
`Unable to find helper app`/Electron GPU failure, включая одну host retry.
Зависший собственный export завершён по проверенному PID; открытое пользовательское
приложение не затрагивалось. XML сохранён; визуальная проверка PNG — NOT_RUN.
