# План тестирования Partner Game Membership API

## Уровни доказательств

Локальное продолжение после `45d15a7`: [generation/log correlation](PARTNER_GAME_MEMBERSHIP_NGINX_PROBES.md#локальная-проверка-поколения-и-корреляция-журнала).
Новое: private held-fd reader, snapshot/ID/generation/admission correlation,
host-session wiring к fixed Linux collector; production entry не открыт.
Синтетические `/proc` metadata tests не доказывают native Linux/Nginx application.
Целевые89/89 PASS; финальный полный последовательный Partner run: **650 tests /
626 PASS / 24 FAIL / 0 skipped**. Exact24failure names совпали с предыдущим
`45d15a7` checkpoint; новых0. Scoped ESLint PASS; root lint фактически exit0,
0errors/387warnings. XML structural lint0errors/0warnings; local docs links22PASS.
Build/native/production/PNG visual QA NOT_RUN; release gate остаётся RED.

Предыдущее source-дополнение после `5b9755f`:
[bounded TLS/TCP collector](PARTNER_GAME_MEMBERSHIP_NGINX_PROBES.md).
Целевые56/56 PASS и scoped ESLint PASS. Actual loopback TLS sockets, в том числе
raw guard → disabled store, не являются Nginx application/external vantage proof.
Сборщик возвращает observations, не verdict; production entry остаётся закрытым.
Native rehearsal и прежние immutable-proof blockers не изменены.
Его полный final Partner run: **561 tests / 537 PASS / 24 FAIL / 0 skipped**;
24failure names точно совпали с предыдущим checkpoint, новых0. Полный lint exit0,
0 errors / 387 warnings. Full release gate остаётся RED; old receipts не пересчитаны.

Следующее source-дополнение после `eb607aa`:
[BOUND_DEFAULT_OFF startup](PARTNER_GAME_MEMBERSHIP_GUARDED_RELEASE.md#привязанный-запуск-без-активации).
Это root-anchor/source consistency tests и controlled entrypoint wiring; реальные
root permissions, installed Node-RED CLI/systemd и production не проверялись.
Runtime/guarded receipts остаются историческими и требуют фактического refresh.
Финальный прогон: **505 tests / 481 PASS / 24 FAIL / 0 skipped**; все96новых
bound startup tests прошли. Те же24 release-fixture failures, что до изменения:
Nginx3/binding11/runtime8/packet2. Scoped и полный ESLint — exit0; полный сохраняет
387 warnings. XML lint — 0 errors / 0 warnings. Это не зелёный release gate.

Предыдущее source-изменение 6 сентября:
[standalone Viva token](PARTNER_GAME_MEMBERSHIP_VIVA_TOKEN.md).
Целевые API/provider **80/80 PASS**, полный Partner-набор **385 PASS / 24 FAIL / 0 skipped**
(409 tests). Все 24 отказа относятся к прежним exact-source release fixtures:
Nginx preflight — 3, production binding — 11, runtime — 8, packet — 2.
Пины/квитанции не переписаны; полный gate **RED**, не release-ready.
Новый код требует фактического runtime/guarded refresh после завершения source diff.
Scoped ESLint и XML lint схемы — PASS. Security review выявил и подтвердил
исправление двух P2: compression framing и monotonic deadline при задержке таймера.

Текущее решение 2026-09-06: native Nginx application rehearsal / Docker install
`DEFERRED_BY_USER`; native application **NOT_RUN**, прежние failures сохранены.
Офлайн-проверка [partner kit](partner-game-membership-kit/README.md) независима:
пять frozen POST/retry/DELETE/GET/Unicode vectors, отдельный reference signer,
server/client byte compatibility, отрицательные fixtures/CLI и переносимость без
репозитория. Она не доказывает live replay, mTLS, Viva/Mongo или production ingress.
Production activation gates и строгая проверка process identity не меняются.
Исторические проверки kit до изменения token source: API suite **45/45**, полный Partner suite
**384/384**, skipped0; scoped ESLint PASS. Standalone self-test: five vectors PASS
на Node22.13.1; copied-outside-repository CLI и закрытые ошибки входят в45tests.
Это source/offline evidence, не CI или live-проверка. Frontend/modular build,
physical Nginx/Mongo/Viva и полный repository lint/build в этом этапе не запускались.

Preparation после `a150756`: [native target admission](PARTNER_GAME_MEMBERSHIP_NGINX_APPLICATION.md#подготовка-native-linuxamd64-после-a150756).
Target/owner не назначены; native preflight/runtime **NOT_RUN**. Локально
проверены10transport source hashes/import closure/syntax, прежние9receipt hashes
совпали; новых unit/runtime прогонов нет, production code не меняется.

| Native admission negative | Требуемый результат будущей проверки, не текущий PASS |
| --- | --- |
| Нет владельца/target, только ARM daemon + amd64 image | TARGET_UNASSIGNED / non-native STOP; не использовать shared LK |
| Удалённый daemon и локальные Mac bind paths | STOP до исполнения runner; operator и mounts должны быть на daemon host |
| Missing image/tool/source dependency, hash drift | STOP; не pull/install/change pin и не перенос всего checkout |
| Root UID или нужно расширить capabilities/ACL | STOP без автоматического изменения прав |
| Native uname, но original argv/padding/wrong exe/partial read | Strict отказ/UNKNOWN сохраняется; metadata не подменяет actual process identity |
| Diagnostic strict ACCEPTED | NOT_REPRODUCED, не application PASS; третий peer/HUP/matrix требуют следующего допуска |
| Failed/incomplete capture или cleanup | Сохранить sanitized failure/recovery; не повторять и не удалять чужие ресурсы |

Последний этап после `3314cd8`: [отдельная identity diagnostic](PARTNER_GAME_MEMBERSHIP_NGINX_APPLICATION.md#отдельная-диагностика-после-3314cd8-причина-установлена).
Targeted **108/108**, полный Partner **378/378 PASS**, skipped0; scoped ESLint PASS.
Один admitted physical diagnostic: `DIAGNOSTIC_COMPLETE_NOT_APPLICATION_PASS` /
`KNOWN_COMMAND_FORM_REJECTED` у master. Одинаковый 54-byte original argv у обоих
процессов и hash exe-link Rosetta подтверждены стабильными before/after snapshots.
Strict collector по-прежнему отвергает; observer/access rows0, HUP/matrix12 NOT_RUN.
9source/3copy/5publiccert/config closure и own2containers/network/key cleanup
сверены; оба прежних FAILED receipts сохранены. Native Linux/amd64 не проверен.

| Diagnostic regression | Обязательная граница |
| --- | --- |
| Фактически наблюдавшиеся 54 bytes / hash / 5 NUL у обоих процессов | Ни master, ни worker/draining identity не принимаются по original argv |
| Exact known titles, space/NUL padding | Форма классифицируется, strict policy не ослабляется |
| Unknown suffix/interior NUL/invalid UTF8/Unicode/control/oversize | Нет raw strings/секретов в результате; bounded reject/redaction |
| PID/start/config/namespace drift, wrong parent/executable | Независимый отказ даже при похожей команде |
| Exe EACCES / namespace ENOENT / неизвестная ошибка | INCOMPLETE + fixed stage/role/code, strict collector всё равно вызван; нет partial identity PASS |
| Exclusive CLI / failed capture | Нет третьего peer, HTTP probes, HUP или application fallthrough; `finally` cleanup сохраняется |
| Actual strict acceptance / другая ошибка | NOT_REPRODUCED / CAUSE_UNRESOLVED; нельзя выдать за reproduced или production PASS |

Предыдущий этап после `b1839dd`: [controlled application](PARTNER_GAME_MEMBERSHIP_NGINX_APPLICATION.md).
Targeted suite **94/94**, полный Partner **364/364 PASS**, skipped0.
Первый physical run FAILED до containers/probes; второй после IPAM correction
создал3containers, но остановился на initial Linux process identity:
`NGINX_PROCESS_COMMAND_MISMATCH` / `NGINX_WORKER_TRANSITION_UNPROVEN`.
Matrix12 и HUP NOT_RUN, runtime PASS нет. Owned cleanup/independent absence PASS.
Проверяются disk-only/no-HUP, worker respawn со старой меткой, PID/boot/config drift,
replay/expiry/order, отдельная vantage, binding revocation и запрет local→production.

Отдельный gate после `c828762`: [независимые source-IP limits](PARTNER_GAME_MEMBERSHIP_SOURCE_LIMITS.md).
Opt-in fixture с тремя TLS identities проверяет source rate/concurrency при
непревышенных client budgets; actual socket, cold-state, противоположный spoof,
differential другого IP и recovery обязательны. Actual run `13:34:20.347Z`:
**77/77 PASS**; source rate 22 приёма / 8 отказов за 328.97 мс, concurrency 8
обработчиков (3+3+2) / 2 отказа. Другой фактический IP и recovery проходят.
Полный Partner suite **325/325**, skipped 0; scoped ESLint: 0 errors / 0 warnings.
Боевые лимиты/ACL/сертификаты и sidecar closure этот gate не меняет.

Дополнение 6 сентября: [Nginx candidate и runtime audit](PARTNER_GAME_MEMBERSHIP_NGINX_CANDIDATE.md).
Новый suite проверяет закрытый generator, X.509/SPKI/SAN/time, case-sensitive leaf,
полноту HTTP framing (включая negative truncation), cleanup при pre-Docker failure.
Runtime suite отклоняет resealed non-Linux/image/command/time/isolation evidence.
Физический Nginx runner исполняется отдельно; OPEN/NOT_TESTED перечислены в receipt,
не превращаются в PASS общего ingress и не запускают Mongo/Viva бизнес-сценарии.
Последующий wildcard source fix проверяется отдельно: validate-before-scrub,
все три header views, сохранение proof/body/path, durable audit failure/recovery.
Новая physical репетиция на source `889ebe3`: Nginx **49/49**, guarded CLI **20/20**;
actual receipts связаны с новыми guard/audit bytes и обновлённой closure.
Старые physical receipts/disabled packet сохранены. Полный Partner suite после
обновления — **303/303**, без skipped. Семь Nginx `NOT_TESTED` и production gates
оставались открытыми на `b9a8a37`; standalone generator не обеспечивает wildcard scrub без guard.

### Дополнительная physical boundary matrix

На предыдущем checkpoint existing Nginx fixture расширен без изменения generator, guard или service.
Actual run `10:37:25Z`: **57 PASS, затем aggregate header FAIL**. Client concurrency,
idle timeout и absolute deadline **NOT_RUN**. Planned matrix ниже — не список
уже пройденных проверок; результат с 63 rows не получен.

| Область | Метод проверки | Что не считается PASS |
| --- | --- | --- |
| TLS 1.0/1.1 | Exact legacy version у отдельного synthetic клиента; explicit server protocol-version alert; upstream 0 | Local cipher/protocol failure, reset, произвольный TLS alert |
| Absent SNI | `servername` отсутствует, default server отвергает handshake; upstream 0 | Только неправильный hostname при переданном SNI |
| CIDR | Socket source `127.0.0.2` с валидным cert и поддельным allowed XFF; 403/upstream 0 | IP из forwarding header вместо socket peer |
| Request/header bounds | Wire line и field 2048/2049 bytes, aggregate headers >16 KiB | Один status без upstream count или неполный HTTP response |
| Concurrency | Четыре реально active upstream handlers; пятый 429; access log `concurrency=REJECTED`; затем recovery | 429 от rate limiter, четыре только TCP/TLS sockets |
| Idle/no retry | Observer молчит20s; Nginx возвращает504 примерно через15s; один upstream call; закрытие handler | Мгновенный504 или скрытый второй вызов; не доказывает все возможные retry failures |
| Absolute deadline | Ответ начинается сразу и завершается после18s порциями каждые2s | Поздний полный503 — **KNOWN_BLOCKER_CONFIRMED**, не PASS ограничения15s |

Pure evidence assertions тестируются отдельно: неверный status/count/alert, null
timestamp, rate/concurrency substitution, missing/duplicate row и relabel blocker
отклоняются. Общий physical result требует все named rows, а вывод collector явно
различает завершённую проверку и подтверждённый дефект контроля.
Фактический итог и receipt — в [Nginx runbook](PARTNER_GAME_MEMBERSHIP_NGINX_CANDIDATE.md).

### Aggregate correction после c38bc73

`2k initial +7×2k large` — консервативный общий бюджет с request line и потерями
упаковки, не exact header-only admission. Unit проверяет сумму буферов, единственное
объявление каждого лимита, выключенные HTTP/2/keepalive, сохранённые proof fields и
точный wire size test-builder. Evidence negatives запрещают принять parser431 при
нулевых request counters: нужен actual Nginx400 и существующее `upstream=""`.

| Дополнительный wire input | Фактический локальный результат11:08:36UTC |
| --- | --- |
| Packed whole head16384, POST + body16384 | Observer503, один upstream/dispatch |
| Packed whole head16384, DELETE/GET с max IDs | Observer503 для обоих методов |
| Packed whole head16385 | Nginx400, без upstream |
| Header section16385, каждый field≤2048 | Nginx400, без upstream |
| Тот же whole head16384, padding fields в обратном порядке | Консервативный ранний Nginx400; не обещать приём любого sub16KiB header section |
| Исходные17562-byte headers | Nginx400, без upstream, не downstream parser431 |

Проверки line/field2048/2049, body16384/16385, duplicate evidence, forwarding,
post-rejection recovery и remaining concurrency/timeouts сохранены. Полная planned
matrix69rows требует68PASS +1explicit deadline diagnostic, только если выполнена
физически; остановка раньше оставляет остальные NOT_RUN. Fixed timeout150s согласован
до запуска. Source suite на final bytes311/311 PASS, skipped0; это не physical proof.

Actual run `2026-09-06T11:08:36.588Z` выполнил все69rows: **68PASS +1
KNOWN_BLOCKER_CONFIRMED**. Header tests выше, client concurrency/recovery и idle
timeout15040ms прошли. Полный drip ответ18048ms при первом байте28ms доказал отсутствие
общего15s deadline. `notTested=[]` относится только к этой named matrix; production/
independent source limits/external/direct-sidecar/revocation остаются OPEN. Receipt
`0cb10064…`, probes`afd1019a…`; cleanup двух exact owned containers и keys/CSR подтверждён.

| Уровень | Что доказывает | Что не доказывает |
| --- | --- | --- |
| Pure unit | Канонизация, HMAC, timestamp, schema, route parsing | Mongo atomicity, Node-RED, Viva |
| Service + in-memory repository | State machine, ownership, idempotency, synthetic provider | Реальная replica transaction и provider contract |
| Flow/packet fixture | Отдельный sidecar, routes, default-off config, exact source/candidate/added-node/package hashes | Что ingress/service binding совпадает с production в момент deploy |
| Mongo replica integration | unique/TTL/index options, write conflict, transaction/outbox | Viva и ingress |
| Local Node-RED + loopback Mongo | HTTP headers, params, response, restart | Shared/prod topology |
| Viva sandbox | Реальный add/read/remove технического клиента | Production payment/notification effects |
| Limited pilot | Ingress/mTLS/rate limit/observability/reconciliation | Масштабная нагрузка |

Ни один уровень не подменяет следующий. Локальные green tests не разрешают import,
secret change, migration, deploy, activation или real provider mutation.

## Автоматизированная матрица v0.2

| Категория | Сценарий | Ожидание |
| --- | --- | --- |
| Happy path | Подписанный POST в открытую игру | `201`, membership `ACTIVE`, payment `PAID/EXTERNAL_PARTNER` |
| Replay | Тот же request второй раз | `409 REQUEST_REPLAY_DETECTED`, Viva calls остаются 1 |
| Tamper | Изменить method/path/body после подписи | `401 INVALID_SIGNATURE`, Viva calls 0 |
| Freshness | Timestamp за пределами 90 секунд | `401 REQUEST_EXPIRED`, nonce не расходуется |
| Retry | Новый nonce/signature, тот же idempotency/body | Сохранённый response, Viva calls остаются 1 |
| Concurrent retry | Два запроса одновременно с одним idempotency | Только создатель operation вызывает Viva; дубль получает `202` |
| Conflict | Тот же idempotency, другой body | `409 IDEMPOTENCY_CONFLICT` |
| Payment claim | Один payment reference для двух игроков | `409 PAYMENT_REFERENCE_ALREADY_CLAIMED`, Viva calls остаются 1 |
| ACL | Нет scope add/remove/read | `403 SCOPE_DENIED` |
| Tenant | Игра другой station | `403 STATION_ACCESS_DENIED` |
| Tenant revoke | Station удалена из allowlist после POST, затем DELETE | `403 STATION_ACCESS_DENIED`, Viva calls 0, membership остаётся `ACTIVE` |
| Open-game state | Игра archived/ended/private либо visibility fields конфликтуют | `409 GAME_NOT_OPEN`, Viva calls 0 |
| Open-game lifecycle | Нет status или канонического `booking.endTs/startTs` | `409 GAME_NOT_OPEN/GAME_SCHEDULE_UNKNOWN`, Viva calls 0 |
| Compatibility | Реальная форма `PAID`/`PAYMENT_PENDING`, public, future end | POST остаётся разрешённым |
| Ownership | DELETE чужого/LK/Viva membership | `403 MEMBERSHIP_NOT_OWNED`, Viva calls 0 |
| Persisted Viva binding | После POST runtime technical client изменён, затем DELETE | Cancel/read-back получают сохранённый client ID; новый runtime ID не используется |
| Failed DELETE isolation | Pre-authorization failure с существующим чужим membershipId | Меняется только operation/audit; membership и roster не меняются |
| Provider ambiguity | Timeout/неверный read-back | `202 UNKNOWN`, автоматического повтора нет |
| Lost ACK/local commit | Provider мог изменить state либо Mongo commit не подтверждён | `202 UNKNOWN`, reservation сохраняется |
| Schema | Caller передаёт `paid/source/vivaBookingId/clientId` | `400 UNKNOWN_REQUEST_FIELD` |
| Privacy | Audit после request | Нет raw nonce/IP/body/name/payment ref |
| Runtime readiness | Любой Viva gate/token отсутствует | `503` до operation/membership/provider call + durable rejected audit |
| Standalone token | Scoped server credentials, pinned password grant | Ленивое получение, form encoding без trim пароля, без чтения global context; 20 параллельных вызовов используют один grant |
| Token lifecycle | Истечение, смена/удаление credentials, shutdown | Монотонный TTL от начала запроса минус 30s, без продления на cache hit; старый cache не используется; pending abort, late body cancel |
| Token transport | Redirect/compression/invalid UTF-8/framing/oversize/timeout | Fixed URL, identity encoding, максимум 64 KiB и 5s на весь ответ; elapsed deadline проверяется независимо от callback таймера; redacted 503 |
| Token failure | Невалидный TTL, 401, исключение credential reader | Нет fallback/retry мутации; 1s cooldown для следующего grant с теми же credentials; секреты отсутствуют в ошибке |
| Bound startup | Correct independent root anchor + exact manifest/files + installed custom-node link | Host связан с anchor, server audience совпадает; storage immutable, API OFF |
| Startup trust | Missing/malformed/unreadable/service-owned anchor или writable ancestors | Фиксированный startup refusal; нет fallback к unbound или открытия audit/runtime settings |
| Startup identity | Самостоятельно resealed packet, late anchor/source replacement или symlink hop | Отказ по independent manifest pin/final identity snapshot/exact installed readlink |
| Viva create contract | Готовый adapter получает add | Один POST, pinned base/path/body, auth/idempotency/correlation headers |
| Viva ambiguity | Network/timeout/5xx/invalid binding | `202 UNKNOWN`, ровно один mutation call, без retry |
| Viva slow/oversized response | Body не завершается либо `Content-Length`/chunked body больше `1 000 000` байт | Общий timeout остаётся активным до конца body; reader отменяется; лишний chunk не запрашивается; mutation становится `202 UNKNOWN` |
| Viva removal | Cancel probe не подтверждает cancellation-only | PUT не вызывается; definite contract mismatch |
| Viva read-back | Duplicate/противоречивые identity, state или collection aliases | `VIVA_READBACK_AMBIGUOUS`, local completion запрещён |
| Synthetic isolation | Не-loopback или production env/DB | Synthetic provider запрещён |
| Flow provenance | Неверный live SHA/in-place/collision | Candidate builder падает |
| Additions-only deploy | Новый pinned HTTP route/package bytes | Contract pins все seven nodes; live prefix/order неизменен; additions только suffix |
| Private packet | Fresh external workspace + exact repository identity | read-once validated runtime bytes, source/candidate contract, semantic cross-links, sibling temp + fsync + final manifest + atomic rename; injected failure не оставляет partial packet |
| Production controls | Route/upstream/CORS/admin/limits/custody/runtime/activation mutation | Любое widening или binding в source template отклоняется |
| Runtime compatibility | Node `22.23.2` + minimal Node-RED `5.0.6` sidecar + exact custom package | exact custom-node load/default-off/removal: `503/404`; не доказывает deploy-stage service binding; production calls `0` |
| Runtime audit | Exact minimal sidecar closure | `0 critical / 0 high / 7 moderate / 0 low`; `SECURITY_AUDIT_PASS`; bounded shared-palette observation `5/12/23/0` используется только как stop-input, не immutable deploy evidence |
| Private binding declaration | controls/runtime/functional/ingress/custody/packet semantics/identity mutation | packet/host custody проверяется фактически; ingress/readback/audit decision остаются `DECLARED_EVIDENCE_UNVERIFIED`, authorization всегда false |
| Mongo rehearsal guard | Non-loopback/shared name/mixed-case direct connection/duplicate topology option/bad ack | Отказ до Mongo import/connect |

Команда:

```bash
npm run test:partner-game-membership-api
```

## Обязательные дополнительные тесты до shared sandbox

1. Mongo replica set:
   - два конкурентных add на последнее место;
   - duplicate nonce под нагрузкой;
   - duplicate idempotency с одинаковым и разным request hash;
   - transaction transient retry без duplicate audit/outbox;
   - commit result unknown и majority read-back;
   - ослабленные `unique/sparse/TTL` indexes отклоняются.
   - выполнить `mongo:partner-game-membership:rehearse` только для exact
     `lk_partner_rehearsal_*`; сохранить replica/index/abort/no-sentinel evidence.
2. Local Node-RED:
   - route params и exact path за reverse proxy;
   - body size/content-type limits;
   - restart между provider ACK и local commit;
   - audit DB outage до provider call;
   - enabled/key/scopes/station revoke без restart либо с документированным reload.
3. Viva sandbox после технической подготовки PadlHub, без анкеты партнёра:
   - technical user add + exact booking read-back;
   - повтор provider create с одним operation ID;
   - delete exact booking, already absent, exercise closed;
   - timeout до/после provider commit;
   - подтверждение отсутствия чеков, debt, notifications, subscription debit и rating.
   - provider-side duplicate request с одинаковым `Idempotency-Key` возвращает тот же
     booking identity либо документированный безопасный эквивалент без второго booking.
4. Ingress:
   - обязательный mTLS + дополнительный allowlist positive and negative;
   - wrong audience/Host/SNI, shared hostname и direct Node-RED дают отказ;
   - входные `Forwarded`/`X-Forwarded-*` стираются; source строится из socket peer;
   - rate limit по client/IP;
   - header/body size, malformed encoding, duplicate headers;
   - trusted proxy и source IP hashing;
   - TLS policy scan.
   - только три exact method/path, без Node-RED editor/admin и OPTIONS;
   - upstream CORS скрыт; browser CORS preflight не открывает M2M API;
   - proxy retry равен нулю, raw path и canonical JSON semantics доходят до HMAC без
     rewrite; duplicate JSON keys отклоняются ingress до Node-RED parser.

## Exit criteria ограниченного пилота

### Response deadline: отдельный локальный gate после `32c0ad6`

Контракт и recovery: [15s response watchdog](PARTNER_GAME_MEMBERSHIP_RESPONSE_DEADLINE.md).
Не путать body read timeout, Nginx idle timeout и время бизнес-операции.

| Проверка | Требуемое доказательство |
| --- | --- |
| Finish / early response close / raw rejection | Таймер/listeners сняты; нет позднего deadline audit |
| Req.close после body и drip ответа | Watchdog остаётся активным после `next()`; bytes не продлевают deadline |
| Ранний timer callback / blocking sync audit | Повторная monotonic проверка; никакого раннего cutoff или нового dispatch после budget |
| Ошибка deadline audit / reopen | Transport закрыт несмотря на false/throw/Promise; valid deadline не отравляет durable sink |
| Подписанный retry после disconnect | Exact replay409; new proof + same key202/200; один add/payment/participant; no cancel |
| Physical Nginx drip | Неполный503, 8 writes, около15s, один trusted watchdog event с тем же requestId, recovery |
| Physical direct sidecar + late actual HTTPOut | Закрытие до headers; synthetic operation ещё pending; поздний result через actual Node-RED без catch/error/повторной операции |
| Guarded CLI closure | Свежий20-row proof на изменённых guard/audit bytes; старый receipt не переименовывается в свежий |

Неполный ответ допускается только в двух explicit deadline probes и не называется
валидным API response. Client timeout/reset без trusted witness — FAIL. Новый
combined silence probe допускает502/504, не выдавая timer race за Nginx-only proof.
Физический результат и статус упаковки публикуются только в evidence-разделе
deadline документа после завершения соответствующего run.

### Остальные условия пилота

Локальный ingress evidence core имеет отдельную
[матрицу проверок и ограничений](PARTNER_GAME_MEMBERSHIP_INGRESS_VERIFIER.md).
Его unit/filesystem tests не закрывают перечисленные ниже live ingress, Mongo или
Viva gates; physical TLS/mTLS probes и production adapter ещё не реализованы.

- нет требования подписанной анкеты/ответов партнёра: контракт фиксирован;
  серверные security, ownership, replay и provider проверки выполняет PadlHub;
- fresh `LK Games` snapshot и SHA зафиксированы только для collision/readback; packet
  содержит отдельный deterministic sidecar source;
- custom node package и candidate hashes воспроизводимы;
- exact sidecar candidate и stop/route-removal rollback отрепетированы изолированно;
  shared production flow на `1880` не меняется; packet получен только из clean pushed SHA;
- exact runtime audit не содержит unresolved partner-reachable critical/high advisory;
- production-controls SHA совпадает в packet/plan, private ingress/custody overlays
  заполнены владельцами и проверены на target host против root-owned realpath,
  hostname, machine identity и exact packet bytes/semantics;
- отдельный live verifier прочитал ingress config/readback/certificate/CA и подписанный
  audit reachability artifact, повторил negative probes и снял декларативный
  `UNVERIFIED` status без ослабления `SECURITY_AUDIT_PASS` sidecar boundary;
- Mongo replica tests green, backup/rollback/reconciliation rehearsed;
- Viva sandbox matrix green с exact before/after evidence;
- mTLS включён; test/production client ID, HMAC key, certificate и audience различны;
- exclusive exact-host ingress закрывает shared-host и direct Node-RED обход;
- dashboards/alerts видят replay, auth failures, provider errors и `UNKNOWN` age;
- kill switch, client revoke и key rotation отрепетированы;
- ни одного production user/payment/booking в тестовых доказательствах.
