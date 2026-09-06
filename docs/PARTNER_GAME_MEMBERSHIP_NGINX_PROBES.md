# Nginx verifier: сборщик транспортных наблюдений

Статус 6 сентября 2026: **исполняемый collector source готов; production verifier
ещё не завершён**. Это продолжение той же Partner-ветки после `5b9755f`, без
изменения live ingress. [Общий production entry](PARTNER_GAME_MEMBERSHIP_INGRESS_VERIFIER.md)
по-прежнему отказывает с `UNSUPPORTED_INGRESS_ADAPTER`: нет доверенного production
сборщика поколения/config и корреляции с журналом Nginx. Подписывание произвольного
JSON не заменяет эти наблюдения. Никаких новых согласований с партнёром не требуется.

Исходник: `scripts/partner_game_membership_nginx_probes.mjs`.
Тест: `scripts/tests/partnerGameMembershipNginxProbes.test.mjs`.
[Редактируемая инфографика](assets/partner-game-membership-ingress-evidence.drawio),
страница `Bounded transport collector`.

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
реальные game/operation identifiers. Для `/flows` correlation с журналом пока не
реализована; сам probe ID в результате не доказывает server-side обработку.

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
