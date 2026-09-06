# Nginx verifier: сборщик транспортных наблюдений

Статус 6 сентября 2026: **исполняемый collector source готов; production verifier
ещё не завершён**. Это продолжение той же Partner-ветки после `5b9755f`, без
изменения live ingress. [Общий production entry](PARTNER_GAME_MEMBERSHIP_INGRESS_VERIFIER.md)
по-прежнему отказывает с `UNSUPPORTED_INGRESS_ADAPTER`: нет доверенного production
сборщика поколения/config и корреляции с журналом Nginx. Подписывание произвольного
JSON не заменяет эти наблюдения. Никаких новых согласований с партнёром не требуется.

Исходник: `scripts/partner_game_membership_nginx_probes.mjs`.
Тест: `scripts/tests/partnerGameMembershipNginxProbes.test.mjs`.
Продолжение после `45d15a7`: [поколение workers и журнал](#локальная-проверка-поколения-и-корреляция-журнала)
реализованы как отдельная локальная проверка согласованности и bounded file reader.
Это не production operator, не reload и не аттестация внешней vantage.
[Редактируемая инфографика](assets/partner-game-membership-ingress-evidence.drawio),
страницы `Bounded transport collector` и `Generation and log correlation`.

## Назначение и безопасный вызов

Экспорт `collectPartnerNginxTransportObservations(input)` самостоятельно выполняет
11 последовательных TLS/HTTP/TCP попыток. Он не принимает результаты наблюдений,
команды, URL, headers, методы, body, timeout overrides, callbacks или verdict.
Импорт не выполняет I/O. CLI и автоматическое подключение к серверу не добавлены.

Это низкоуровневая функция для будущего **доверенного оператора**, не публичный HTTP
endpoint и не самостоятельная авторизация сетевого доступа. Вызов действительно
создаёт трафик: live target, client-key access и trusted vantage необходимо отдельно
разрешить и закрепить вне collector. Нельзя передавать сюда адреса из пользовательского
HTTP-запроса: это превратит функцию в средство SSRF/сканирования. Collector не может
доказать, что caller получил разрешение, и намеренно не принимает `approved: true`.

Предварительное условие будущего оператора — независимо установленный
`BOUND_DEFAULT_OFF`, dedicated ingress и точные сетевые адреса. GET-пробы не выполняют
membership add/delete, не имеют body и настоящей HMAC-подписи. Однако HTTP-запросы
создают журнальные записи; если sidecar ошибочно активен, его initialization может
обращаться к runtime до проверки proof. Поэтому collector нельзя считать заменой
default-off startup/readback gate. Сам collector Mongo/Viva не импортирует.

## Закрытый input

| Поля | Проверка |
| --- | --- |
| `targetAddress`, `sourceAddress` | Canonical numeric IPv4, без DNS, wildcard, octal, IPv6/zone, unspecified/multicast/reserved адресов. Source bind обязателен |
| `port`, `sidecarPort` | Разные целые 1..65535; утверждённые значения назначает оператор, не партнёр |
| `exactHost`, `sharedHost` | Разные exact lowercase DNS names, без wildcard/port/path/injection; `unbound.invalid` зарезервирован для отрицательных проб |
| `serverCaBytes` | Один canonical PEM CA certificate, RSA≥2048 либо EC P-256/P-384, действующий по времени |
| `clientCertificateBytes`, `clientKeyBytes` | Один canonical PEM leaf и соответствующий private key, действующие сертификат/алгоритм |
| `wrongClientCertificateBytes`, `wrongClientKeyBytes` | Другой проверяемый pair для отрицательной пробы; collector не утверждает, что сервер обязан его отклонить |
| `approvedServerSpkiSha256`, `approvedClientSpkiSha256`, `approvedWrongClientSpkiSha256` | Отдельные lowercase SHA256 DER SPKI pins. Две client identities должны различаться |

Все byte inputs — Buffer размером 1..8192. Неизвестные/пропущенные поля — отказ
до сетевого вызова. Нет чтения файлов, URL или env/proxy/credentials fallback.
Buffers копируются до первого await; изменение caller input не подменяет identity
в ходе сеанса. Собственные копии очищаются при завершении/ошибке; caller buffers
сохраняются. Это не гарантия secure erasure памяти OpenSSL/Node KeyObject или процесса.

Нынешний узкий dialect требует **общие server CA и SPKI для exactHost/sharedHost**.
Разные server certificates/chain topology и IPv6 не поддерживаются. Такую production
topology нельзя объявлять проверенной или обходить отключением TLS validation.

## Матрица и фактическое наблюдение

Сеанс создаёт random 256-bit challenge; каждому ID соответствует отдельный SHA256
probe ID с domain separation. Operation URL содержит этот probe ID и не использует
реальные game/operation identifiers. Сам probe ID в результате, в том числе для
`/flows`, не доказывает server-side обработку без отдельного сопоставления с журналом.
Новый source collector дополнительно отправляет `X-Padlhub-Probe-Id`, равный
opaque probe ID. Он не является proof header, ключом доступа или HMAC-подписью.
Ниже описан отдельный закрытый log field для точного сопоставления; старые журналы
без этого поля не принимаются путём сравнения порядка/status.

| ID | Попытка, не обещание исхода |
| --- | --- |
| `positiveDefaultOff` | GET synthetic operation через exact Host/SNI, разрешённый test client |
| `wrongHost` | Тот же SNI, `Host: unbound.invalid` |
| `wrongSni` | `SNI: unbound.invalid`, exact Host; hostname validation не отключается |
| `sharedHost` | Host/SNI shared vhost с теми же server pins |
| `directSidecar` | Только TCP connect к sidecarPort на том же target/source bind; ни одного HTTP byte |
| `editorAdmin` | GET `/flows` |
| `options` | OPTIONS synthetic operation, без body |
| `query` | GET synthetic operation с фиксированным `?probe=1` |
| `cors` | GET с фиксированным `Origin: https://ingress-probe.invalid` |
| `noClientCertificate` | GET без client cert/key |
| `wrongClientCertificate` | GET с independently pinned другим pair |

HTTP передаёт source-owned **публичные неаутентичные** proof headers, чтобы пройти
проверку наличия/формы в raw guard: unregistered client/key/audience, fresh timestamp,
nonce/probe ID, отдельные UUID idempotency/correlation. Значение signature
`not-a-v2-signature` заведомо не соответствует криптографическому контракту v2.
Это не рабочие credentials, не partner HMAC и не bypass: active API не может принять
такой proof. Default-off store отвечает раньше proof verification. Проверка через
actual raw guard и actual disabled store закреплена тестом, не только mock HTTP503.

Соединение создаётся по literal IP с обязательным source bind, TLS1.2–1.3 и
ALPN HTTP/1.1. Проверяются CA/hostname и **actual server SPKI + local client leaf**
перед отправкой HTTP. На каждую пробу новый socket/agent; нет session reuse, DNS,
redirect follow, proxy, business retries, cookies или реальных signing keys.

Абсолютный deadline — 5 секунд на пробу и 60 секунд на весь сеанс по monotonic clock,
с дополнительной проверкой wall-clock rollback/expiry. Проверка выполняется также
в callbacks и перед итоговым результатом, а не только по inactivity timer. Ответ
ограничен 16 KiB headers и 16 KiB body. Используется strict Node HTTP parser;
дубликаты заголовков, compression, неизвестный transfer encoding, oversized,
incomplete framing, trailers, informational/upgrade response отвергаются. Chunked
без trailers поддерживается. Body не сохраняется: только размер и SHA256.
Finish однократный, таймер и собственные socket/request/response/agent закрываются.
Hard real-time при остановленном event loop/процессе не гарантируется.

## Семантика результата — никакого допуска

Всегда `NGINX_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF`;
`productionVerified = deployAuthorized = activationAuthorized = false`;
`vantage: UNATTESTED`, `applicationEvidence/upstreamAdmission: NOT_COLLECTED`.
Некорректный input и просроченный сеанс дают фиксированную ошибку; транспортные
неуспехи остаются отдельными строками наблюдения. Raw errors, response headers/body,
сертификаты и ключи не возвращаются и не логгируются. Result содержит socket IP/ports
и должен храниться как **приватное operator evidence**, не публиковаться партнёру/Git.

- `HTTP_RESPONSE` — complete response, даже если это небезопасный 200/503 для wrong
  client или 302. Redirect не выполняется. Статус сам по себе не считается PASS.
- `tlsAuthorized` — **клиент проверил сертификат сервера**, а не сервер допустил
  client cert. `actualClientLeafSha256` — local certificate socket, не proof admission.
- `TLS_ALERT` — explicit allowlisted remote TLS error. Это не старый
  `TLS_ALERT_REJECTED` и не доказанное policy enforcement. Hostname/cert errors,
  reset/timeout/transport failure не маскируются под нужный TLS denial.
- `CONNECTION_REFUSED` — только TCP `ECONNREFUSED` для directSidecar. Actual socket
  source/peer/port в этом случае null; целевой адрес/source bind записаны отдельно
  как inputs, не как authenticated peer observation. Listener race/network middlebox
  не позволяет сделать вывод о всей внешней недоступности.
- `TCP_CONNECTED`, `TIMEOUT`, `HTTP_INCOMPLETE`, `HTTP_REJECTED`, identity mismatch и
  generic transport error не преобразуются в безопасный отказ.

Nginx может обрабатывать client-certificate errors после HTTP parsing (495/496),
поэтому HTTP400 без server-log/upstream correlation ничего не доказывает.
[Официальная семантика Nginx](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#error_processing).
Не следует переименовывать эти observations для прохождения старого local reducer.

## Что остаётся для завершения production verifier

1. Наш trusted operator: независимо pinned target/vantage/collector/source identity,
   custody credentials, default-off readback и свежий challenge на стороне оператора.
2. Контролируемое применение approved closure: неизменные master/boot/executable,
   новая worker generation без draining старого поколения, snapshots до/после и lock.
   `nginx -T`/PID-change/reload exit в отдельности недостаточны.
   [Управление Nginx](https://nginx.org/en/docs/control.html).
3. Корреляция actual probes с root-controlled Nginx generation/request/admission logs
   и upstream counters; полная внешняя vantage, shared-host и direct-sidecar proof.
4. После source freeze — actual runtime/guarded proof и честный refresh immutable
   closure, затем отдельные integration/CI/deploy/activation gates.

Эти действия принадлежат PadlHub, не являются анкетой или signoff партнёра.
Native application rehearsal остаётся **DEFERRED_BY_USER / NOT_RUN**; старые failed
receipts и source pins не изменены. Текущий collector не снимает ни один live gate.

## Фактические проверки этого source slice

`node --test scripts/tests/partnerGameMembershipNginxProbes.test.mjs`: **56/56 PASS**,
macOS Node22.13.1, actual owned loopback TLS/TCP sockets и ephemeral certificates.
Scoped ESLint PASS. Первоначальный sandbox `listen EPERM` не являлся source failure;
повтор проводился только с разрешением на localhost listeners.
Полный последовательный Partner suite: **561 tests / 537 PASS / 24 FAIL / 0 skipped**.
Точные24failure names совпали с checkpoint `5b9755f`: Nginx3/binding11/runtime8/packet2,
старые immutable-proof gaps, новых failures0. `npm run lint`: exit0, 0 errors /
387 warnings. Общая сборка не повторялась: ранее подтверждённый preflight blocker
17 missing VITE inputs не изменился; production env не использовался.
Security P2 о missing raw proof headers исправлен и повторно проверен; новых
существенных security/release findings нет. XML structural lint: 0 errors /
0 warnings, local document links20 PASS. PNG export/visual QA не выполнялись:
ранее доказанная недоступность draw.io Electron CLI в sandbox, без повторного запуска.

Тесты покрывают closed input/no IO, key pairs/pins/expiry, peer certificate до HTTP,
полную read-only матрицу, intentionally permissive mTLS fixture, actual raw guard →
actual disabled store, chunking/compression/duplicate/truncated/oversized/framing,
redirect/no DNS, CORS, доступный sidecar, mutable inputs, fresh challenge/no TLS reuse,
задержанный timer с monotonic clock injection, настоящий body stall 5s и socket cleanup.
Сеть fixtures не является Nginx, Linux process application или external vantage.
Production/SSH/Docker/Mongo/Viva/runtime install и настоящий mTLS partner flow NOT_RUN.

## Локальная проверка поколения и корреляция журнала

Source-файлы: `scripts/partner_game_membership_nginx_generation.mjs` и
`scripts/partner_game_membership_nginx_log_window.mjs`; suite
`scripts/tests/partnerGameMembershipNginxGeneration.test.mjs`.
Это строго LOCAL слой поверх предыдущих transport observations, а не переключение
`verifyPartnerProductionIngress()` в разрешающее состояние. Предыдущие raw guard,
controls/source pins, native collector predicate и failed receipts не изменены.

### Интерфейсы

| Функция | Результат / граница |
| --- | --- |
| `buildLocalNginxCorrelationLogPolicy(generationMarker)` | Только строка `map` + `log_format` для `http{}`; marker — literal 64lowerhex. Не устанавливает/configures `access_log`, не выполняет `nginx -t`/reload |
| `openPartnerNginxLogWindow({absolutePath, expectedOwnerUid})` | Держит один read-only fd. `capture()` один раз читает новый суффикс, `finish()` ещё раз проверяет custody и закрывает fd; `close()` безопасен повторно |
| `evaluateLocalNginxGenerationCorrelation(input)` | Чистая проверка exact схемы snapshots/binding/transport/JSONL. Caller может выдумать inputs; поэтому provenance остаётся `UNATTESTED_LOCAL_INPUTS` |
| `createLocalNginxGenerationSession({baseline, expected, logPath})` | Host-side wiring к существующему fixed `/control` + `/proc` nonroot Linux/x64 fixture collector. Сам читает before/after/final snapshot и лог; `finish(transport)` принимает **неаттестованный** результат внешнего collector, а не даёт ему live provenance |

Session не имеет exec/SSH/hook/collector overrides и не выполняет сигналов процессам,
сетевых запросов или изменений файлов. Он читает только указанное приватное окно
журнала и fixed local fixture inputs. Новый источник receipt не является утверждённым
production адаптером. Сеанс/reader одноразовые, закрываются на любой ошибке; окно ≤90s
по monotonic и wall clocks. Reader имеет также unref timer для освобождения fd, если
caller не завершил окно; timer expiration никогда не возвращает evidence.

### Generation binding

`expected` — exact объект `configSha256`, `generationMarker`, `target`,
`serverSpkiSha256`, `clientLeafSha256`, `wrongClientLeafSha256`. `target` содержит
ровно transport address/sourceBindAddress/port/sidecarPort/exactHost/sharedHost.
Чужая target или TLS identity не может получить match. Все hashes lowercase SHA256.

`baseline`, `before`, `after` используют существующий `LOCAL_FIXTURE` snapshot:
config hash, master PID/parent/startTicks/executable/draining, один child worker,
boot hash и PID/network namespace hashes. Требуется:

- before/after совпадают полностью; master/boot/executable/namespaces не менялись
  относительно baseline;
- config hash равен отдельно ожидаемому и отличается от baseline;
- ровно один новый worker: PID отличается, startTicks строго больше baseline;
  parent/executable согласованы с master, draining/mixed workers запрещены;
- literal generation в каждой новой HTTP log row равен expected marker, worker —
  именно observed current worker, а не caller/upstream supplied marker.

Это **согласованность с применением**, не доказательство controlled HUP или факта
прочтения именно этих bytes из памяти. Смена worker сама по себе может быть restart;
общий production Nginx с несколькими workers здесь не поддерживается. Нельзя расширять
допуск до всех workers по одной обслужившей запрос строке.

### Закрытая схема журнала

`log_format partner_correlation escape=json` задаёт в canonical key order только
строковые поля: `admitted`, `clientVerified`, `generation`, `probeId`, `requestId`,
`source`, `status`, `upstream`, `worker`. `probeId` берётся из отдельного
`X-Padlhub-Probe-Id` через map, разрешающий лишь 64lowerhex; `generation` — literal
из reviewed config, `requestId` — `$request_id`, `worker` — `$pid`, `source` —
`$remote_addr`, остальные — существующие Nginx admission/status variables.
Signature, nonce, body, Authorization и произвольные headers в формат не входят.
IP источника делает этот файл приватным evidence; его не следует публиковать в Git
или партнёру. Никакого log format на сервере этим этапом не установлено.

Каждый complete HTTP probe обязан иметь **ровно одну** строку с соответствующим
probe ID, generation, worker, source и status. Порядок строк значения не имеет.
Повторный probe/request ID, чужая строка, пропуск или extra JSON key — отказ.
Проба должна иметь actual TLS/socket identity ожидаемого target, полное ограниченное
тело и отсутствие CORS. Positive default-off и CORS controls требуют HTTP503,
no-store, admitted=1/clientVerified=1/upstream=503. Прочие HTTP отказы допускаются
только с отсутствующим upstream (`""` или `"-"`); no/wrong-cert требуют admitted=0,
no-cert дополнительно clientVerified=0. Несколько upstream statuses/retry запрещены.

Для TLS-alert/direct-TCP refusal HTTP row запрещена. Эти ID перечисляются отдельно
в `withoutHttpLog`: отсутствие записи **не** доказывает denial. Timeout/reset,
несуществующий TLS error и connected sidecar не становятся безопасным отказом.
Даже полная корреляция не доказывает внешний маршрут, issuer/revocation policy,
реальный provider dispatch или upstream observer counter; `$upstream_status` —
данные Nginx, не подтверждение sidecar/Mongo/Viva.

### Custody и граница файлового наблюдения

Reader требует canonical absolute realpath, regular file, nlink=1, exact owner,
mode0600 без special bits, no symlink и ancestors root/expectedOwner без group/world
write. Открывает `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` один раз, без reopen/fallback.
Initial prefix ≤1MiB, suffix ≤64KiB; initial/final EOF должны быть на границе LF.
Перед/после чтения и перед finish сверяются fd/named inode/metadata, prefix hash,
size и ancestors. Замена, unlink, наблюдаемое усечение/перезапись, короткое чтение,
изменение во время чтения или после capture → refusal и закрытие fd.
JSONL: strict UTF8, canonical duplicate-free JSON, ≤11 строк, ≤2048 bytes/строка;
неполные/пустые/повреждённые строки не пропускаются.

Результат reader называется `PREFIX_PRESERVED_SUFFIX_OBSERVED_NOT_APPEND_ONLY_PROOF`.
**Copytruncate с восстановлением точного прежнего префикса на том же inode между
snapshots неотличим от append.** Это явно закреплено отрицательным ограничением
теста, а не замаскировано как защита. Для production нужен independently controlled
sole writer/no-rotation lock либо отдельное OS event evidence. Здесь нет append-only
history proof, fsync durability, ACL/mount/kernel/root attestation или атомарного
снимка process+filesystem. Последовательные финальные перепроверки уменьшают окно
drift, но не устраняют его математически.

### Итог и текущая граница

Основной результат — `LOCAL_NGINX_GENERATION_HTTP_CORRELATED_NOT_LIVE_PROOF`, hashes
snapshot/transport/suffix и количества сопоставленных/допущенных HTTP probes;
deploy/activation/productionVerified всегда false. Host session даёт только
`LOCAL_HOST_READS_TRANSPORT_UNATTESTED`; `controlledApplication` и `externalVantage`
остаются NOT_PROVEN. Нельзя менять enum на PASS или подписывать caller JSON вместо
реального controlled operator, baseline acquisition и trusted external vantage.

Nginx log context определяется местом завершения обработки запроса; buffering или
conditional logging могут дать неполное окно, которое здесь отклоняется. Будущий
dedicated collector требует точного unbuffered unconditional журнала и quiet window,
а также предварительно установленного default-off. Это ещё не production конфиг.
[Официальный log module](https://nginx.org/en/docs/http/ngx_http_log_module.html),
[поколения и reload](https://nginx.org/en/docs/control.html).

Native application rehearsal остаётся DEFERRED_BY_USER/NOT_RUN. Следующий результат
до релиза — согласованный trusted operator, который сам связывает конфигурацию,
процесс, actual external transport и sidecar readback под контролируемым применением.
Это наша инфраструктурная ответственность, не анкета или approval партнёра.

### Фактически выполненные проверки этого продолжения

- Generation/log suite89/89 PASS: snapshot generation, exact probe/log matching,
  wrong/replayed IDs, mixed/draining/reused workers, malformed JSONL, held-fd
  replacement/prefix/tail/finalization/timeouts и synthetic `/proc` entrypoint wiring.
- Полный последовательный Partner suite650tests:626PASS/24FAIL/0skipped. Exact24
  failure names совпали с предыдущим checkpoint45d15a7 (Nginx3/binding11/runtime8/
  packet2); новых0. Полный release gate RED, старые proof receipts не обновлялись.
- Scoped ESLint PASS; root lint actual exit0,0errors/387warnings. Drawio structural
  validation0errors/0warnings, local document links22PASS.
- Build не повторён: прежний неизменный preflight17missingVITE. Native Nginx/Linux
  application DEFERRED_BY_USER/NOT_RUN; нет Docker/SSH/modular/live/provider checks.
  Drawio PNG/visual QA NOT_RUN: ранее подтверждённый Electron sandbox blocker.
- Независимые read-only security/release reviews: новых P0–P2 нет. Это source review,
  не выполненная установка log fragment, Nginx flush или production аттестация.
