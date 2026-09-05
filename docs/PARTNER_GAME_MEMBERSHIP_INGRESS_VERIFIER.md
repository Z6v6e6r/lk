# Partner API: ingress evidence core

Статус: реализована **общая локальная часть**, не production live-verifier.
`verifyPartnerProductionIngress()` безусловно завершается
`UNSUPPORTED_INGRESS_ADAPTER`. Нет CLI, сетевого collector, чтения production,
проверки X.509 certificate/CA или физических TLS/mTLS probes. Существующие
production-controls, binding, immutable packet и runtime не меняются.

Исходник: `scripts/partner_game_membership_ingress_evidence.mjs`.
Тесты: `scripts/tests/partnerGameMembershipIngressEvidence.test.mjs`.
[Редактируемая схема границ](assets/partner-game-membership-ingress-evidence.drawio).

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

1. **P0, владелец инфраструктуры:** выбрать ingress, версию и topology: exact host/SNI,
   место TLS/mTLS termination, proxy chain, service/listeners, shared hostnames.
   Синтетический путь Caddy в прежних тестах не является этим решением.
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

Физический TLS, Linux-host collector и production evidence: **NOT_RUN / NOT_IMPLEMENTED**.
Не следует подменять эту отметку результатом unit-тестов или прошлым зелёным main CI.

Локальная проверка 2026-09-05: Partner suite `131/131`, ESLint, TypeScript и inert
prod/dev build PASS (macOS, Node 22.13.1); независимые security и release/CI reviews
не обнаружили P0–P2 для этого ограниченного scope. Новый diff ещё не проверен clean
Linux exact-head CI. Drawio XML проходит structural validator; PNG export/visual QA
не выполнены из-за ошибки установленного Electron helper, XML остаётся редактируемым.
