# Nginx: проверка контролируемого применения конфигурации

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
  source-owned operator для своих Docker IDs. Создаёт окружение, публикует три
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

**Текущий blocker:** фактические command line и роль отказавшего процесса не
попали в sanitized receipt; первопричина несовпадения ещё не установлена.
Docker daemon — `linux/aarch64`, pinned images — `linux/amd64`; различие архитектур
зафиксировано, но не доказано причиной отказа. Следующий отдельный bounded
diagnostic должен сохранить безопасные сведения только о собственных Nginx PID,
различить неверную ожидаемую форму команды/особенности среды/неверный процесс и
добавить regression на подтверждённую причину. Нельзя ослаблять identity check,
добавлять capabilities или считать Docker init PID вместо Nginx worker.
Новых runtime запусков до отдельного согласования нет; heavy-slot RELEASED.

Схема: страница `Controlled Nginx application` в
[существующем drawio](assets/partner-game-membership-ingress-evidence.drawio).
Native exporter ранее недоступен; XML-only fallback, PNG/visual QA NOT_RUN.

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
