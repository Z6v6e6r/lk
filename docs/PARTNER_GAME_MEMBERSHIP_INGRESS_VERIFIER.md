# Partner API: ingress evidence core

Статус: реализована **общая локальная часть**, не production live-verifier.
Отдельно добавлен [raw-request guard и физическая локальная Nginx-репетиция](PARTNER_GAME_MEMBERSHIP_RAW_GUARD.md).
Новый кандидат ещё не включён в frozen production packet.
`verifyPartnerProductionIngress()` безусловно завершается
`UNSUPPORTED_INGRESS_ADAPTER`. Нет CLI, сетевого collector, чтения production,
проверки X.509 certificate/CA или физических TLS/mTLS probes внутри этого verifier. Существующие
production-controls, binding, immutable packet и runtime не меняются.

**Выбор 2026-09-05: Nginx, подтверждён пользователем.** Read-only `nginx -v/-V`
на `lk-primary-147` показал `nginx/1.24.0 (Ubuntu)`, `--with-http_ssl_module` и
`--with-http_v2_module`. Среди отдельно проверенных флагов отсутствуют
`--with-control-api`, `--without-http_limit_req_module` и
`--without-http_limit_conn_module`. Это build metadata, не аттестация работающего
процесса и не security audit Ubuntu package. Конфиги, сертификаты и секреты не читались;
reload/restart/upgrade не выполнялись. Выбирать Caddy больше не требуется.

Исходник: `scripts/partner_game_membership_ingress_evidence.mjs`.
Тесты: `scripts/tests/partnerGameMembershipIngressEvidence.test.mjs`.
[Редактируемая схема границ](assets/partner-game-membership-ingress-evidence.drawio).

## Nginx 1.24: узкий capability preflight

`scripts/partner_game_membership_nginx_preflight.mjs` экспортирует чистую функцию
`preflightPartnerNginx124`. Нет CLI, shell, файлового/сетевого I/O, генерации конфига
или вызова production verifier. Проверка не читает host самостоятельно.

Вход — закрытый объект:

- `buildMetadataBytes`: canonical JSON Buffer не более 4096 bytes с exact
  `formatVersion: 1`, `kind: SANITIZED_NGINX_BUILD_CAPABILITIES`,
  `version: 1.24.0`, `distribution: Ubuntu`, `inspectedFlags`, `presentFlags`;
- `inspectedFlags` внутри artifact — в точном порядке все пять флагов из абзаца
  выше: SSL, HTTP/2, control API, отключение request limit, отключение connection
  limit. `presentFlags` — уникальное подмножество; неизвестная/неполная наблюдаемая
  область отклоняется. Полный `nginx -V` с build paths/компиляторными аргументами не
  включается в публичный artifact;
- `expectedBuildMetadataSha256`: отдельный pin этих bytes, не доказательство их
  происхождения; его нельзя превращать в host approval;
- `controlsBytes`: exact checked-in production-controls Buffer;
- `sidecarSources`: exact Buffers `core`, `node`, `settings` проверяются по трём
  reviewed source SHA, зафиксированным в preflight. Даже совпавшие SHA не означают
  наличие raw-request guard.

Результат всегда `LOCAL_NGINX_124_CAPABILITY_CHECKED_NOT_ACTIVE`, `decision: BLOCKED`.
`productionVerified`, `configGenerationAllowed`, `deployAuthorized` и
`activationAuthorized` равны `false`. Каждый элемент routing/transport/request/
response policy получает owner и `evidence: NOT_PROVEN`; owner обозначает будущую
ответственность, а не выполненную проверку. Неизвестные input fields, чужая версия,
source/control drift и попытки передать `PASS`, exec hook, reload receipt или config
dump отклоняются. Отсутствие SSL, отключённые rate/concurrency modules и необычная
patched 1.24 build с control API добавляют конкретные blockers.

Три обязательных blocker не снимаются текущими inputs:

1. `RAW_DUPLICATE_HEADERS_GUARD_UNPROVEN`: текущий Node-RED handler передаёт
   нормализованные `req.headers`, а не проверенный набор `rawHeaders`. Unit-тест
   дубликатов в core не доказывает поведение всей входной цепочки.
2. `RAW_DUPLICATE_JSON_GUARD_UNPROVEN`: handler передаёт `msg.payload`, то есть уже
   разобранное тело. Дубликаты JSON нужно отклонить до стандартного JSON parser;
   Nginx core и HMAC над разобранным объектом эту проверку не заменяют.
3. `EFFECTIVE_CONFIG_UNPROVABLE`: Nginx 1.24 не имеет используемого в новых версиях
   Control API для in-memory config. `nginx -t/-T` не доказывает, что workers применили
   эти файлы. См. [Nginx CLI](https://nginx.org/en/docs/switches.html) и
   [Runtime control](https://docs.nginx.com/nginx/admin-guide/basic-functionality/runtime-control/).

Preflight не закрывает ни один из 16 deploy gates. Следующая локальная реализация —
проверяемый raw-request guard до Node-RED parser и закрытый Nginx generator после
фиксации exact host/cert/CA/path inputs. Произвольные snippets/includes не принимаются;
универсальный parser чужих Nginx configs сейчас не вводится.

## Legacy Nginx: предлагаемый live evidence path

Это проект процедуры, **не утверждённый operator и не разрешение на reload**:

1. Fresh challenge и root-owned one-shot collector под общим deployment lock;
   привязка host/boot, master PID/start time, executable, unit, listeners, exact `-p/-c`.
2. Exact config/include/certificate closure до изменения; immutable reviewed candidate,
   заранее проверенный backup/rollback и отсутствие чужих конфликтующих writers.
3. Только отдельно согласованный `nginx -t`/controlled reload; затем доказанная новая
   worker generation, отсутствие прежних workers и неизменный closure после reload.
4. Физические SNI/Host/mTLS/routes/limits/CORS probes с внешней точки и отдельная
   проверка direct sidecar. Повторный snapshot process/config должен исключить drift.
5. Receipt связывает fresh challenge, source/config/probe digests, process generation,
   vantage и collector identity. Подпись не заменяет причинную цепочку наблюдений.

Без этой цепочки итог остаётся `EFFECTIVE_CONFIG_UNPROVABLE`; успешный exit reload или
caller-supplied signed dump сам по себе недостаточен. Для 1.24 это доказательство
контролируемого применения, не прямой memory dump. Если потребуется именно memory
dump, upgrade/instrumentation — отдельный scope, сейчас он не согласован.

У Nginx ошибки клиентского сертификата могут обрабатываться как внутренние коды
`495/496` после parsing HTTP, а не исключительно TLS alert. Нынешняя generic fixture
matrix намеренно не расширена до принятия любого HTTP 400: будущий Nginx-specific
probe должен доказать отказ до upstream и положительный контроль того же пути.
[Официальная семантика](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#error_processing).

## Что проверяется сейчас

| Функция | Вход / гарантия | Чего она не доказывает |
| --- | --- | --- |
| `parseCanonicalIngressJson` | Buffer, закрытый размер, exact canonical JSON bytes; неоднозначные/повторные ключи отклоняются | Происхождение документа |
| `validateIngressContext` | Закрытые 18 полей, SHA и exact host/audience | Что эти значения получены с сервера |
| `verifySignedPartnerReachability` | Ed25519, out-of-band pin публичного ключа, exact context, время действия ≤24 ч | Верность заключения аудитора, живую конфигурацию, одноразовость API-запроса |
| `readPinnedIngressArtifact` | Exact path/hash, приватный файл, owner/mode, безопасные ancestors, отсутствие symlink/hardlink, стабильность файла при чтении | Эффективную конфигурацию процесса, защиту от скомпрометированного root |
| `evaluateLocalPartnerIngressObservations` | Полноту локальной матрицы, допустимые исходы, отсутствие context drift за окно ≤60 с | Что probes реально выполнялись, внешний доступ или production enforcement |

Результаты не дают разрешений: `SIGNED_REACHABILITY_VERIFIED_NOT_AUTHORIZED` либо
`LOCAL_INGRESS_OBSERVATIONS_VALIDATED_NOT_LIVE_PROOF`; у последнего
`productionVerified`, `deployAuthorized`, `activationAuthorized` равны `false`.
Caller-supplied dumps, команды, `PASS` и booleans не могут открыть production entry.

## Подписанный reachability artifact

Envelope — exact canonical JSON `{payload, signature}`; никакого доверенного ключа
внутри самого envelope. `signature` — canonical base64url без padding, Ed25519 над
UTF-8 строкой `PADLHUB-PARTNER-INGRESS-REACHABILITY-V1\n` и `canonicalJson(payload)`.
Используется существующая функция canonical JSON проекта, а не произвольная JSON
сериализация. Публичный ключ передаётся отдельным PEM Buffer и проверяется по
out-of-band approved SHA-256 DER SPKI. Закрытый ключ verifier не принимает.

Закрытый payload:

- `formatVersion: 1`, `kind: PARTNER_INGRESS_REACHABILITY`;
- `decision: NO_REACHABLE_HIGH_OR_CRITICAL`, `reachableHighPackages: []`;
- `issuedAt`, `expiresAt`: canonical ISO UTC с миллисекундами; будущее, истечение,
  обратный интервал и срок более 24 часов отклоняются; `now` задаётся доверенным caller;
- `context`: нижеуказанные exact поля; ожидаемые значения приходят независимо от
  подписанного документа и не могут назначаться самим envelope.

| Контекст | Поля |
| --- | --- |
| Release | `approvedCommit`, `approvedTree` (40 hex), `packetManifestSha256`, `controlsSha256`, `runtimeManifestSha256`, `auditReportSha256` |
| Config / identity | `configClosureSha256`, `effectiveConfigSha256`, `clientCertificateSpkiSha256`, `clientCaBundleSha256`, `exactHost`, `audience` |
| Runtime epoch | `hostMachineIdSha256`, `bootIdSha256`, `serviceIdentitySha256`, `executableSha256`, `processStartIdentitySha256`, `runtimeGenerationSha256` |

Все SHA-256 — 64 lowercase hex. Cross-context повторное использование подписи
отклоняется. Повторная проверка того же неизменного artifact в пределах срока допустима:
это evidence, а не одноразовый бизнес-запрос. За защиту API-запроса от повтора отвечают
существующие HMAC, timestamp, nonce, idempotency и mTLS — данный модуль их не заменяет.
Алгоритмы получения runtime/config hashes ещё должен определить выбранный adapter.

## Файлы и локальные наблюдения

Artifact reader требует canonical absolute realpath, regular file, один hardlink,
mode `0600`, expected owner UID (по умолчанию root), размер 1..1 MiB и exact SHA-256.
Ancestors не допускают symlink или group/other write и принадлежат root/expected UID.
Файл открывается с `O_NOFOLLOW`; identity/mode/size/mtime/ctime сверяются до/после
чтения и с именованным путём. Ошибки возвращают только фиксированный код, без bytes
или path. ACL, bind mounts, root compromise и полная Linux custody остаются отдельной
проверкой будущего collector; этот helper не служит самостоятельным sandbox.

Локальная матрица требует ровно по одному результату каждого вида:

| Probe | Допустимый локальный исход |
| --- | --- |
| `positiveDefaultOff`, `cors` | Authenticated TLS, HTTP 503, `Cache-Control: no-store` |
| `wrongHost` | Authenticated TLS, HTTP 400/421 |
| `sharedHost`, `editorAdmin` | Authenticated TLS, HTTP 404 |
| `options` | Authenticated TLS, HTTP 400/404/405 |
| `query` | Authenticated TLS, HTTP 400/404 |
| `wrongSni`, `noClientCertificate`, `wrongClientCertificate` | Явный TLS rejection, не общий network error |
| `directSidecar` | Connection refused; не timeout и не HTTP ответ |

Для всех запрещён CORS, обязателен `vantage: LOCAL_FIXTURE`; timestamps внутри одного
окна ≤60 секунд. Любое изменение runtime/config context, пропуск, дубликат, `NOT_RUN`,
timeout или неоднозначный reset отклоняется. Даже валидная матрица остаётся локальной.

## Следующая реализация: решения по критичности

1. **P0, владелец инфраструктуры:** Nginx выбран, build 1.24.0 наблюдался read-only.
   Осталось закрепить topology: exact host/SNI, место TLS/mTLS termination, proxy
   chain, service/listeners, shared hostnames. Старый Caddy path в synthetic fixture
   остаётся только fixture, он не назначает production topology.
2. **P0, инфраструктура + security:** определить доверенный read-only источник именно
   загруженной конфигурации и runtime generation. Одни файлы, `nginx -T`, `caddy adapt`
   или unit dump недостаточны. При отсутствии доказательства —
   `EFFECTIVE_CONFIG_UNPROVABLE`; reload/restart требует отдельного согласования.
3. **P0, security + партнёр:** определить владельца reviewer key и безопасную передачу
   SPKI pin, тестового client certificate и CA; секретные ключи не входят в Git/логи.
   Определить внешнюю точку probes, чтобы проверить shared host/direct sidecar,
   не путая loopback fixture с внешней недоступностью.
4. **P1, инфраструктура:** реализовать закрытый versioned adapter, собственный сбор
   config/include/certificate closure, X.509 validation, snapshot до/после probes,
   строгую привязку к host/process/executable/runtime epoch и redactable receipt.
   Live receipt должен отдельно включать digest фактических probe-результатов,
   adapter/collector identity/version, доверенную vantage и одноразовый run challenge;
   подписанный audit artifact с допустимым повторным чтением не заменяет этот receipt.
5. **P1, тестирование + партнёр:** физическая isolated TLS/mTLS matrix: positive control,
   no/wrong cert, SNI/Host, query/OPTIONS, CORS, proxy headers и route isolation.
   Затем отдельно согласованные live probes. Ошибка транспорта не равна PASS.

Это дополнение к вопросам партнёру и 16 `requiredBeforeDeploy` в `deployment-plan.json`,
а не их замена. Mongo/Viva gates, отдельная интеграция, push, deploy и activation
остаются самостоятельными этапами; никакие текущие локальные функции их не открывают.

## Проверки

`npm run test:partner-game-membership-api` включает новый suite. Его unit/filesystem
тесты покрывают подпись и все поля контекста, tampering, недоверенный/неверный ключ,
expiry, canonical encoding, размер, file ownership/modes, symlink/hardlink,
подмену файла при чтении, полноту матрицы, drift и запрет повышения local proof до live.
Ключи тестов генерируются только в памяти; shared data и реальные сертификаты не нужны.

Production TLS, Linux-host collector и production evidence: **NOT_RUN / NOT_IMPLEMENTED**.
Отдельный raw-guard fixture теперь физически проверяет HTTP/1.1 TLS с синтетическим
client certificate и no-cert rejection, но не всю generic/live matrix.
Не следует подменять эту отметку результатом unit-тестов или прошлым зелёным main CI.

Первый checkpoint `3e5965a` (до выбора Nginx): Partner suite `131/131`, ESLint, TypeScript и inert
prod/dev build PASS (macOS, Node 22.13.1); независимые security и release/CI reviews
не обнаружили P0–P2 для этого ограниченного scope. Новый diff ещё не проверен clean
Linux exact-head CI. Drawio XML проходит structural validator; PNG export/visual QA
не выполнены из-за ошибки установленного Electron helper, XML остаётся редактируемым.

После выбора Nginx добавлены 12 capability/negative regressions в существующий suite:
unknown/duplicate/incomplete metadata, disabled modules, source/control drift,
непроверенные raw guards и запрет caller claims. Новый combined suite `143/143`,
full ESLint/TypeScript и inert prod/dev build PASS; scoped security review P0–P2=`0`.
XML повторно проходит structural validation; PNG/visual QA не повторялись.
На момент checkpoint `956af9b` локальный Docker daemon был недоступен;
его не запускали и не перезапускали. Physical Nginx/Node-RED rehearsal тогда оставалась NOT_RUN.

Следующий одобренный локальный этап: Docker уже работал, restart не потребовался.
Raw guard/factory добавлены отдельно от pinned settings; `135/135` physical probes
на Linux x64 Node 22.23.2 / Node-RED 5.0.6 / Nginx 1.24 прошли. Это не обновляет
старые source pins, не снимает live blockers и не разрешает deploy/activation.
См. отдельный runbook выше: scope, исходники, ограничения и воспроизведение.
