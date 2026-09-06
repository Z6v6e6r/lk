# Partner API: локальный Nginx 1.24 candidate и свежий audit

Дата: 6 сентября 2026. Это продолжение существующей Partner-ветки, **не выпуск**.
Production verifier по-прежнему возвращает `UNSUPPORTED_INGRESS_ADAPTER`;
deploy/activation остаются `false`. Боевые Nginx, Node-RED, Mongo и Viva не меняются.

## Исправление aggregate limit: консервативный бюджет

Раздел ниже — историческое доказательство checkpoint `32c0ad6`. Последующий
локальный response-deadline gate и его ограничения описаны
[отдельно](PARTNER_GAME_MEMBERSHIP_RESPONSE_DEADLINE.md); старые receipts сохранены.

После `c38bc73` пользователь одобрил только исправление aggregate limit и локальные
проверки. Generator сохраняет `client_header_buffer_size 2k`, но меняет дополнительные
буферы на `large_client_header_buffers 7 2k`. Начальные2KiB учитываются отдельно:
общий верхний бюджет теперь16KiB, включая request line и потери при переносе
неполного поля. Keepalive и HTTP/2 остаются выключены; overrides/includes отсутствуют.
Новых модулей, зависимостей, изменений raw guard/service/control pins нет.

Это **не точный header-only порог приёма**. Некоторые запросы с меньшим объёмом
заголовков могут быть отклонены из-за их упаковки. Контракт `maxHeaderBytes=16384`
задаёт максимум, а не обязанность принимать любую комбинацию такого размера.
Обещание принимать body16384 отдельно сохраняется. Основание: в Nginx1.24 начальный
buffer и `hc->nbusy` дополнительных buffers учитываются раздельно; копирование
partial field расходует ёмкость. [Nginx1.24 source](https://github.com/nginx/nginx/blob/release-1.24.0/src/http/ngx_http_request.c#L1467),
[buffer contract](https://nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers).

Добавлены шесть физических regressions: packed whole head16384 для трёх методов
(POST также с body16384; DELETE/GET с максимальными идентификаторами), whole
head16385, header section16385 и тот же packed объём с переставленными padding
fields. Последний показал консервативный ранний отказ — это не успешный
приём. Сохранён исходный17562-byte запрос. Проверка ingress отказа требует HTTP400,
нулевые observer/request counters **и единственный actual access row** со
`status="400", upstream=""`. Missing field, `"-"` и upstream400/431 не допускаются.
JSON `escape=json` записывает отсутствие upstream как пустую строку; один нулевой
Node counter недостаточен, поскольку parser431 возникает до request event.

Source gate на final bytes: **311/311 PASS**, skipped0; full lint0errors/
387existingwarnings. В aggregate-fix diff новых существенных security/release
findings нет; `ABSOLUTE_REQUEST_DEADLINE` остаётся подтверждённым blocker.
Runtime matrix завершена `2026-09-06T11:08:36.588Z`: **69 rows =68PASS +1
KNOWN_BLOCKER_CONFIRMED**, state `LOCAL_MATRIX_WITH_CONFIRMED_BLOCKERS`.
Это не полный PASS ingress: confirmed control failure — `ABSOLUTE_REQUEST_DEADLINE`.
Deadline матрицы150s зафиксирован до runtime admission; per-request bounds прежние.
Прежние guardedCLI20/frontend prod-dev build применимы только к их unchanged inputs,
не являются новыми запусками и не разрешают production. Старый failed receipt ниже
сохранён как историческое доказательство дефекта, не переписан.

| Actual probe | Результат |
| --- | --- |
| Header section17562 и16385 | Nginx400, `upstream=""`, observer/request counters0 |
| Packed whole head16384: POST / DELETE / GET | Observer503, один upstream/dispatch; header sections16317/16006/16178, соответственно |
| POST одновременно whole head16384 + body16384 | PASS: body budget не подменён head budget |
| Whole head16385 | Nginx400 без upstream, хотя header section16318 — намеренно консервативный предел |
| Те же whole head16384/header section16317, другой порядок padding | Nginx400 без upstream: подтверждена зависимость раннего отказа от упаковки |
| Client concurrency | Четыре active handlers, пятый429 от `limit_conn`, не rate limiter; затем recovery503 |
| Idle timeout/no retry | 504 через15040ms, один upstream/dispatch, handler закрыт |
| Absolute request deadline15s | **BLOCKER**: полный503 через18048ms, первый байт28ms, 12 response chunks; observer выполнил10 drip writes |
| Recovery после матрицы | Корректный запрос503, один upstream/dispatch |

`proxy_read_timeout` ограничивает паузу между чтениями, а не общую длительность:
периодический ответ обходит именно wall-clock bound. Это не проверка реальной Viva
операции или business timeout; дефект доказан в isolated ingress/observer contour.
[Nginx proxy read timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout).

- Receipt SHA: `0cb100645642c3a584ed67f4169bb51501ba0544c4becd39e505a91366054675`.
- Probes SHA: `afd1019add916e5ee932f2a58dc53218be91965604bf3c30677b4c2dc5171e38`.
- Config SHA: `067455adb386d9878b48e9db8a69c720c597df6b0a72bb8179ab85db0f0a0703`.
- Все9 current source hashes,6 fixture copies, config, runtime before/after и
  container/process identities прошли collector postchecks. Runtime tree
  `6daf6d15…` совпадает с reused actual audit; нового install/audit не было.
- 88 закрытых metadata log rows; два exact owned containers удалены и отсутствие
  подтверждено отдельным Docker readback. Synthetic keys/CSRs отсутствуют.
- `notTested=[]` относится только к named69row local matrix: независимые source
  limits, external/direct-sidecar, production collector/revocation остаются OPEN.
- Heavy-slot RELEASED; после первого подтверждённого deadline blocker — только
  завершение предусмотренного recovery/cleanup и docs/checkpoint, без второго run.

На момент этого checkpoint следующим gate был общий15s deadline и его
recovery/negative tests. Он выполнен в последующем локальном исправлении
[response watchdog](PARTNER_GAME_MEMBERSHIP_RESPONSE_DEADLINE.md). Боевой verifier
остаётся безусловно unsupported.

## Предыдущая boundary-репетиция: STOP на суммарных заголовках

Run завершён `2026-09-06T10:37:25.320Z` со статусом **FAILED**: 57 PASS rows
(49 baseline + 8 новых), затем отказ проверки `aggregate-header-over-16k`.
Это не полный PASS матрицы и не подтверждение остальных проверок.

| Фактическая проверка | Результат |
| --- | --- |
| TLS 1.0 / 1.1 | PASS: explicit server `protocol_version` alert; upstream 0 |
| Отсутствующий SNI | PASS: `unrecognized_name` alert; upstream 0 |
| Socket source `127.0.0.2`, valid cert, поддельный allowed XFF | PASS: 403; upstream 0 |
| Wire request line 2048 / 2049 bytes | PASS: 404 (route rejection) / 414; upstream 0 |
| Отдельный header field 2048 / 2049 bytes | PASS: 503 observer / 400 ingress rejection |
| Суммарный header section **17562 bytes**, 29 fields | **FAIL expected ingress control**: Nginx передал запрос upstream; HTTP-парсер Node вернул431 |
| Client concurrency, idle timeout/no retry, absolute deadline | **NOT_RUN**: остановка произошла раньше |

Expected для aggregate probe: отклонение Nginx до обращения к sidecar (400,
upstream 0). Observed: последний access-log row `status=431`, `upstream=431`,
`clientVerified=1`, rate/concurrency `PASSED`. Сумма всех предыдущих request/dispatch
counters совпадает с final snapshot (42/21): oversized request не вызвал ни HTTP
request event, ни business observer — его остановил Node parser. Таким образом,
**обхода бизнес-обработчика не обнаружено**, но Nginx-only aggregate enforcement
не доказан и фактически не выдержал этот probe. Это не просто спор о коде400/431:
сменился слой отказа. Existing preflight относит `maxHeaderBytes` к Nginx/host owner.

`large_client_header_buffers 8 2k` ограничивает буферы и размер отдельного поля,
но его нельзя объявлять точным total16KiB cap без проверки. Сам факт передачи
17562-byte header section доказан этим run; изменение числа буферов без новых
boundary/compatibility tests не выполнено. [Nginx buffer semantics](https://nginx.org/en/docs/http/ngx_http_core_module.html#large_client_header_buffers).

- Raw receipt SHA: `98a0577f08b8bfa06bc37cd1a858bc4a1e00ef9313625c7071fe6c719f7ac95c`.
- Partial probes SHA: `058b0272ec3cca431c41625ec373b821cb42ea8e13229da6021ed6ff78838056`.
- 73 access-log rows, закрытая metadata schema; последние запросы сопоставлены
  с порядком serial probes. Неуспешный probe не включён в 57 PASS rows.
- Оба exact owned containers удалены; synthetic keys/CSRs отсутствуют, финальный
  Docker absence readback пуст. Девять source hashes совпадают с retained receipt.
- Post-matrix runtime/config identity checks в collector **не выполнены**, поскольку
  runner завершился раньше с failure; наличие before hashes не заменяет after proof.
- Generator, raw guard, service, runtime lock и все production/control pins
  **не менялись**. Старые49/20/303 receipts/packet не переписаны; повторного run нет.

Добавлены pure evidence assertions и opt-in remaining matrix: planned63rows означают
62PASS + один **ожидаемый диагностический** deadline blocker только при полном
фактическом выполнении. На предыдущем STOP этот итог **не получен**; `notTested=[]` тогда не выдан.
Для TLS-negative lowered cipher security применяется только к отдельному synthetic
клиенту, не к Nginx и не глобально. [Node TLS contexts](https://nodejs.org/docs/latest-v22.x/api/tls.html#openssl-security-level).

После test-only изменений: unit19/19 и полный Partner suite **308/308 PASS**,
skipped0; full lint0errors/387existingwarnings. Это source tests, не замена FAILED physical run. Full frontend build и
guarded CLI не повторяются: их inputs не менялись; прежние результаты остаются
историческими, без новой даты и без заявления о current physical PASS.

Предложение на момент предыдущего STOP (выполнено в новом run выше): исправить и проверить **суммарный ingress header
limit** в том же локальном generator, сохранив duplicate evidence и допустимые
запросы; затем продолжить оставшиеся probes после нового runtime admission/slot.
Deadline не был подтверждён предыдущим run: drip18s тогда ещё не запускался.

## Текущий результат: wildcard fix подтверждён локально

После checkpoint `069d3b8` подтверждённый wildcard gap исправлен в existing raw
ingress boundary: **сначала** исходная duplicate/framing validation, **затем** удаление
`Forwarded`, всех case-insensitive `X-Forwarded-*` и `X-Real-IP` из `req.headers`,
`req.headersDistinct` (включая lazy cache) и `req.rawHeaders`. Proof/audience/
idempotency/Host headers, method/path и payload не меняются. Nginx по-прежнему
применяет source limiter к своему socket peer; sidecar не наследует forwarded chain
и не утверждает, что loopback peer — публичный клиентский IP.

Sanitizer failure не допускает dispatch и сохраняется как закрытый audit code.
Проверка через настоящий durable sink включает следующий корректный запрос и
повторное открытие audit log: rejection не должен отравить audit latch.
Source checkpoint `889ebe3` имел scoped raw-guard + guarded-startup **144/144 PASS**.
На тех же source bytes выполнены новые независимые physical runs: **Nginx 49/49**
и **guarded Node-RED CLI 20/20**. Это не systemd и не production proof.

На source-only checkpoint старые pins намеренно давали fail-closed packet refusal.
Теперь `guarded-sidecar-rehearsal.json`, оба guard/audit hashes, production-controls,
hardcoded validator и Nginx preflight pin обновлены **по новым actual receipts**.
Проверены все 20 source hashes против current files и retained fixture copies;
новая связанная closure проходит validator. Старые квитанции и опубликованный
disabled packet не изменялись. Одинаковый probes SHA у двух CLI runs закономерен:
детерминированные 20 результатов совпали; свежий receipt имеет новые source hashes,
container cleanup identities и actual capturedAt.

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

Исторический wildcard run завершён `2026-09-06T10:09:12.433Z`: **49 PASS**,
без known-blocker rows. Проверены positive
TLS1.2/1.3, no/wrong/unbound cert, SNI/Host/shared-host, три routes, запрещённые
methods/query/encoding/editor, duplicate proof headers/JSON, body 16384/16385 bytes,
known/wildcard forwarding и duplicate wildcard rejection, no-store/CORS и client
rate (11 accepted / 9 rejected). 67 access-log records соответствуют закрытой схеме
без body/headers/nonce/IP.
Оба own containers удалены, synthetic keys/CSRs удалены, installed runtime tree
и copied fixture sources не изменились. До реального HMAC/payment/provider handler
этот observer-fixture не доходит.

Receipt SHA: `93d2356dda55eaa10878c0dbb4b74b3753fad7c64b455e79d4adf51498d09678`;
probes SHA: `e1ce70e74de6f2ff5518aeaad512bda52acfb04ec875d9ad2223291c110266c0`.
Эта квитанция не входит в immutable install packet и не открывает deploy gate.
Исторический run `2026-09-06T09:40:57.487Z` остаётся **47 PASS + 1
KNOWN_BLOCKER_CONFIRMED**, receipt `197250e2…`: его результат не переписан.

| Статус | Что остаётся |
| --- | --- |
| LOCAL COMBINED PASS | Произвольные `X-Forwarded-*` стирает raw guard после duplicate validation; standalone Nginx generator по-прежнему перечисляет `WILDCARD_FORWARDED_HEADERS` как собственное ограничение |
| NOT PROVEN | Source rate/concurrency независимо от более строгого client limiter; нужны разные допущенные synthetic identities |
| LOCAL CONSERVATIVE PASS | Aggregate budget2k+7×2k:17562/16385-byte header sections отклонены до upstream; packed positives и ранний отказ при другой упаковке подтверждены |
| LOCAL PASS | Client concurrency/recovery, upstream idle timeout/no-retry в одном silence scenario; TLS/SNI/CIDR и single-line/field bounds подтверждены |
| LOCAL COMBINED PASS | Sidecar response deadline от middleware entry: в последующем70-row run drip оборван через15029ms; edge TLS/headers и hard realtime сюда не входят. Исторический18.048s blocker сохранён в прежнем receipt |
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
- Проверенный custom7 release и functional/dependency-tree files не изменены;
  их исторические даты не обновлены. Свежий audit не делает их новым запуском.
  Guarded startup теперь имеет отдельную actual квитанцию ниже.

Validator сравнивает **весь** `audit.runtime`, проверяет exact schema и independently
pinned execution receipt; пересчёт caller-side manifest hashes не допускает подмену
Linux на macOS, image, cleanup, времени либо production claims. Следующий audit
требует новых наблюдений и review; механическая замена `capturedAt` запрещена.

Новые unit tests: certificate/host/scope injection, immutable local-only output,
case-sensitive leaf, complete HTTP framing, pre-Docker failure cleanup и resealed
runtime proof tampering. Предварительные physical failures сохраняются как FAIL,
не суммируются с успешными probes: client half-close дал `499`, fixture без x/y —
`Circular config node dependency` и upstream `404`.

## Guarded CLI и связанная closure

Run завершён `2026-09-06T10:10:11.713Z`: **20/20**, 6 durable audit rows,
10 unsafe-startup refusals, stop/restart, default-off 503, admin 404. Фаза exact-lock
`npm ci` выполнялась отдельно через bridge, без lifecycle scripts/host secrets;
probes — `network:none`. Это не registry-only firewall и не новый npm audit.
Два owned containers удалены; `systemdExecuted=false`, `productionTouched=false`.

- Raw receipt SHA: `76760a3590d7e5a6c2cfe02e417dea388c3f9389d31223d78f2544502d0d241d`.
- Probes SHA: `7990bb1630f4c2100e0fa99c87fde770a7a489c117c6d25b586c5e4e8806b629`.
- Normalized rehearsal SHA: `1dafc98bae9052aa2ad50fa8033f1d36b68ca4db1e9212663d3b3206b78cf38b`.
- Controls SHA: `c5d28f1e6edf933ca9680c6ca078590bb6a59d818f9ad57304e4f8266ed1e6c2`.

## Следующий gate

Историческая verification checkpoint `b9a8a37`: `npm run test:partner-game-membership-api`
**303/303 PASS**, runtime/controls и actual-receipt closure validators PASS,
`npm run lint` — 0 errors / 387 warnings в существующем коде.
`npm run build` — prod/dev PASS, включая TypeScript, с инертными `ci.invalid`
compile-time values; эти артефакты не предназначены для deploy.
Общие frontend dependencies использованы
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
