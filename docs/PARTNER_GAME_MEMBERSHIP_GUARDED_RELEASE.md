# Partner API: пакет с защищённым запуском

6 сентября 2026. **Локальный release candidate; не боевой деплой и не активация.**
Существующая ветка сохранена. Новый пакет включает raw guard, фактический startup
entrypoint и дисковый audit. Старый уже созданный packet не изменяется на месте.
Уточнение ответственности: анкета/подпись P0 от партнёра не требуются и выпуск их
не ожидает. PadlHub обеспечивает работающие методы, контракт и серверные проверки;
партнёр реализует свой клиент. Технические prerequisites ниже — наша release-работа.

Текущее дополнение после `eb607aa`: реализован **BOUND_DEFAULT_OFF** с независимым
root-owned startup anchor. Это локальный source checkpoint, не новый install packet
и не actual CLI/root-custody proof. Исторические 20/20 ниже относятся к прежним
exact bytes. Изменившийся startup, как и предыдущий token resolver, требует нового
runtime/guarded/packet evidence; release pins и старые receipts не переписаны.

Дополнение после `b38e8f7`: добавлен третий режим **BOUND_ACTIVE** — единственный,
который может обслуживать трафик. Он достижим только через тот же root-owned anchor,
который явно авторизует активацию для одного canary-клиента и ограниченного набора
игр; env-переменные сами по себе активацию не дают, и packet manifest её не
авторизует. Sidecar bytes изменились, поэтому sidecar closure resealed: новый
`guardedStartupSha256` `d610475a`, репетиция `5416c722`, controls pin `eb1d0af0`
(было `5e74de46`). Install packet под эти bytes ещё не собран.

## Состав и границы

`sidecar/settings-runtime.cjs` — единственный выбранный `--settings` в service unit.
Он вызывает `guarded-startup.cjs`, а не экспортирует одну лишь фабрику.
Builder, production controls и private binding проверяют девять exact sidecar
артефактов, включая policy и новый `guarded-sidecar-rehearsal.json`.
Baseline `settings.cjs` остаётся зависимостью фабрики, но не service entrypoint.
Resealed manifest с изменённым или отсутствующим guard не проходит проверку.

Старый `sidecar-rehearsal.json` сохранён как исторический документ, но исключён
из нового packet. Исторические functional/dependency-tree evidence и семь файлов
custom-node не переписаны: их прежний scope не расширен новым startup proof.
`npm ci` в новой репетиции не является новым vulnerability audit. Отдельный actual
audit от `2026-09-06T09:09:03.738Z` допускается максимум 24 часа; при истечении окна
нужна независимая свежая проверка, а не изменение даты в JSON.
[Новая audit/ingress квитанция и границы](PARTNER_GAME_MEMBERSHIP_NGINX_CANDIDATE.md).

## Защищённый запуск

1. Разрешены только `--userDir … --settings … candidate.flow.json`. Лишние,
   сокращённые, повторные CLI flags и альтернативные targets дают startup refusal.
   `NODE_OPTIONS`, `NODE_PATH`, safe-mode/projects env запрещены; unit их удаляет.
2. `current` может быть symlink на конкретный release. CLI targets приводятся к
   canonical paths этого release. Проверяются тип, permissions, owner, links,
   bounded read, inode/size/timestamps и SHA-256 actual candidate.
3. Baseline packet policy остаётся `DEFAULT_OFF_UNBOUND`, Host `unbound.invalid`.
   Новый внешний anchor может привязать Host, audience и exact release в режиме
   `BOUND_DEFAULT_OFF` по правилам ниже. `DEFAULT_OFF_UNBOUND` и `BOUND_DEFAULT_OFF`
   требуют `ENABLED=false`, `PROVIDER_MODE=disabled`, `VIVA_MUTATIONS_ENABLED=false`;
   env drop-in с `true` не активирует версию. `BOUND_ACTIVE` — единственный
   activatable режим и требует обратного набора флагов (см. «Активация»).
4. Ровно три HTTP-In routes; upload/skipBodyParsing запрещены. Node-RED получает
   сохранённую копию graph через storage adapter. Его поздняя CLI assignment не
   перечитывает pathname, и последующая замена `current` не меняет captured graph.
5. Editor/admin закрыты. Flow/credential/library writes запрещены; credentials
   возвращаются пустыми. Обычные Node-RED settings/sessions остаются в private state.
   Startup failure не открывает listener. Нельзя вручную подменять settings baseline.

[Инфографика, страница «Guarded release startup»](assets/partner-game-membership-ingress-evidence.drawio).
XML проверен структурно; PNG/export и visual QA не выполнены из-за ранее
подтверждённого сбоя draw.io Electron в этой среде.

## Привязанный запуск без активации

Точка независимого доверия — фиксированный
`/etc/padlhub/partner-game-membership/approved-startup.json`, **вне packet и private
userDir**. CLI, env, HTTP и sibling JSON в packet не могут заменить его путь.
Файл не содержит credentials, не исполняется и не генерируется самим запуском.
Его подготовка/установка — отдельно разрешённое действие оператора PadlHub после
проверки exact release; анкета или подтверждение партнёра не нужны.

| Условие | Поведение |
| --- | --- |
| Selector отсутствует или `DEFAULT_OFF_UNBOUND`, anchor отсутствует | Прежний default-off, Host `unbound.invalid` |
| `LK_PARTNER_GAME_API_STARTUP_MODE=BOUND_DEFAULT_OFF`, anchor корректен, runtime audience совпадает | Привязанный Host, immutable graph, API по-прежнему OFF |
| `BOUND_ACTIVE`, anchor активен и keyring совпадает, все provider gates выставлены | Привязанный Host, immutable graph, API обслуживает объявленных клиентов |
| `BOUND_ACTIVE` без `activationAuthorized`, без `authorizedClients` или с иным `mode` в anchor | Startup refusal, без fallback |
| Keyring и `authorizedClients` расходятся: включён необъявленный клиент, объявленный выключен, или игра клиента вне его набора | Startup refusal |
| `BOUND_ACTIVE` при неполном наборе provider gates (любой из них отсутствует или иной) | Startup refusal |
| Keyring: не ровно один enabled client, client ≠ `canaryClientId`, или его games выходят за `canaryGameIds` | Startup refusal |
| Bound selector без anchor, пустой/неизвестный selector, anchor при unbound selector | Startup refusal, без fallback |
| Anchor unreadable/malformed/подменён, любой release/audience mismatch | Startup refusal, без открытия audit/runtime settings |
| Bound/DEFAULT_OFF flag вместо `false/disabled/false` | Startup refusal независимо от корректности anchor |

JSON anchor имеет ровно следующие поля (таблица — контракт, не боевые настройки):

| Поле | Требование |
| --- | --- |
| `formatVersion` | Число `1` |
| `mode` | `BOUND_DEFAULT_OFF` или `BOUND_ACTIVE`; обязан совпадать с `LK_PARTNER_GAME_API_STARTUP_MODE`, поэтому default-off anchor нельзя переиспользовать для активации |
| `expectedHost` | Exact lowercase DNS hostname до 253 символов; без wildcard, URL, port, trailing dot, IP и `unbound.invalid` |
| `expectedAudience` | Существующая grammar `[a-z0-9][a-z0-9._:-]{2,127}`; exact match с серверным `LK_PARTNER_GAME_API_AUDIENCE`, без trim/fallback |
| `candidateFlowSha256` | SHA-256 exact `candidate.flow.json`, также совпадающий с baseline policy |
| `releaseDirectory` | Canonical абсолютный каталог этого release, не alias `current`, не `/`; не пересекается с writable userDir |
| `packetManifestSha256` | SHA-256 independently approved bytes `packet.manifest.json` |
| `approvedCommit`, `approvedTree` | Independently approved 40-hex Git identities; сравниваются с manifest, не извлекаются из него как expected values |

Только для `mode=BOUND_ACTIVE` в anchor добавляются ровно два поля; при
`BOUND_DEFAULT_OFF` их присутствие — startup refusal (exact key set на каждый режим):

| Поле | Требование |
| --- | --- |
| `activationAuthorized` | Строго `true`; единственная авторизация активации, packet manifest её не заменяет |
| `authorizedClients` | Объект: ключ — `clientId` по `^[a-z0-9][a-z0-9_-]{2,63}$`, значение — 1–8 уникальных game id по `^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$`. 1–16 клиентов |

`authorizedClients` должен совпадать с keyring по составу: каждый `enabled:true` client
объявлен, ни один объявленный клиент не выключен, а игры каждого клиента — непустое
подмножество его собственного набора. Включение нового клиента всегда требует нового
root-owned anchor, поэтому именно анкор, а не env и не packet, остаётся единственной
авторизацией активации.

## Активация (`BOUND_ACTIVE`)

Активация — отдельно разрешённое действие оператора PadlHub, а не следствие
успешного packet или rehearsal. Порядок: собрать и установить exact release,
затем записать root-owned anchor с двумя полями выше, затем выставить gates.
Guard требует одновременно `ENABLED=true`, `PROVIDER_MODE=viva`,
`VIVA_MUTATIONS_ENABLED=true`, revision `padlhub-viva-technical-booking-v1`,
подтверждённые idempotency и on-place и непустой technical client id; любой
неполный набор — startup refusal, а не частичная активация. Границы активации
ограничены набором клиентов и игр из `authorizedClients`: включённый client не
может получить игру вне своего набора, а включение клиента без правки анкора
даёт refusal при старте. Возврат — замена anchor на `BOUND_DEFAULT_OFF` (или
удаление двух ACTIVE-полей) и restart: `ENABLED=true` без активного anchor даёт refusal,
то есть downgrade не открывает listener и не оставляет API включённым.

Anchor: root owner, regular non-executable file, один hard link, без symlink и
group/world write. Каждый ancestor — canonical root-owned directory без
group/world write. Limit 4096 bytes; строгий UTF-8/JSON без duplicate keys.
Для bound release проверяются root ownership и защищённые ancestors также у
policy/candidate/manifest и всех перечисленных в manifest files. Установка должна
заранее дать service UID необходимые read/traverse права, **не write**. Startup
не выполняет chmod/chown и не исправляет доступ автоматически.

Manifest проверяется по внешнему hash, approved commit/tree, private packet schema
и `deployAuthorized=false / activationAuthorized=false`. Проверяются aggregate,
уникальные безопасные relative paths, наличие критических startup/runtime sources
и exact bytes каждого перечисленного файла. Limits: manifest 16 KiB, 128 entries,
один файл до 2 MiB, сумма до 16 MiB. `mode=0600` внутри manifest — исходная private
packet declaration; фактические установленные root-owned файлы могут иметь
ограниченный group-read, но не group/world write. Это не изменение transport packet.

Installed custom-node namespace обязан быть root-owned symlink
`runtime/node_modules/@padlhub/node-red-partner-game-membership-api` с exact
`readlink` value `../../partner-package` и canonical target того же release.
Копия, другая цель или промежуточный hop запрещены даже при одинаковом начальном
`realpath`. Полные installed Node-RED dependencies и trusted executable installation
проверяются отдельным release/runtime gate, а не только наличием этого symlink.

Каждое чтение проверяет fd/name identity до/после чтения; перед принятием bound
result повторно сверяются все сохранённые file/ancestor identities, включая anchor,
manifest, ранее прочитанные sources и installed symlink. Это bounded startup
consistency check, **не атомарный filesystem snapshot**. Нужна исключённая конкуренция
с другими root deploy writers; после возврата settings root всё ещё может менять
файлы. Код startup уже загружен при этой проверке, поэтому она не заменяет trusted
installation custody до `require()` и не защищает от скомпрометированного root/ACL.

Host передаётся в raw guard из проверенного anchor. Проверка server audience здесь
не является новой HTTP-auth реализацией: реальная HMAC/audience/nonce проверка
остаётся в core API и не считается испытанной на live по default-off запуску.
Anchor читается при старте, не отслеживается автоматически; его удаление не
останавливает уже запущенный процесс. Перепривязка/rollback требуют проверенного
anchor для нужного exact release и отдельно разрешённого restart.

### Проверки этого source-этапа

`partnerGameMembershipBoundStartup.test.mjs` проверяет positive bound startup,
runtime entrypoint wiring, root ownership/modes/ancestors, bounded stable reads,
missing/unreadable/malformed anchor, no downgrade, Host/audience/manifest/source
подмены, preserved-commit/tree reseal, позднюю замену ранних inputs и installed-link
hop. Legacy guarded/raw tests сохраняют audit/CLI/storage coverage.

Fixture использует реальные owned temp bytes, но **projected root metadata и
controlled dependencies**: не читает реальный `/etc`, не делает chown, не запускает
root/systemd/Node-RED, не получает Viva token. VM entrypoint test не является
физической CLI репетицией. Идентичные старые failed release checks не становятся
PASS без нового actual evidence. Native Nginx application rehearsal по-прежнему
`DEFERRED_BY_USER / NOT_RUN`.

## Долговечный raw audit и восстановление

State directory: canonical, service UID, `0700`; `raw-requests.audit.jsonl`: тот же
UID, `0600`, regular file, один hard link. Exclusive lock исключает два writer.
Открытие без symlink/blocking FIFO, identity/size check до и после каждого append.
Полная запись и `fsync` обязательны до допуска запроса. Запись содержит только
server UTC timestamp, фиксированные stage/code и новый UUID; body/headers/nonce/
подпись/PII отсутствуют. Бизнес-audit остаётся отдельным слоем.

Лимит — **16 MiB**, без автоматической ротации/удаления. Disk-full, partial write,
fsync failure, замена/усечение файла или lock защёлкивают отказ до перезапуска.
Перезапуск проверяет весь ограниченный JSONL, включая последнюю строку. После
SIGKILL возможен stale lock: автоматическое снятие запрещено.

Runbook для будущего оператора (не выполняется пакетом):

- До активации назначить владельца, monitoring свободного места/доступности audit,
  retention и защищённый архив. Предупреждать до достижения лимита.
- При отказе закрыть admission/остановить только Partner sidecar согласованной
  процедурой. Убедиться в отсутствии writer и listener; не трогать shared Node-RED.
- Сохранить bytes, hash, permissions и сведения о сбое в приватном архиве. При
  partial tail не обрезать журнал автоматически; провести forensic reconciliation.
- Только уполномоченный оператор после проверки отсутствия writer может архивировать
  точный журнал/lock и подготовить новый private audit. Не использовать `copytruncate`,
  wildcard deletion или очистку audit на работающем процессе.
- После recovery пройти default-off startup, append/readback и negative probe;
  возврат admission/активации — отдельное разрешённое действие.

Audit не защищён от компрометации самого service UID. Если диск недоступен,
сохранение записи отказа не обещается. Отказ admission audit (`RAW_ACCEPTED` до
`next()`) запрещает новый business dispatch. Отказ terminal `RAW_REQUEST_DEADLINE`
audit после dispatch не отменяет уже запущенную операцию: transport закрывается,
но сохранность terminal event не гарантируется. Нужны независимая сигнализация,
reconciliation и дальнейшая корреляция ingress/application logs.

## Воспроизведение и доказательства

```sh
npm run test:partner-game-membership-api
node scripts/rehearse_partner_game_membership_guarded_startup.mjs --install-locked-runtime
```

Предусловия: доступный Docker, pinned Linux/amd64 Node image из checked-in proof,
нет конфликтующего writer. Installer использует registry только с exact lock и
`--ignore-scripts`; actual probes — network none, без host ports, secrets, Mongo/Viva.
Fixture сверяет упакованный service и запускает его argv/environment через actual
Node-RED CLI, но **не systemd**. Все созданные контейнеры проверяются и удаляются
по exact owned IDs; cleanup failure даёт failure, а не PASS. SIGKILL самого
orchestrator требует ручной проверки retained receipt/IDs, не общего Docker prune.

Исторический wildcard checkpoint: startup suite **54 unit/negative tests**. Весь Partner набор после wildcard fix и
actual closure refresh: **303/303**. Свежий physical proof от
`2026-09-06T10:10:11.713Z`: **20/20**, в том числе три business default-off `503`, loopback-only
listener, admin `404`, duplicate header/JSON `400`, шесть durable audit rows,
graceful stop/restart и десять startup refusals. Snapshot/symlink swap проверен unit
тестом; нет заявления о live filesystem race test. На том checkpoint receipt и source
hashes были закреплены в `guarded-sidecar-rehearsal.json`. Исторический raw receipt SHA
`76760a3590d7e5a6c2cfe02e417dea388c3f9389d31223d78f2544502d0d241d`.
Новая Nginx observer matrix **49/49** — отдельное доказательство scrub/ingress,
не повторный тест service path или HMAC/payment/provider business flow.

## Что требуется до боевого результата

После response-deadline correction выполнена **новая20/20 CLI репетиция** на
guard/audit bytes от этого исправления (`2026-09-06T12:37:38.718Z`). Closure и
raw receipt обновлены только после фактической проверки19copied source files и
двух exact container absence readbacks. Подробности и границы70-row Nginx/late
HTTPOut proof — в [deadline evidence](PARTNER_GAME_MEMBERSHIP_RESPONSE_DEADLINE.md).
Это не systemd/production/Viva proof и не новый опубликованный install packet.

| Приоритет | Владелец | Следующий обязательный результат |
| --- | --- | --- |
| P0 | Инфраструктура PadlHub | Отдельный Host/SNI, DNS owner, выдача/отзыв mTLS client certificate, разрешённые источники |
| P0 | Release/security | Свежий runtime audit, exact-head main/CI, новый private packet из свежего shared-flow collision readback; отдельные merge/push/deploy gates |
| P0 | Инфраструктура/security | Локальный Nginx generator проверен; закрыть оставшиеся OPEN/NOT_TESTED и effective-config/live verifier: сейчас `UNSUPPORTED_INGRESS_ADAPTER` |
| P0 | Эксплуатация | Audit custody, monitoring, retention/recovery, host systemd и rollback readback |
| P0 | Backend/provider owner PadlHub | Viva credential lifecycle, доказанные idempotency/cancellation/payment semantics; реальные Mongo indexes и fencing; разрешённый canary |
| Требования к клиенту, не согласование | Партнёр | Canonical signing, clock sync, уникальные nonce, persistent idempotency key; новый подписанный retry вместо повторной отправки перехваченного wire request |

Raw guard не заменяет HMAC/timestamp/nonce/ACL/ownership. Добавление/оплата/удаление
в Viva и защита от replay на production должны быть подтверждены отдельной
разрешённой интеграционной проверкой PadlHub. Сейчас передавать партнёру «боевые настройки»
как работающие нельзя: endpoint не активирован и ingress не подтверждён.
