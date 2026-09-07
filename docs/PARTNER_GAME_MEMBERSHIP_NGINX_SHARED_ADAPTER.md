# Shared Nginx: локальная связка адаптера

Локальный source path реализован: **renderer → byte preservation → closed shared
dialect → отдельный TLS collector → request-ID / four-worker correlation**.
Это не production operator или разрешение на установку. Результаты всегда имеют
`productionVerified`, `deployAuthorized`, `activationAuthorized` = `false`;
`verifyPartnerProductionIngress()` остаётся `UNSUPPORTED_INGRESS_ADAPTER`.

## Файлы и совместимость

| Файл | Ответственность |
| --- | --- |
| [shared_overlay](../scripts/partner_game_membership_nginx_shared_overlay.mjs) | Renderer, immutable snapshots, source-owned preparation/binding |
| [shared_dialect](../scripts/partner_game_membership_nginx_shared_dialect.mjs) | Ограниченный inherited/default-listener профиль, без I/O |
| [lexical](../scripts/partner_game_membership_nginx_lexical.mjs) | Block/context IDs; прежний statement API сохранён |
| [probes](../scripts/partner_game_membership_nginx_probes.mjs) | Новый shared export; прежний 11-probe export/schema сохранён |
| [shared_generation](../scripts/partner_game_membership_nginx_shared_generation.mjs) | ID join, четыре новых workers, bounded fixture host session |
| [adapter tests](../scripts/tests/partnerGameMembershipNginxSharedAdapter.test.mjs) | Негативные сценарии shared profile, correlation и synthetic host wiring |
| [probe tests](../scripts/tests/partnerGameMembershipNginxProbes.test.mjs) | Реальные loopback TLS sockets и отказ опасных inputs |

Прежние `nginx_generation`, `nginx_application`, Linux-reader и held-log reader
не ослабляются и не получают production mode. Старые receipts не пересчитываются.
Новый результат нельзя пропускать через старый application link с одним worker,
`probeId/source` в логе и счётчиком admission `+2`.

## Closed shared-http profile

`prepareLocalNginxSharedAdapter(input)` принимает те же четыре поля, что
[preservation checker](PARTNER_GAME_MEMBERSHIP_NGINX_SHARED_OVERLAY.md): baseline,
candidate, отдельный baseline pin и source-owned overlay. Обе проверки используют
**один приватный snapshot bytes**, не повторное чтение caller Buffer. Прототипы,
методы и дополнительные properties Buffer/Array не являются допустимым вводом.

Проверка наследования использует lexical block IDs и provenance каждого include
instance. Поэтому два разных server-блока или повторно включённый файл не
смешиваются в один контекст. Верхняя граница: 2,048 file visits, 50,000 expanded
rows, include depth 8; это намеренно ограниченный профиль, не полный Nginx parser.

### Worker declaration: `4` или `auto`, без вывода числа процессов

После checkpoint `888fe90` локально устранён первый подтверждённый source mismatch:
допускается **ровно одна** effective-main декларация `worker_processes 4;` либо
`worker_processes auto;`. Счётчик действует на раскрытые include instances: одна
декларация в main include допустима, root + include и повторное включение файла с
декларацией отклоняются. Отсутствие декларации, другие числа, `AUTO`, переменная,
лишний аргумент, block или реальная декларация вне main также вызывают отказ.
Комментарий и `map/types` data не подменяют main declaration.

`auto` выбирает число процессов автоматически, а не обещает четыре:
[официальный контракт Nginx](https://nginx.org/en/docs/ngx_core_module.html#worker_processes).
Профиль не читает CPU/host, не принимает caller override и не вычисляет «ожидаемое»
количество из декларации. Старый результат/flags/schema сохранён; самостоятельный
dialect checker не создаёт source-owned preparation. Неизменённый generation evaluator
по-прежнему требует ровно четыре actual workers в **каждом** baseline/before/after
snapshot и полное joined coverage. Три/пять процессов дают отказ, частичное покрытие
даёт `LOCAL_SHARED_WORKER_COVERAGE_NOT_PROVEN`, а не допуск другой топологии.

Preservation запрещает изменять существующие bytes и в направлении `auto → 4`,
и в обратном. Новая совместимость не разрешает менять сервер и **не означает**,
что actual baseline целиком принят: TLS/default/header predicates ниже не ослаблены.
Старый actual read относится к `1c0a82d`; новый source на сервере не исполнялся,
raw config локально не копировался, прежние observation/helper/proof pins не обновлялись.

### Остальные inherited/default ограничения сохранены

Неизвестные effective-http директивы отклоняются. Разрешены только перечисленные
в source table формы нейтральных/перекрытых настроек. В частности, отказ вызывают
`error_page`, активные auth/mirror handlers, method/body/header substitutions,
`proxy_pass_header`, trailers, active expires/charset/body filters и неизвестные
module handlers. `load_module` без профиля/custody отклоняется. Обычная опасная
request-настройка только внутри sibling server не наследуется новым vhost.

Но объявления переменных могут быть глобальными: `map` output, sibling `set` и
именованные PCRE captures не могут переопределять guard/correlation namespaces
(`http_*`, `ssl_*`, `request_*`, `pgm_v02_*` и остальные защищённые имена в source).
Регистр учитывается как в Nginx; обычные ссылки на эти переменные разрешены.
Заголовки блоков и data entries `map/types` не смешиваются. Для captures проверяются
и decoded, и raw private token: внутренние apostrophes bare PCRE не должны исчезнуть
из проверки при упрощённом снятии кавычек. Старый inventory output не расширен.

Для IPv4 и IPv6 на 443 обязательны **существующие явные default_server**, которые
не меняются добавлением overlay. Implicit default, неизвестные listen options,
address-specific listeners, shared HTTP/2, proxy_protocol/QUIC и конфликт defaults
отклоняются. Для default context нужны точные TLS 1.2/1.3 и ранние header settings:
2k buffer, 7×2k large buffers, timeout 5s, ignore-invalid on / underscores off.
Это ограничение нового профиля, не утверждение, что текущий сервер ему соответствует.
Неподходящий baseline требует отдельного решения/разрешения, а не автоматической
правки соседних сайтов. [Nginx SSL protocol selection](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_protocols).

В overlay явно включены pass-request-headers/body, отключены proxy redirects,
gzip и управляющие upstream X-Accel headers. Это предотвращает указанные варианты
унаследованной обработки, но не является проверкой всех статически встроенных
модулей или запретом произвольного upstream 3xx. Native configuration/module
custody и поведение shared defaults до выбора Partner vhost остаются отдельным gate.

## Request ID вместо клиентской метки в audit

Nginx формирует `X-Padlhub-Ingress-Request-Id` из собственного `$request_id` и
скрывает одноимённый upstream header. Collector не посылает этот header и не
берёт ID из входных options. Принимается только одно фактически полученное значение
из 32 lowercase hex; duplicate/malformed response headers отклоняются.
[Nginx add_header / always](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header).

Redacted JSONL поля сохранены, теперь в canonical порядке: admission booleans,
limiter outcomes, generation, requestId, status/upstream, worker. IP, URI, тело,
nonce, подпись, client ID, DN/cert и caller probeId в журнал не добавлены.
Это operational correlation ID, **не credential или anti-replay proof**. Защита
бизнес-запросов HMAC/nonce и durable audit sidecar не заменена этим механизмом.

`collectPartnerNginxSharedTransportObservations(input)` — отдельный export с прежними
закрытыми transport inputs плюс `clientId`. Используются фактические TLS identities,
сокеты, response headers и body hash; DNS/proxy/redirect hooks отсутствуют. Client ID
совпадает с выбранным renderer ID; подпись всегда заведомо недействительна. Методы
только GET/OPTIONS, пустое тело; операций с бронями/оплатой нет.

План фиксирован: 11 прежних probe cases + 16 `workerCoverage01..16`, 600 ms между
попытками, максимум 5 s на probe и 60 s на сессию. Нет повторов по результату или
бесконечного ожидания «пока ответят все». Future operator обязан независимо
подтвердить default-off; collector самостоятельно этого не устанавливает.

## Корреляция и четыре workers

`evaluateLocalNginxSharedGeneration({preparation, observationBytes, logBytes})`
принимает source-owned preparation и ограниченные canonical JSON bytes. Envelope:
`scope: LOCAL_PREPARATION`, baseline/before/after snapshots, отдельные baseline и
candidate **closure hashes**, transport и timestamps. Root-file `configSha256`
из прежнего reader не переименовывается в include-closure hash: при overlay root
файл может совершенно законно остаться неизменным.

Требования: ровно четыре unique/non-draining workers, ожидаемые PPID/executable,
стабильные before/after и master/boot/namespaces. Ни один PID не принадлежит старому
набору; startTicks каждого нового worker больше максимального старого. Журнал
содержит только их PID и literal generation marker текущего source-owned overlay.

Join выполняется по **server response ID**, а не по порядку строк, status, caller
probeId или IP. Повторные/неизвестные IDs, чужие строки, stale marker/workers,
retry upstream, ложный edge 503, dry-run limiter и неполный positive ответ отклоняются.
Покрытие каждого worker считается только по joined positive 503 от default-off
upstream, с verified client leaf, no-store и реально прошедшими limiters.

Если 27 попыток не покрыли все четыре PID, результат
`LOCAL_SHARED_WORKER_COVERAGE_NOT_PROVEN`. Полное покрытие даёт только
`LOCAL_SHARED_FOUR_WORKERS_CORRELATED_NOT_LIVE_PROOF`. Ответы чужого/default-vhost
или TLS failures без собственного ID/log вынесены в `uncorrelatedProbes`; это **не
успешная проверка их блокировки сервером** и не доказательство внешней изоляции.

`createLocalNginxSharedGenerationSession()` переиспользует фиксированный nonroot
Linux/x64 `/control` reader и held FD журнала, не arbitrary production paths.
Captures завершаются до закрытия FD; общий monotonic/wall deadline 90 s проверяется
в том числе после финального snapshot и log finish. Ошибка закрывает сессию;
повторный finish запрещён. Closure/transport остаются caller-unattested даже при
фактическом чтении synthetic fixture files.

## Граница завершения

Локальная связка исходников не равна реальному применению Nginx. Нужны отдельно:
fresh trusted host/include/module/PKI custody, проверка пригодности actual baseline,
native config validation, controlled application/revocation/recovery, runtime/packet
proof, exact-head CI и разрешённые deploy/activation/postchecks. Native rehearsal
по-прежнему `DEFERRED_BY_USER / NOT_RUN`; запускать её молча нельзя.

После паузы `9901488` получено новое неконфликтующее окно: одно read-only чтение
7 сентября 08:28:02 UTC завершилось exit 0, все 12 prior config pins и final epoch
guards совпали. Checker этого source checkpoint вернул **CLOSED_PROFILE_REJECTED /
NGINX_SHARED_DIALECT_MAIN_UNSUPPORTED**. Подтверждено `worker_processes auto` при
требовании literal `4`; это несовместимость нашего профиля, не ошибка native Nginx.
Четыре фактически наблюдённых worker процесса не устраняли mismatch в том source.
File-local данные о defaults/header settings не являются effective semantics;
полный результат и границы — в [инвентаризации](PARTNER_GAME_MEMBERSHIP_NGINX_INVENTORY.md).
В read-only этапе сервер и профиль не менялись. Затем пользователь подтвердил
локальную адаптацию: выше описан только worker-declaration fix после `888fe90`.
Новая проверка полного actual profile не выполнялась. Запрет live changes и
отложенный native gate остаются в силе.

Результаты тестов — в [тест-плане](PARTNER_GAME_MEMBERSHIP_TEST_PLAN.md).
[Редактируемая инфографика](assets/partner-game-membership-ingress-evidence.drawio).
Согласований с партнёром этот внутренний этап не добавляет; рабочие методы будут
переданы только после фактического выпуска.
