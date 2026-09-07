# План тестирования Partner Game Membership API

## Уровни доказательств

### 7 сентября, после `888fe90`: local worker declaration compatibility

Разрешён только локальный source этап в прежней ветке/worktree. Новый профиль
принимает одну main-декларацию `4`/`auto`; topology/runtime, defaults, TLS/header
predicates, result schema и production entry не изменены.

| Проверка | Ожидаемая граница |
| --- | --- |
| `auto` или прежний `4` | Local preparation, flags false, native/loaded proof отсутствует |
| Missing/comment-only, duplicate/mixed, другие числа/аргументы/block | Fail closed |
| Один main include; root + include; повторный include | Один допускается, дубликаты считаются по include instances и отклоняются |
| Map data / quoted text / comments; реальный non-main statement | Data не считается декларацией; настоящий statement вне main отклоняется |
| Baseline `auto → 4` и `4 → auto` | `NGINX_SHARED_EXISTING_FILE_CHANGED`, без переписывания baseline |
| Три/пять workers отдельно в baseline/before/after при `auto` | `NGINX_SHARED_GENERATION_SNAPSHOT_INVALID` |
| Четыре workers, но partial response-ID/log coverage | `LOCAL_SHARED_WORKER_COVERAGE_NOT_PROVEN` |
| Четыре correlated workers на synthetic inputs | Только local correlation, не production/application proof |
| 11 прежних unsafe-profile сценариев под `4` и `auto` | Отказ на defaults, early headers, TLS downgrade, modules, listener options и context confusion сохранён |

До исправления два focused regressions actual exit 1: `auto` отвергнут, missing
declaration ошибочно принят. После исправления targeted adapter **113/113 PASS**,
actual exit 0, 1.148 s; добавлено 23 test cases и расширены прежние 11 сценариев.
В промежуточном прогоне два новых assertions ожидали неверное имя preservation
ошибки; исправлены на существующий `EXISTING_FILE_CHANGED`, production-код не ослаблен.
Scoped ESLint сначала обнаружил unused fixture binding после его локализации;
лишняя переменная удалена, последующий scoped ESLint PASS.

Полный последовательный Partner suite на финальном source:
`node --test --test-concurrency=1 scripts/tests/partnerGameMembership*.test.mjs`.
Первый sandbox run: 904 tests / 854 PASS / 50 FAIL, exit 1; дополнительные 26 failures
имели `listen EPERM` на собственных loopback fixtures. После разрешения fixture
sockets второй run: **904 tests / 880 PASS / 24 FAIL / 0 skipped**, exit 1, 33.804 s.
Все 24 failing names точно совпали с предыдущим 881-test baseline; новых нет,
23 добавленных tests PASS. Release gate остаётся **RED**; это не зелёный full suite.
Security/compatibility review source и regressions: P0–P2 = 0, reviewer read-only.
Root `npm run lint`: actual exit 0, **0 errors / 387 warnings**. Build не запускался;
исторический build-input gap этим изменением не закрыт. Локальные тесты используют
собственные fixture sockets, а не production или native Nginx.

Свежий actual-host/full-profile/native результат **NOT_RUN**: redacted metadata
прошлого чтения не являются исходными config bytes. Historical helper и pins не
пересобраны, фактический следующий source rejection на сервере не известен.
XML-only fallback drawio-skill; PNG/visual QA не повторяются после известного сбоя.

### 7 сентября: actual read завершён, закрытый профиль несовместим

После `9901488` пользователь подтвердил продолжение и coordinator предоставил новое
одноразовое read-only окно. Fresh local guards: прежняя clean branch/HEAD, четыре
repo inputs byte-equal source `1c0a82d`, reviewed helper SHA совпал. Новых source
изменений не было: прежние helper tests/review не повторялись без изменённых inputs.

Actual SSH exit **0**, 08:28:02.408–08:28:02.618 UTC, stderr 0 bytes. Все **12 file pins**,
fd/path before-after и финальный host/master/four-worker epoch совпали; **1,235 lexical
statements**, skipped 0. Checker вернул **CLOSED_PROFILE_REJECTED**, первый код
`NGINX_SHARED_DIALECT_MAIN_UNSUPPORTED`; root `worker_processes=AUTO`, тогда как source
разрешает только `4`. Чтение PASS не является compatibility PASS или native validation.

Дополнительные file-local observations: ноль exact explicit IPv4/IPv6 TLS default
declarations, root-http TLS-list отличается и пять header directives отсутствуют в
этом контексте. Это не проверка effective/include/default inheritance и не полный
перечень ошибок; checker остановился на первом rejection. Safety gates не ослаблены.

Нет новых network probes/native/-t/-T/reload, key/cert/env/log reads, server/provider/
shared-data writes, merge/push/deploy/activation. После actual exit окно освобождено.
Full Partner/lint/build не перезапускались для docs-only diff; предыдущий release RED
не изменён. Drawio-skill: existing XML дополнен страницей разделения read/profile/native
evidence, PNG/visual QA NOT_RUN после известного Electron/sandbox blocker.

### 7 сентября: read-only compatibility gate подготовлен, SSH NOT_RUN

Продолжение после `1c0a82d`: private one-shot diagnostic использует неизменённые
source lexer/checker и прежний guarded reader; repo runtime не менялся. Syntax и
локальные synthetic assertions: **16 profile/projection + 43 closure scope/pins/
redaction + 13 scanner/path + 7 fd/ancestor/race — PASS**, actual exit 0.
Из 43 closure checks двенадцать новых проверяют отказ при drift каждого из шести
дополнительных файлов и сохранение их redacted aliases. Все 12 прежних content pins
сохранены; реальные keys/cert/env/logs не читаются. Fixed metadata не заменяют
native/effective-default semantics и не содержат raw config или error values.

Coordinator отозвал `147` read window до старта SSH для отдельно разрешённого
backend deploy. **Actual host compatibility NOT_RUN**, remote processes/writes 0;
ничего не прерывалось. Ни profile PASS, ни mismatch на действующем сервере не доказаны.
Полный Partner/lint/build не повторялись на неизменённых runtime inputs: предыдущие
881/857 PASS/24 FAIL и lint 0 errors/387 warnings остаются историческими результатами.
Native rehearsal DEFERRED_BY_USER / NOT_RUN; production entry и receipts не менялись.
Существующая инфографика по-прежнему корректно показывает границу NOT_PROVEN;
новой схемы или попытки PNG export этот остановленный read-only шаг не требует.

### 7 сентября: локальная shared-adapter связка

[Shared adapter contract](PARTNER_GAME_MEMBERSHIP_NGINX_SHARED_ADAPTER.md) продолжает
`3b89c38` в прежней ветке/worktree. Local preparation, отдельный shared transport
и four-worker evaluator реализованы; production entry и старые receipts не менялись.

| Область | Проверяемые отказы и границы |
| --- | --- |
| Preservation / input | Один private snapshot, Buffer-method/getter/symbol rejection, clone не становится trusted preparation |
| Shared inheritance | Unknown/опасные http handlers, include-instance context, реальные объявления map/set/captures против обычных references |
| Global variable namespace | Case-insensitive map/set, три PCRE capture формы; bare apostrophe в location/map проверяется по raw и decoded token |
| Default listeners | Оба explicit unchanged defaults, точные early TLS/header settings; implicit/address-specific/HTTP2/proxy-protocol/conflict reject |
| Shared transport | 27 фиксированных attempts, actual response ID, duplicate/malformed response header reject, configured client ID, invalid HMAC, GET/OPTIONS only |
| Generation / log | Четыре новых workers, epoch/startTicks/PPID/executable, separate closure hashes, server-ID join, TLS/leaf/no-store/limiters, no stale/extra/retry rows |
| Coverage / negatives | Missing worker → NOT_PROVEN; чужой vhost/TLS без ID и log → uncorrelated, не server-denial PASS |
| Host session | Fixed nonroot Linux reader, real held FD на synthetic fixture files, final snapshot, outer deadline до/после log finish, repeat finish rejected |

Physical targeted collector run: **2/2 PASS**, actual exit 0, 16.791 s; это реальные
loopback TLS sockets, не Nginx. После исправления fixture path два host-session tests
прошли отдельно; enhanced deadline regression также PASS. Bare-apostrophe regressions
**2/2 PASS**. Фактический итог общего набора приведён ниже.

Первый full run: 881 tests / 856 PASS / 25 FAIL, actual exit 1. Дополнительное падение
старого interface assertion выявило новое поле в `row.words`; сохранена прежняя
форма words, raw spelling перенесён в отдельный `rawWords`, assertion не ослаблен.
Affected interface + два bare-capture regressions: **3/3 PASS**, scoped rereview PASS.

Финальный `node --test --test-concurrency=1 scripts/tests/partnerGameMembership*.test.mjs`:
**881 tests / 857 PASS / 24 FAIL / 0 skipped**, actual exit 1, 34.022 s. Все **92 новых
теста прошли**; exact 24 failing names совпали с baseline `3b89c38`, новых/исчезнувших
0. Runtime/packet proof pins не resealed, полный release gate **RED**.
Root `npm run lint`: actual exit 0, **0 errors / 387 warnings**. Согласованный слот
освобождён после обоих actual exits. Scoped ESLint PASS; XML validator 0 errors /
0 warnings; local doc links/anchors 67 PASS. Root build не повторён: input gap
предыдущего checkpoint не закрывался этим этапом.

Read-only security review закрыл snapshot reread и global-variable shadowing,
включая bare apostrophe capture. Reliability review закрыл late final-snapshot
deadline. Финальные scoped source verdicts: P0–P2 = 0, не native attestation.

Native four-worker Nginx/application/external vantage и production key/module/closure
custody **NOT_RUN / NOT_PROVEN**. Rehearsal остаётся **DEFERRED_BY_USER**, не снята
этим этапом. Нет SSH/реальных cert-key-env-log reads/deploy/activation. Drawio-skill:
существующая схема дополнена XML-only страницей; PNG/visual QA NOT_RUN после
известного sandbox/Electron blocker, повторного export нет.

### 7 сентября: локальный shared-overlay source slice

[Renderer/checker contract](PARTNER_GAME_MEMBERSHIP_NGINX_SHARED_OVERLAY.md) выдаёт
только draft одного добавочного vhost, не deploy config или production evidence.
Сохранены прежние branch/worktree; реальная конфигурация, ключи и policy не менялись.

- Последний targeted shared-overlay run: **58/58 PASS**, 0 failures/skips, exit 0.
  Прежние 31 lexer tests прошли ранее в этом этапе; после этого lexer не менялся.
  Общий свежий прогон ниже повторно включает все эти 89 tests; synthetic certs only.
- Проверены exact route/rate parity, public certificate pins/SAN/EKU/validity,
  source allowlist, closed input, inherited iterator и Buffer-method injection, namespace/host
  collision, +1 file preservation (включая backup names), include cycles/missing
  targets, double overlay loading и inherited Real IP через разные include contexts.
- Явные limiter dry-run off / satisfy all, редактированный audit и все live flags
  false. Копия renderer object, self-declared workers/application/production PASS
  не становятся source-owned overlay или production-verifier evidence.
- Scoped ESLint трёх source/test files: PASS. Full sequential Partner suite:
  **789 tests / 765 PASS / 24 FAIL / 0 skipped**, actual exit 1. Все 24 failing names
  точно совпали с предыдущим 731-test baseline; новых failing names нет. Старые
  source/proof pins не resealed; общий release gate остаётся RED.
- Root `npm run lint`: actual exit 0, **0 errors / 387 warnings**. LOCAL_HEAVY
  освобождён после завершения обоих последовательных процессов; coordinator уведомлён.
  Root build не повторялся: прежние 17 недостающих VITE inputs остаются blocker.
- Независимый read-only security review закрыл inherited Real IP/dry-run, Array
  iterator и Buffer-method bypasses; финальный scoped source verdict P0–P2 = 0.
- Native Nginx/shared-listener/PKI/application/worker/external probe tests: **NOT_RUN**;
  ранее отложенная native rehearsal остаётся **DEFERRED_BY_USER**. Existing fixed
  probe/generation collector не подключён к новому redacted log dialect.
- Инфографика: новая страница существующего drawio XML. CLI export и PNG visual QA
  не повторялись после установленного sandbox/Electron blocker; XML-only fallback.

Двенадцать файлов в fixture — модель topology, не actual host export. Byte
preservation не доказывает semantic preservation; root/key custody и фактическая
полнота glob enumeration здесь не проверяются. Исторические receipts не resealed.

### 7 сентября: оставшиеся disk include targets обследованы

После `65a5b2e` — [отдельный bounded read-only capture](PARTNER_GAME_MEMBERSHIP_NGINX_INVENTORY.md#remaining-literal-include-targets-completed-read-only-continuation).
Actual SSH exit0,06:23:52.306–.428UTC:12config-файлов/1,235statements/skipped0,
финальные epoch/hash/fd checks прошли. Это literal-include disk inventory, не
полный semantic graph, native Nginx application или production acceptance.

| Новые проверки private helper | Фактический результат |
| --- | --- |
| Exact6targets/3symlink destinations, frozen3glob sets; drift original6pins | Bounded allow или отказ; разрешения не расширяются по содержимому config |
| Path aliases, unknown rawConfig/rawToken fields | Нет неизвестных полей/доменных имён в metadata projection |
| Quoted6structuralheads | Явный отказ; не молчаливое пропускание include |
| Private key/cert/credential/unknown config paths | Не входят в read allowlist |

Все **31 дополнительные synthetic assertions PASS**, отдельно от прежних31lexer
unit tests. На изменённом helper также PASS13scanner/path assertions и7synthetic
fd/ancestor/race scenarios; syntaxPASS. Review P2 quotedhead закрыт доSSH;
повторный security review P0–P2=0. Это review кода, не аттестация private receipt.

Runtime/policy/pins в репозитории не менялись. Полный Partner suite, lint и build
в этом этапе **NOT_RUN**, прежние731/707PASS/24FAIL и0errors/387warnings не являются
новыми прогонами. Native rehearsal DEFERRED_BY_USER/NOT_RUN; нет probes/reload или
server/provider/shared-data writes. Схема обновляется как XML; PNG/visualQA NOT_RUN
из-за известного sandbox/Electron blocker, повторных запусков export нет.

### 7 сентября: исправление ограниченного inventory lexer

После `b678973` закрыта [ошибка сканера на строке 465](PARTNER_GAME_MEMBERSHIP_NGINX_INVENTORY.md#line-465-scanner-discrepancy-resolved-not-nginx-validation).
`node --test scripts/tests/partnerGameMembershipNginxLexical.test.mjs`: **31/31 PASS**.
Тестовые config-строки синтетические; production tokens/строки не скопированы.

| Сценарий | Проверяемое поведение |
| --- | --- |
| `#` внутри unquoted regex/word; synthetic line-465 fixture | Не начинается комментарий, открывающая скобка не теряется; hash/no-hash дают одинаковую структуру |
| Комментарий на границе token, quotes, escapes, variables, CRLF | Прежние ограниченные правила и номера строк сохраняются |
| Input/type/NUL/UTF-8 bytes, token count, nesting depth | Bounded reject; punctuation тоже расходует token limit |
| Truncated escape/quote/variable, unnamed/unbalanced block | Фиксированный error code, без исходных значений в ошибке |
| Попытка принять lexical result за production proof | Production entry по-прежнему `UNSUPPORTED_INGRESS_ADAPTER` |

Полный последовательный Partner-набор `node --test --test-concurrency=1
scripts/tests/partnerGameMembership*.test.mjs`: **731 tests / 707 PASS / 24 FAIL /
0 skipped**, actual exit 1. Сравнение имён падений с предыдущим 700-test baseline:
все 24 совпали, новых/исчезнувших 0. Исторические proof pins не менялись.
Root `npm run lint`: actual exit 0, **0 errors / 387 warnings**; scoped ESLint PASS.
Full release gate RED; root build не повторялся без прежних 17 VITE inputs.

Отдельное фактическое read-only A/B чтение воспроизвело legacy scanner failure и
307 statements после исправления. Следующий guarded inventory завершил чтение
6 allowlisted config-файлов с before/after guards. Это **scoped disk evidence**, не
native Nginx validation/application, HTTP/TLS probe или полный include graph:
6 чужих targets не читались. Native rehearsal остаётся `DEFERRED_BY_USER / NOT_RUN`.
Схема дополнена отдельной страницей границ; PNG export/visual QA NOT_RUN из-за
ранее подтверждённого sandbox/Electron blocker. Production entry не открывался.

### Предыдущие checkpoints

Продолжение после `40c7239`: локальный controlled-application runner включает
обязательные11probes после revoked, held-fd READY→transport+EOF→RESULT pipe,
отдельную peer namespace и observer+2. Generation/link suite **139/139 PASS**
(50новых cases). Full sequential Partner run **700 tests / 676 PASS / 24 FAIL /
0 skipped**: exact24failure names совпали с предыдущим checkpoint, новых0.
Новые tests включают protocol errors/EOF/child close и delayed/outer-deadline
regressions; synthetic metadata/streams не являются Docker/native/Nginx PASS.
Root lint actual exit0:0errors/387warnings; scoped ESLint и driver syntaxPASS.
XML0errors/0warnings; local links25PASS. Full release gateRED, nativeNOT_RUN.

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
