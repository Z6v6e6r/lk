# Partner Nginx: локальная подготовка shared overlay

Статус: **LOCAL_NGINX_SHARED_OVERLAY_DRAFT_NOT_DEPLOYABLE**. Реализованы генератор
одного добавочного конфигурационного файла и проверка побайтовой сохранности
переданных baseline-файлов. Это первый локальный слой production-layout адаптера,
не установленный endpoint и не live evidence. Следующий локальный слой теперь
[реализован отдельно](PARTNER_GAME_MEMBERSHIP_NGINX_SHARED_ADAPTER.md): closed
shared dialect, отдельный TLS collector и request-ID / four-worker correlation.
Production verifier по-прежнему возвращает `UNSUPPORTED_INGRESS_ADAPTER`.

Исходники: [renderer и preservation checker](../scripts/partner_game_membership_nginx_shared_overlay.mjs),
[bounded lexer](../scripts/partner_game_membership_nginx_lexical.mjs),
[регрессионные тесты](../scripts/tests/partnerGameMembershipNginxSharedOverlay.test.mjs).
[Инфографика: Shared overlay local preparation](assets/partner-game-membership-ingress-evidence.drawio).

## Почему отдельный файл

Прежний [standalone candidate](PARTNER_GAME_MEMBERSHIP_NGINX_CANDIDATE.md) владеет
целым тестовым `nginx.conf`, default/shared-host серверами и одним worker. Перенос
этого файла на общий сервер заменил бы настройки других сайтов. Новый генератор
переиспользует действующие route/rate правила, но выдаёт только maps, limiter
zones, обезличенный log format и один exact-host server. Старый generator,
collector, runtime, policy/binding templates и immutable receipts не изменяются.

[Inventory 7 сентября](PARTNER_GAME_MEMBERSHIP_NGINX_INVENTORY.md) остаётся
историческим: 12 файлов, 1,235 lexical statements, четыре workers. Тестовая
12-файловая модель нового checker полностью синтетическая; реальные config bytes
этим модулем не читались. Совпадение числа файлов не связывает fixture с host.

## Контракт генератора

`generatePartnerNginxSharedOverlay(input)` — синхронная чистая функция без CLI,
filesystem/network/subprocess I/O. Она принимает только следующие собственные
data properties; дополнительные поля, getters, symbols, разреженные массивы и
нестандартный Array prototype отклоняются. Дальнейшая работа использует snapshot
индексных data properties, не caller iterator. Внутренние ошибки не возвращают
certificate/config bytes.

| Поля | Ограничения |
| --- | --- |
| `scope` | Только `LOCAL_PREPARATION`; никакого production mode |
| `exactHost`, `clientId` | Canonical lowercase DNS без wildcard; ограниченный ASCII client ID |
| `sourceAddresses` | 1–8 различных exact IPv4, без CIDR; это ещё не одобренный partner egress |
| `generationMarker`, `now` | 64 lowercase hex; целое время в milliseconds |
| `clientCertificateBytes`, `clientCaCertificateBytes`, `serverCertificateChainBytes` | Только canonical public PEM Buffers, максимум 32 KiB каждый; до шести server-chain certificates |
| `approvedClientSpkiSha256`, `approvedClientCaSha256`, `approvedServerChainSha256` | SHA-256 pins SPKI DER / exact CA PEM / exact server-chain PEM; caller pins не являются approval issuer |

Проверяются validity на переданное время, RSA ≥2048 или разрешённые EC curves,
client/server EKU, non-CA leaf, подпись client leaf выделенным self-signed CA,
exact server SAN без wildcard/CN fallback, подписи/CA-флаги предоставленных
chain links и отсутствие дубликатов. Trust store сервера, полная X.509 path
validation, revocation и соответствие private key **не проверяются**.
Ключи не принимаются и не создаются. Тестовые certificates выпускаются только
во временном fixture-каталоге и удаляются самим тестом.

Фиксированный draft path: `/etc/nginx/conf.d/partner-game-membership-api-v02.conf`.
Ссылки на будущие файлы под `/etc/nginx/partner-game-membership-api-v02/`:
`server-chain.pem`, `server.key`, `client-ca.pem`. Это проект путей, не факт
наличия, чтения, установки или безопасного владения файлами. Нет arbitrary snippets,
includes, load_module, default_server, http wrapper или изменения worker count.

Draft содержит:

- собственный namespace `pgm_v02`; CA verification + exact public-leaf admission;
  client ID связан с этим допуском, а не используется как произвольный rate bucket;
- exact Host/SNI, TLS 1.2/1.3, отключённые early data/session tickets/cache;
- прежние три маршрута POST/DELETE membership и GET operation, без query string;
  framing/Connection guards, rate 2/5 rps, burst 10/20, concurrency 4/8;
- exact IPv4 allowlist и deny all; IPv6 listener не означает IPv6 admission;
  `satisfy all` и оба limiter dry-run режима явно `off`;
- proxy только на `127.0.0.1:18894`, без retry/cache/store; обязательный raw guard
  и проверка HMAC/nonce остаются ответственностью существующего sidecar;
- server-scoped audit: request ID, status/upstream status, admission booleans,
  worker/generation и limiter outcomes. Без body, URI, IP, DN, client ID, certificate,
  HMAC или nonce. Сам Nginx access log не заменяет durable admission audit sidecar
  и не доказывает fail-closed поведение при заполнении диска.

Сгенерированный объект и список unresolved controls заморожены. Private WeakMap
связывает checker с объектом этого renderer в том же процессе: клон/JSON roundtrip
не принимается. Это source ownership, **не криптографическая аттестация хоста**.
Реальный public leaf присутствовал бы в config map: draft config нельзя публиковать
в Git/партнёрском пакете или журнале как обезличенный артефакт.

## Проверка сохранности общей конфигурации

`hashLocalNginxClosure(files)` принимает массив `{path, bytes}`: 1–64 файла,
128 KiB на файл, 1 MiB суммарно, canonical UTF-8 и ограниченные абсолютные пути.
Обязателен `/etc/nginx/nginx.conf`; key/pem/env/log paths не допускаются.
Digest вычисляется по отсортированному canonical manifest `{path, sha256}`.
Содержимое не печатается и не читается с диска.

`verifyLocalNginxSharedOverlayChange({baselineFiles, candidateFiles,
expectedBaselineSha256, overlay})` требует одновременно:

1. Baseline digest совпал с отдельным переданным pin. Новый overlay path отсутствует.
2. Каждый baseline path остался с теми же bytes, включая backup-vhosts; candidate
   содержит ровно одно добавление с точными renderer bytes. Ни удаления, ни правки,
   ни дополнительного файла.
3. Нет lexical namespace/exact-host collision. Regex/wildcard/dynamic server names
   и quoted structural heads отклоняются консервативно; это не универсальный parser.
4. Ровно одно `include /etc/nginx/conf.d/*.conf` во всей переданной closure, именно
   в корневом `http` контексте `nginx.conf`. Повторное/вложенное включение запрещено.
5. Все literal include targets присутствуют; допускаются только три фиксированных
   glob формы для conf.d, sites-enabled и modules-enabled. Циклы, глубина >8,
   неизвестные patterns и недостижимые переданные файлы отклоняются.
6. При обходе учитывается effective include context, максимум 2,048 пар file/context.
   Наследуемые из `http` `set_real_ip_from`, `real_ip_header`, `real_ip_recursive`
   отклоняются; настройки только внутри неизменного sibling server не наследуются.

Новый `scanNginxInventoryStructure()` сохраняет заголовки блоков, lexical context
и block/context IDs для различения sibling blocks и include instances;
старый `scanNginxInventoryStatements()` сохраняет прежний output. Оба ограничены
128 KiB / 50,000 tokens / depth 256; raw tokens остаются private intermediate.
Изменение source SHA не пересчитывает предыдущие inventory captures задним числом.

Результат: `LOCAL_SHARED_OVERLAY_BYTE_PRESERVATION_CHECKED_NOT_LIVE_PROOF`, hashes,
число сохранённых файлов и одно добавление. `productionVerified`, `deployAuthorized`,
`activationAuthorized` всегда false. `filesystemCustody: NOT_CHECKED`,
`semanticPreservation: NOT_PROVEN`, `workerGeneration: NOT_OBSERVED`.

## Что остаётся до использования на сервере

Сохранность bytes не доказывает неизменность поведения: новый server влияет на
общий listener, а часть директив наследуется или выбирается до SNI. Например,
`ssl_protocols` может определяться default server; см.
[официальные Nginx SSL docs](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_protocols).
Применимый inherited Real IP отклоняется, limiter dry-run и `satisfy` перекрываются
явно. Но общие `error_page`, auth/rewrite/module handlers всё ещё могут менять denial
routing и обработку запроса. Этот checker не аттестует их семантику. Нужен отдельный
compatibility/security adapter, а не снятие флага NOT_PROVEN. Теперь есть отдельный
[closed shared-dialect профиль и новая source correlation](PARTNER_GAME_MEMBERSHIP_NGINX_SHARED_ADAPTER.md).
Обезличенный log dialect по-прежнему **не подключён** к старому fixed collector:
там требуются поля `probeId`/source, которых нет в production-layout draft log.
Не переименовывать старую fixture receipt в подтверждение этой конфигурации.

Оставшиеся обязательные границы:

- trusted host collector: actual glob enumeration, ancestor/symlink/same-fd custody,
  fresh baseline under lock; caller может опустить файл glob, и текущая функция
  не обнаружит это без внешнего filesystem observation;
- exact shared-listener/default-server semantics, full dependency/module closure,
  native validation и фактические shared-vhost/route-isolation negatives;
- trusted server PKI/key custody, live raw guard/runtime и fresh packet proof;
- controlled application с доказательством **всех четырёх** workers, disk-only negative,
  revocation/recovery и external probes из отдельно наблюдаемой точки.

Они выполняются по дальнейшим отдельно разрешённым этапам. Native rehearsal остаётся
`DEFERRED_BY_USER / NOT_RUN`. В этом этапе нет SSH, реальных certificate/key reads,
серверных файлов, reload, DNS, installs, provider calls, deploy или activation.
Партнёру не требуется согласовывать внутреннюю инфраструктуру PadlHub; методы
передаются как рабочие только после фактического выпуска и проверки.

## Воспроизводимые локальные проверки

```sh
node --test scripts/tests/partnerGameMembershipNginxLexical.test.mjs scripts/tests/partnerGameMembershipNginxSharedOverlay.test.mjs
```

Тесты проверяют renderer, parity прежних route/rate expressions, mTLS/public inputs,
закрытый input schema, namespace/host conflicts, byte-preservation, include graph,
повторное подключение overlay и отказ превратить caller claims в production proof.
Результаты общего тестового набора и ограничения сборки — в
[тест-плане](PARTNER_GAME_MEMBERSHIP_TEST_PLAN.md).
