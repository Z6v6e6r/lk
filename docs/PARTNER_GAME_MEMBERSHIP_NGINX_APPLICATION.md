# Nginx: проверка контролируемого применения конфигурации

**Текущий статус, 2026-09-06:** пользователь отложил native Linux/amd64 rehearsal
и установку Docker: `DEFERRED_BY_USER`, native application `NOT_RUN`. Предыдущие
FAILED receipts и диагностический COMMAND_MISMATCH сохранены; ни collector, ни
production verifier не ослаблены. Продолжение независимо от этого теста —
[офлайн-комплект для партнёра](partner-game-membership-kit/README.md), не deploy.
Ниже остаются требования и исторические результаты, а не новые runtime PASS.

Продолжение Partner-ветки после `b1839dd`, без изменения боевой среды.
Это **локальная реализация проверяемого механизма применения**, не готовый
production collector. `verifyPartnerProductionIngress()` остаётся закрытым:
production topology, доверенный оператор и внешняя vantage ещё не утверждены.
Локальный результат нельзя передать этому входу для обхода блокировки.

## Почему нужны и поколение, и реальные запросы

`nginx -t/-T` проверяют файлы; они не читают конфигурацию из памяти workers.
При неудачном HUP Nginx может продолжать работу с прежней конфигурацией. Смена PID
тоже недостаточна: worker может перезапуститься без применения новых файлов.
[Параметры Nginx](https://nginx.org/en/docs/switches.html),
[управление процессами](https://nginx.org/en/docs/control.html).

Поэтому collector создаёт случайный challenge и три различные метки поколения.
Метка — literal в закрытом Nginx log format вместе с `$pid`, а не заголовок
клиента или ответ upstream. Не добавляется публичный endpoint или response header.
Последовательные probes сопоставляются с ровно двумя новыми строками журнала;
лишний трафик приводит к отказу проверки. Этот способ требует тишины в выделенном
контуре и не переносится автоматически на общий production log.

## Последовательность

| Шаг | Обязательное наблюдение |
| --- | --- |
| A: исходное поколение | Оба разрешённых TLS-клиента проходят до тестового observer; подтверждены настоящий master/worker, метка A и upstream counts |
| B только на диске, без HUP | `nginx -t` проходит, но запросы всё ещё обслуживает worker A с меткой A. Это обязательное отрицательное доказательство, не PASS применения B |
| Контролируемый HUP B | Master/boot/executable/namespace прежние; появился новый worker, старого больше нет. В фактическом log — метка B и PID этого worker |
| C: исключён ранее разрешённый leaf | После следующего HUP прежний клиент получает 403 без upstream; второй клиент продолжает получать полный 503 от observer |
| Отдельная сеть клиента | На каждом шаге frontdoor доступен с ожидаемого socket source, но тот же целевой IP на порту sidecar 18894 отвечает `ECONNREFUSED` |

503 означает только проход до synthetic default-off observer. В стенде не
исполняется membership API, HMAC core, Viva или Mongo. Их прежние отдельные
доказательства не переименовываются в результаты этого запуска.

Для отказавшего TCP-соединения нельзя выдумывать фактический `socket.localAddress`:
в direct probe он `null`. Collector задаёт явный source bind и target; перед ним
проверяет TLS frontdoor с той же vantage, её реальный source/peer и отдельный
network namespace. Timeout, reset, ошибка bind или отсутствие положительного
контроля не считаются отказом в доступе. Internal Docker network доказывает лишь
локальное разделение namespace, не недоступность sidecar из публичного интернета.

## Границы реализации

- `scripts/partner_game_membership_nginx_application.mjs`: закрытый fixture dialect,
  одноразовый сеанс и проверка наблюдений. Используется прежний generator с тремя
  synthetic identities; меняются только фиксированные fixture paths/listener,
  точный private peer, диагностическая метка и разрешённая leaf binding.
  Пороги лимитов не меняются. Production hostname/CIDR/commands/hooks не принимаются.
- `scripts/partner_game_membership_nginx_linux.mjs`: read-only `/proc` collector
  в правильном PID/network namespace. Читает именно Nginx master и его children,
  start ticks, executable hash, boot и namespaces; Docker container-init PID не
  подменяет worker identity. Config custody/hash проверяются до/после snapshot.
  Пути фиксированы для стенда; это не проверка Linux ACL/mount custody production.
- `scripts/rehearse_partner_game_membership_nginx_application.mjs`: единственный
  source-owned operator для своих Docker IDs. В application mode создаёт окружение, публикует три
  точных config-версии, выполняет два HUP и собирает реальные observations.
  Не умеет выбирать host PID, systemd unit, произвольную команду или SSH-цель.
- `scripts/tests/fixtures/partner-nginx-application-peer.cjs`: synthetic HTTP
  observer и peer с настоящими TLS/TCP probes. Поддельная метка upstream
  намеренно не используется при проверке поколения. На `secureConnect` берётся
  DER фактически использованного локального сертификата; его hash должен совпасть
  с session-owned identity. Подмена отозванного клиента другим leaf или отсутствие
  actual leaf отвергаются, даже если status равен ожидаемому 403.
- `scripts/tests/fixtures/partner-nginx-application-cleanup.mjs`: fixture-only
  cleanup seam. Ошибка чтения или сохранения log не отменяет остановку/удаление
  exact owned контейнера; потеря log всё равно делает результат FAILED. Ошибки
  cleanup не скрываются. Оба failure path покрыты регрессионными тестами.

Challenge генерируется внутри сеанса, а не передаётся caller. Окно — не более
120 секунд по monotonic и wall clock; откат wall clock, неверный порядок,
ошибка проверки и неполное завершение закрывают сеанс. После `finish()` повторное
использование невозможно; после рестарта создаётся новый challenge. Это локальная
одноразовость выполнения, не durable production replay-store и не замена
nonce/idempotency основного API. Pure reducer может проверить форму выдуманного
наблюдения, поэтому его результат всегда LOCAL; происхождение физических данных
подтверждается отдельным collector receipt и pinned source/image closure.

Тестируется **удаление leaf binding**, а не отзыв через CA CRL/OCSP. Проверяемый
сертификат сначала реально допущен; затем только он исключается из карты, другой
разрешённый клиент остаётся рабочим. Новые соединения отвергаются после ухода
старых workers. Принудительное завершение прежних боевых сессий не реализуется.
Политика CA-отзыва и её freshness требуют отдельного решения.

## Запуск и доказательства

```sh
node --test scripts/tests/partnerGameMembershipIngressEvidence.test.mjs
node scripts/rehearse_partner_game_membership_nginx_application.mjs --owned-local-application
```

Вторая команда — только после exact resource reservation и system admission.
План: три собственных nonroot контейнера с pinned Linux/amd64 Node/Nginx,
по 1 CPU / 512 MiB / 128 PID, read-only rootfs, dropped capabilities,
no-new-privileges; один собственный internal Docker bridge без published ports.
Nginx делит PID/network namespace с observer; peer находится отдельно.
Нет downloads, внешней сети, host credentials, shared DB или Docker socket mounts.
Docker выбирает subnet сам; стенд принимает только canonical private pools
`172.16–31.0.0/16` или выровненные `192.168.{0,16,…,240}.0/20` и выводит точные
адреса `.2/.3` внутри allocation. Не меняет default pools или чужие сети,
не принимает caller CIDR и не использует `--subnet` override. Другой pool — отказ.
Копии scripts/certificates — fixture-only; control/results — отдельные private
каталоги. После проверки удаляются только собственные контейнеры/сеть и synthetic
keys/CSRs; exact-ID отсутствие подтверждается отдельным readback.

После исправлений security/release review и IPAM regression: **94/94 targeted
tests PASS**, полный Partner suite **364/364 PASS**, skipped 0; scoped ESLint PASS.

Первый admitted run `14:25:35.648Z` остановился до containers/probes на участке
network admission: raw receipt **FAILED**, все 12 physical probes **NOT_RUN**.
Созданная собственная сеть удалена; отдельные Docker exact-ID/label queries
подтвердили отсутствие; synthetic keys/CSRs отсутствуют. Точный упавший assert и
subnet не сохранялись. Read-only inventory показал используемые Docker pools
`192.168.x/20`, несовместимые с прежним допуском только `172.x/16`: это обоснованная
гипотеза причины, не восстановленное значение удалённой сети. После correction
новый receipt сохраняет bounded numeric allocated subnet и preparation step;
unsupported pool имеет отдельный фиксированный error code. Повтор — только по
новой reservation и отдельному system admission, прежний FAILED сохраняется.
Старый source-IP run 77/77 не доказывает controlled application.

Второй separately admitted run завершён `14:36:05.151Z`: actual subnet
`192.168.32.0/20`, все три owned containers созданы, исходный Docker
image/resource/mount/namespace contract проверен. Initial `/proc` collector
30 раз сообщил `NGINX_PROCESS_COMMAND_MISMATCH`; итог
**FAILED / NGINX_WORKER_TRANSITION_UNPROVEN**. Это отказ установления исходной
Linux process identity, не доказанный failed reload. HUP и все 12 TLS/TCP probes
**NOT_RUN**; access log пуст, `proof.json` отсутствует.

Все три own containers и сеть удалены; независимые exact-ID/label/network queries
пусты; оба набора synthetic keys/CSRs удалены. Сверены восемь current source
hashes, две копии collector/peer и пять public certificate hashes второго run.
Эта сверка подтверждает входы неуспешного запуска, не полный before/after
runtime proof. Чужие Docker IDs сохранены, 10 running healthy / 5 stopped.

**Blocker на завершении второго run:** фактические command line и роль отказавшего процесса не
попали в sanitized receipt; первопричина несовпадения ещё не установлена.
Docker daemon — `linux/aarch64`, pinned images — `linux/amd64`; различие архитектур
зафиксировано, но не доказано причиной отказа. Следующий отдельный bounded
diagnostic должен сохранить безопасные сведения только о собственных Nginx PID,
различить неверную ожидаемую форму команды/особенности среды/неверный процесс и
добавить regression на подтверждённую причину. Нельзя ослаблять identity check,
добавлять capabilities или считать Docker init PID вместо Nginx worker.
Новых runtime запусков до отдельного согласования нет; heavy-slot RELEASED.

## Отдельная диагностика после 3314cd8: причина установлена

После отдельного согласования выполнен один diagnostic-only run, завершённый
`2026-09-06T15:10:28.486Z`. Итог **DIAGNOSTIC_COMPLETE_NOT_APPLICATION_PASS** /
`KNOWN_COMMAND_FORM_REJECTED`, rejected role `master`. Это закрывает локальную
диагностику, но не blocked controlled-application stage и не выпуск.

| Фактическое наблюдение | Вывод в пределах этого стенда |
| --- | --- |
| Master и child worker: одинаковый `ORIGINAL_NGINX_ARGV`, 54 bytes, 5 NUL, один trailing NUL, без space padding | Это исходный argv, не разные role titles; worker/draining state не доказаны |
| До/после одинаковы PID/start/parent, executable, namespace, boot/config hashes | Наблюдавшееся несовпадение не объясняется изменением этих snapshots |
| Hash `/proc/.../exe` link совпал с точной известной строкой `/run/rosetta/rosetta`, не `/usr/sbin/nginx` | В этом emulated fixture виден emulator executable, не ожидаемый Nginx executable view |
| Неизменённый strict collector вернул `NGINX_PROCESS_COMMAND_MISMATCH` | Отказ сохранён; diagnostic classifier не разрешает доступ |

Daemon здесь `linux/aarch64`, pinned images — `linux/amd64`. Docker документирует
Rosetta как механизм эмуляции x86_64/amd64 на Apple Silicon; Nginx 1.24 устанавливает
process title в своём process cycle. Это контекст, не замена actual receipt и не
доказательство универсального дефекта Rosetta или гарантированного успеха native.
[Docker settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/),
[Nginx 1.24 process cycle](https://raw.githubusercontent.com/nginx/nginx/release-1.24.0/src/os/unix/ngx_process_cycle.c).

Новый `scripts/partner_game_membership_nginx_identity_diagnostic.mjs` читает только
bounded собственные PID. Сохраняет static known-form enum, длины/counts/hashes,
но не raw argv/env/path/error text. Неизвестная форма — `UNKNOWN_REDACTED`;
exe/namespace read failure — `DIAGNOSTIC_INCOMPLETE` с allowlisted stage/role/code.
Даже при partial capture неизменённый strict collector вызывается; частичная
identity не публикуется как доказанная. Actual strict acceptance обозначается
`NOT_REPRODUCED`, другая причина — `CAUSE_UNRESOLVED`, не принудительно reproduced.

Режим `--owned-local-identity-diagnostic` взаимоисключён с
`--owned-local-application`; лишние/совмещённые flags запрещены. Выполняется до
создания третьего peer, без HTTP probes/HUP и без fallthrough в application mode;
общий `finally` выполняет exact-owned cleanup и при отказе. Запуск требует отдельной
reservation/system admission: закрытый диагностический запуск не разрешает повтор.

Actual observer requests **0**, access log **0**, HUP и matrix12 **NOT_RUN**,
`proof.json` отсутствует. Own2containers/network удалены, independent Docker
exact-ID/label/network readback пуст; foreign10healthy+5stopped сохранены.
Сверены **9 source hashes / 3 copies / 5 public certificates / config**;
synthetic keys/CSRs отсутствуют. Оба прежних FAILED receipts неизменны.

- Receipt SHA256: `93f882a96f5d4cb874b5e4e715017ff8768b066ec3ea07eaa9564d99d49b34b5`.
- Diagnostic SHA256: `6582b1cbed8cdc160f02bd2534051a87e6e207d81275354733e3704139826249`.
- Known argv SHA256: `b1aeec712965b315e60d7883d8703c3d50315971dc02f2509e0e6160a6074e6d`.

Final targeted **108/108**, полный Partner **378/378**, skipped0; scoped ESLint
PASS. Регрессия закрепляет фактические 54 bytes и запрет принять одинаковый argv
за доказательство ролей. Security/release review: существенных findings нет.

**Следующий отдельный этап — подготовка изолированной native Linux/amd64 репетиции**:
согласовать владельца и target, read-only подтвердить реальную host/daemon
архитектуру и отсутствие эмуляции; сохранить pins и strict predicate. Один
`--platform linux/amd64` этого не доказывает. Runtime требует нового допуска;
самовольная смена Docker settings, capabilities, production host или принятие
original argv вместо role/draining/executable identity запрещены.
Native execution пока **NOT_RUN**, успех не обещан. Heavy-slot RELEASED.

Схемы: страницы `Controlled Nginx application` (требуемая матрица, не PASS) и
`Nginx identity diagnostic` (actual finding / следующий gate) в
[существующем drawio](assets/partner-game-membership-ingress-evidence.drawio).
Native exporter ранее недоступен; XML-only fallback, PNG/visual QA NOT_RUN.

## Подготовка native Linux/amd64 после a150756

Статус: **PREPARATION_BLOCKED_TARGET_UNASSIGNED**. Пользователь разрешил
подготовку, не новый runtime. Read-only discovery 6 сентября: workstation
`Darwin arm64`, текущий daemon `linux/aarch64`, оба установленных pinned images
`linux/amd64`. Contexts `default` и `desktop-linux` используют local Unix endpoints;
назначенный удалённый native target не обнаружен в этом inventory. Координатор
подтвердил отсутствие назначенного Partner target/владельца в своём реестре.
Это не утверждение, что подходящих машин вообще нет. Общие LK hosts не назначены
для этой репетиции; SSH discovery на них, создание VM и изменение Docker не выполнялись.

**Единственный внешний prerequisite сейчас:** владелец указывает существующий
выделенный native Linux/amd64 target и контакт ответственного за доступ/ресурсы.
До этого host admission остаётся UNKNOWN; LOCAL_HEAVY не зарезервирован.
Источник для подготовки — `a15075605f128a8cfbbf9e15db04e742634d6628`, tree
`d0f811e5b9e1e03947a879e9fc18b0ac2c005594`. Ни strict predicate, ни images не меняются.

### Что проверить на назначенной машине, только чтением

| Требование | Доказательство / stop condition |
| --- | --- |
| Owner / scope | Exact alias, владелец и выделенный контур; отсутствие конфликтующего использования. Production/shared LK не выбираются автоматически |
| Native execution | Owner подтверждает native x86-64 hardware/VM без CPU emulation; `uname -sm` на daemon host = Linux x86_64, Docker server arch = x86_64/amd64. Одного uname внутри amd64 image недостаточно |
| Operator и daemon на одной машине | Явно зафиксированный local Unix endpoint, тот же approved daemon до/после. Runner не запускать на Mac против удалённого daemon: bind paths должны существовать на daemon host |
| Host tools | Nonroot UID/GID, уже доступный Docker без расширения прав; Node с поддержкой текущих источников, OpenSSL; версии фиксируются. Locally observed operator Node22.13.1/OpenSSL3.6.2 — не доказательство наличия на target |
| Images | Оба exact digest ниже уже доступны и image metadata = linux/amd64. Missing image/несовместимый CLI `image inspect --platform` — STOP, не автоматический pull/install |
| Isolation / capacity | Выделенный private рабочий каталог; resource budget согласован. Проверить свободные память/диск и текущих пользователей daemon. Нет изменения чужих containers/networks, daemon config или ACL |
| Source closure | Перед переносом и запуском совпадают все10source hashes с frozen source revision; нет env/secrets/node_modules/raw exports. Docs-only checkpoint не меняет source hashes |

Docker допускает запуск amd64 на ARM через эмуляцию; platform label не доказывает
native. Bind mounts разрешаются на стороне daemon, не клиента.
[Архитектуры Docker](https://docs.docker.com/build/building/multi-platform/),
[bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).
Ни регистрация binfmt, ни наличие/отсутствие одного process name сами по себе
не заменяют owner/host/image/actual-proc evidence; неизвестное остаётся UNKNOWN.

Exact image pins:

```text
node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96
nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1
```

Для переноса нужны **10** source files: существующие9 из diagnostic receipt и
`node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs`,
импортируемый ingress evidence для `canonicalJson`. Все относительные imports
должны разрешаться с сохранённой repo layout; остальные зависимости — Node builtins.
Это transport preparation inventory, не изменение старого9source receipt и не
готовый deploy packet. Не переносить весь dirty primary checkout, secrets, реальные
сертификаты, `.env`, runtime exports или node_modules. Файлы/образы на target пока
не переносились; installs/downloads не разрешены текущим preparation grant.

### Следующий runtime — только после target admission и отдельного разрешения

Первая попытка на новой среде — существующий **diagnostic-only** mode, не полная
application matrix. Утвердить exact target/owner/source manifest, окно и один run:
2owncontainers по1CPU/512MiB/128PID/tmpfs256MiB, один own internal bridge, nonroot,
read-only rootfs, capdropALL/no-new-privileges, без host ports, внешней сети,
Docker socket/host namespaces и реальных credentials. Runner работает на target
под своим UID, native daemon локален; каталоги fresh/private и принадлежат этому UID.
180s execution deadline и отдельный bounded cleanup; перед запуском назначить
оператора восстановления, фиксировать exact owned IDs в recovery receipt.
Не менять сигнал/cleanup policy и не выполнять самостоятельный массовый rollback.

До/после сверяются source/copy/publiccert/config/image/container/network identities.
Actual strict result **ACCEPTED** означает только отсутствие прежнего mismatch в
этом capture (`NOT_REPRODUCED`), не native/application/production PASS. Отдельно
проверить distinct role titles, expected Nginx exe-link и согласованные executable
hashes; источник ожидаемого binary hash связывается с pinned image. Одних
равных master/worker hashes недостаточно для доказательства Nginx binary identity.
Любые padding/mismatch/partial reads/drift остаются STOP с sanitized diagnostic;
никаких retries или ослабления predicate без отдельного разбора.

Third peer/HTTP/HUP/matrix12 на первом native diagnostic **NOT_RUN**. Собственные
контейнеры/сеть и synthetic keys/CSRs удаляются штатно, exact absence проверяется
отдельным readback. Только затем можно отдельно допустить application matrix:
disk-only negative, A→B→C/HUP/old-worker drain, leaf binding revoke и отдельный
direct-sidecar refusal. Эта последовательность не разрешает deploy/activation.

В текущем preparation выполнены offline10source/syntax/import-allowlist проверки
и сопоставление с прежними9receipt hashes. Исходники и тесты не изменены;
прежние378/378 (включая108targeted) — cached source evidence, не новый прогон
и не результат native машины. См. существующую схему `Nginx identity diagnostic`:
её последняя стадия остаётся неисполненной, diagram/visual QA не повторялись.

## Оставшиеся решения перед production, по критичности

1. **P0 — инфраструктура:** закрепить exact shared-Nginx topology, Host/SNI,
   service/executable/config closure, участников deployment lock и утверждённый
   способ применения. Изменение диагностического log format на production —
   отдельное согласованное изменение конфигурации, а не read-only проверка.
2. **P0 — release owner:** назначить доверенного оператора, окно reload/drain и
   действия при оставшихся старых workers. Verifier не получает права самовольно
   их завершать или выполнять rollback. Cooperative lock не защищает от root,
   который его игнорирует; эта граница должна быть явно принята.
3. **P0 — security/партнёр:** выбрать независимую внешнюю vantage, custody ключей,
   approval/trust pins и способ связать её фактические probes с текущим challenge.
   Подписанный caller JSON и существующий declared binding недостаточны.
4. **P0 — security:** согласовать binding revocation против CA CRL/OCSP, поведение
   уже установленных соединений и общий client budget при ротации сертификатов.
5. **P1 — эксплуатация:** определить допустимую длительность проверки, мониторинг
   изменений после receipt и срок его действия. Успех относится к наблюдённому
   поколению, а не ко всем будущим запросам и reload.

Без этих решений результат остаётся
`LOCAL_CONTROLLED_APPLICATION_VERIFIED_NOT_LIVE_PROOF`; deploy/activation false.
Следующая интеграция с production collector должна использовать тот же проверяемый
механизм, но не объявлять fixture paths/namespace/custody боевыми.
