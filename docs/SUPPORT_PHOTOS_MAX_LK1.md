# Фото в ЛК1, ЦУП и MAX

Статус: source change; включение на production требует отдельного релиза и конфигурации.
Изменения не восстанавливают и не переотправляют старые outbox/inbox записи.

## Контракт

- ЛК1: выбор до 10 JPG/PNG/WebP, предпросмотр и удаление до отправки. Браузер
  преобразует фото в JPEG до 1600 px, до 1 MiB на файл и 2 MiB на сообщение.
  Фото без текста допустимо. POST не повторяется через другой endpoint после ошибки.
- ЦУП сохраняет server-owned `mediaRef`/`mediaScope` на immutable версии объекта в
  отдельном закрытом префиксе существующего S3: `cup-support/v1/…`. Бинарные данные
  не попадают в новые Mongo messages/outbox. Подробности: ph-admin `docs/SUPPORT_MEDIA_S3.md`.
- При чтении истории и получении outbox ЦУП выдаёт свежую подписанную HTTPS ссылку.
  Входящий MAX `url` сохраняется отдельно: существующий durable receiver продолжает
  строго сравнивать `(type,url)` с Mongo. Дополнительный ref обслуживает браузеры.
- MAX sender скачивает только настроенный S3 host, проверяет путь и SHA-256 JPEG,
  загружает каждое фото в MAX и затем отправляет `/messages` с ordered tokens и
  подписью. Только явный HTTP400 `attachment.not.ready` допускает до четырёх
  повторов с паузами 1/2/4/8 s в той же команде/lease и общем 20 s deadline.
  Токены загружаются один раз; неопределённый результат никогда не повторяется. Bot Authorization не отправляется на S3 и upload host.
- Нет автоматического повтора неопределённой отправки. Неизвестный результат
  остаётся под прежним durable quarantine/receipt протоколом. Временный отказ до
  `/messages` не выдаётся за отказ доставки пользователю.
- Интервал между фактическими `/messages` одного диалога не менее 500 ms, включая
  переход photo → text. Одновременно допускаются два media jobs, `/uploads`
  запускается с интервалом 150 ms.

## Node-RED candidate

`scripts/prepare_support_photos.mjs` принимает полный private snapshot, файл
SHA pins и новый external output. Он не делает Deploy, import, restart или SSH.
Raw flow и pins запрещены внутри Git, включая symlink обход; output создаётся 0600
с `wx`. Использовать поддерживаемый read-only pull и свежие pins при подготовке релиза.

Изменяются ровно 8 существующих nodes:

| Node | Изменение |
| --- | --- |
| `abccacd291f24659` | media-only preparation перед прежним writer `/lk/support/dialogs/events` |
| `6f399ab785a116d2` | photo IDs входят в короткое dedupe окно; текстовый ключ прежний |
| `0b0670d7eeec9cb5` | безопасный POST echo, resolver и очищенный debug |
| `1a27d9a916e742a0` | resolver после Mongo history и очищенный debug |
| `0006d5707259bc5b`, `47c460de0db646e6` | photo-only dispatch |
| `max_new_outbox_send_main`, `max_new_outbox_send_academy` | controlled first-claim legacy transport |

Добавляются 9 nodes: `support_photo_prepare`, `support_photo_prepared`,
`support_photo_resolve`, `support_photo_resolved`, `support_photo_error`,
`support_photo_debug`, два private HTTP request и scoped catch. Остальные node objects
должны совпадать с preimage. Не использовать wide modular exports для этого изменения.

Media bridge использует `SUPPORT_MEDIA_INTEGRATION_TOKEN` (fallback на уже
настроенный `SUPPORT_INTEGRATION_TOKEN`) и server-side `SUPPORT_API_BASE_URL`.
Публичный LK request не получает служебный token. Приём ограничен двумя concurrent
requests, 30/min глобально и 12/min по socket IP. За общим proxy этот IP может быть
общим для пользователей; лимит консервативный. X-Forwarded-For не считается доверенным.

Ошибка S3 до business writer не создаёт сообщение. Ошибка display resolver после
Mongo commit возвращает `200/ok:true`, committed message ID, пустой response-only
attachments и `mediaRefreshRequired:true`. Сохранённое фото остаётся в Mongo;
его можно прочитать после восстановления resolver. GET при недоступном signer — 503.

## Порядок отдельно разрешённого включения

1. Сначала закрыть зависимость LK PR #418 (webhook receiver); проверить actual source
   и manifests, Node-RED disk/runtime/editor parity, workers и отсутствие чужого lease.
2. Настроить закрытый **versioned** S3 bucket/prefix и минимальные credentials по
   runbook ЦУП. Не менять IAM, ACL, versioning, lifecycle или ключи без разрешения.
3. Собрать и сохранить Linux Node22 candidate и **media-aware full recovery** ЦУП.
   Старые3cc/83 overlays без media reader после первого фото не подходят для отката.
4. Проверить библиотеку автоматических MAX templates: remote hosts должны быть явно
   разрешены в ЦУП либо фото повторно прикреплены с устройства. Недопустимый template
   не создаёт broken outbox; фиксируется `SUPPORT_AUTO_REPLY_MEDIA_UNAVAILABLE`.
5. Receiver config: `mediaIngressToken` равен dedicated media token ЦУП. Это также
   включает 90 s budget всех CUP ingest POST, включая text → photo auto-reply.
   Обновить systemd `TimeoutStopSec=120`: включает POST, majority confirmation и drain.
   Быстрый webhook ACK и nginx webhook ingress timeout не меняются.
6. Установить **весь** `node-red/max-outbox-adapter/`, включая `max-media.js`, и
   `SUPPORT_MAX_MEDIA_SOURCE_HOSTS` с точным S3 delivery hostname. Применить только
   заново проверенный candidate и привязать outgoing worker к новому disk SHA по
   существующему release протоколу. Не запускать входящий polling.
7. После готовности backend/receiver/Node-RED опубликовать ЛК1 и SDK ЦУП.
8. Отдельно разрешённый E2E: LK1 → ЦУП и обратно; MAX → ЦУП и обратно; фото без текста,
   фото с подписью, несколько фото, повторное открытие после expiry и перезапуск ЦУП.
   Проверить provider MID и actual UI, а также отсутствие новых stuck/unknown commands.

Для hot-регистрации adapter читает optional root-owned0600 файл
`/etc/phab-traffic/max-media-integration.json` в защищённом canonical parent.
Он содержит только `mediaToken` (64 hex) и `sourceHosts` (1–4 exact hostnames).
Оба значения атомарно попадают в текущий process.env; конфликт, небезопасный файл
или лишние поля блокируют регистрацию. S3 credentials/signing key в Node-RED не
передаются. Отсутствующий файл сохраняет прежний text-only режим. Обновление файла
после регистрации само по себе не меняет runtime; повторная конфигурация требует
отдельно проверенного release-порядка. Cold restart ради этого не нужен.

Откат не удаляет объекты/refs, не меняет signing key, не переотправляет команды и не
трогает архив/held queue. Сохранить media reader и прежнюю S3 конфигурацию. Переключение
outgoing graph требует inverse с новым source SHA и worker binding, а не восстановления
старого полного flow поверх чужих изменений. До E2E и remote parity feature не объявляется live.

## Защищённое native-применение

Перед flow-фазами адаптер устанавливается отдельным install-only custodian
`support_photos_adapter_custody.mjs`. Он сохраняет два закрытых raw preimage
чужого истёкшего lease (вторая копия находится вне userDir) и, по согласованному
loan, атомарно занимает его собственным persistent v4 `support-media-adapter-install`.
У этого lease нет TTL release. Оператор держит четыре mutex и предоставляет
закреплённые reader-функции для identity, inventory, registry и завершения installer;
сам filesystem-controller npm, HTTP, очереди и сервисы не вызывает.

Одноразовый `support_photos_adapter_upload_guard.mjs` пропускает только исходный
palette XHR `POST /nodes` с единственным `tarball` и точными name/size/SHA.
Native auth и multipart body сохраняются. Root attempt записывается до arming;
Web Lock и общий origin storage запрещают повтор между вкладками и после reload.
Неизвестный результат не разрешает повтор. Временная
project `.npmrc` содержит только offline=true и private cache. Её inode закреплён
до exclusive hard-link publication; удаление допускается только для собственного
inode после terminal proof либо quiescent cancellation до forwarding.

Успех требует HTTP200, завершившихся installer descendants, точных package/lock/
registry/module postimages и прежнего runtime/flow. Callback `readPostimage`
обязан проверять эти факты, включая отсутствие кода optional peers; один npm PID
или пустой spinner этого не доказывает. После проверки и снятия собственной policy
custodian возвращает исходные lease bytes с fsync и повторяемым handback.
Unknown POST, незавершённая registration или failed postcheck сохраняют custody.
Такая установка не является flow-deploy, запуском worker или CUTOVER ЦУП.

Actual host bindings находятся в `support_photos_adapter_host.mjs`, one-command
entry — `support_photos_adapter_operator.mjs`, persistent four-flock holder —
`support_photos_adapter_holder.py`. Holder наследует descriptors в Node child;
проверка требует root parent epoch, named/FD inode, kernel `FLOCK` в fdinfo и
отказ fresh-open contender для каждого из четырёх mutex. Смерть одного процесса
не снимает OFD другого; после гибели обоих сохраняется non-expiring v4 loan.
Обычный EOF, signal или ошибка не являются командой освобождения.

Root-only immutable host config закрепляет identity процессов Node-RED/ЦУП/
receiver, flow/settings/credentials/runtime config и owning installer/loader/
storage/hooks source. Values env/auth не выводятся: проверяются отсутствие npm
override, root HOME, разрешённые через inherited PATH `node`/`npm` и их hashes.
Ожидаемые package/lock и полные module inventories берутся из isolated native-path
rehearsal. Допустимы только восемь опубликованных adapter files и inner lock;
остальные files/symlinks, registry entries и protected invariants сохраняются.

Terminal proof — bound original upload HTTP200, отсутствие любых Node-RED
descendants, свежий clean-editor GET `/flows` и GET `/nodes` с точным
`Accept: application/json`, ровно один ожидаемый node set, version1.1.0 и все
три types; свойства `err` и `pending_version` должны **отсутствовать**. Штатный
API не возвращает `loaded`: результат называется `nativeRegistryVerified`,
а не наблюдённым `loaded:true`. После exact postimage operator отдельно fsync
все известные installer outputs и их каталоги и повторяет проверки.

Install-hook оценка остаётся source-based: reviewed public source, settings и
current flow не должны содержать необъяснённой install-hook registration или
startup/module code. Это trusted-host предпосылка; её нельзя представлять как
наблюдённый пустой live hooks registry. Unknown terminal result не заменяется
отсутствием npm по имени или исчезнувшим spinner.

IPC использует root0700 `requests`/`responses`, bounded0600 files, монотонные
восемь цифр и durable consumed intent до запуска. Auth/native graph остаются
в редакторе; наружу передаются только закрытые digest/boolean/count metadata.
Explicit `close` выполняет **новый** полный idempotent handback, затем holder
сам сверяет dual plan/completion, exact predecessor и отсутствие policy.
Каждая команда close получает отдельный immutable derived request.

После гибели holder recovery требует SHA последнего holder receipt, отсутствие
его прежнего epoch, повторный захват четырёх mutex и exact config/source/dual
plan/loan pins. Старые consumed и unconsumed requests сохраняются и пропускаются.
Recovery разрешает только inspect/confirm/cancel/removePolicy/handback/close;
prepare/reserve/publishPolicy/begin запрещены. Неизвестный POST не повторяется.
Live source drift, чужой lease, живой старый holder или отсутствующие receipts
останавливают recovery с сохранением данных.

Фото используют отдельную семью `nodered_support_photos_release.mjs` и
`nodered_reviewed_flow_deploy/support_photos_*.mjs`. Старые MAX 4+2/8+4 contracts
не расширяются. Чистый builder выводит все фазы из одного защищённого active
snapshot с полным raw SHA и pins десяти исходных nodes:

1. `pause`: только два poller `d:false → true`.
2. `install`: ровно8 existing edits +9 additions, consumers остаются paused.
3. `resume`: только два poller `d:true → false`, после готовности backend и sender.
4. Обратный переход: `pause-photo` (два poller), затем `recover` (restore8/remove9).
   Consumers остаются paused до проверки совместимого backend/worker.

Каждая фаза получает собственный protected stage и один original authenticated
editor POST с deployment type `nodes`. Root custodian сохраняет source, original,
candidate, plan, attempt, ACK и общий lease под прежним flock. Successor проверяет
предыдущие plan/ACK/lease/code/target/original/disk и **точную revision**; одинаковый
graph с чужой новой revision не принимается. Abort до attempt возвращает точный
predecessor lease. После неизвестного POST разрешены только reconcile и явная
adoption наблюдённого результата, без повторной отправки запроса.

Первый `pause` принимает истёкший legacy v2 `soaking` lease только при явном
`expectedLegacyPredecessor: { sha256, deploymentId }` в `prepare`. Полный digest
закрепляет исходные bytes, включая token; candidate предыдущего релиза должен
совпадать с текущим source. План также закрепляет отсутствие lease, если его нет.
Смена владельца, token или наличия lease до `reserve` отклоняется. При отмене
до attempt сохранённый legacy lease возвращается атомарно в исходных bytes;
повторный abort проверяет тот же receipt и не удаляет возвращённый lease.

Root plan и browser seal закрепляют native disk SHA:4 spaces, без newline.
Browser проверяет этот SHA до POST, root — actual disk после POST. Canonical graph
equality не заменяет byte proof для worker. Readback требует загруженный чистый
редактор. Native request сохраняет opaque auth; исходный GET остаётся внутри вкладки.
После каждой фазы использовать новый/reloaded dedicated context: consumed guards и
same-origin attempt markers не удалять и не переиспользовать.

Только `resume` и `recover` могут завершить полный900s soak и освободить lease;
промежуточные фазы передают custody successor. После `finish(resume)` обратный
переход разрешён по immutable finish+ACK+plan, только при отсутствии чужого lease
и свежем совпадении target/disk/native revision. Применение не выполняет CUP restart,
queue handoff, S3 provisioning или worker start — это отдельные части release-пакета.

Target получает identity работающего Node-RED через listener1880 и /proc:
root PID, kernel start ticks, entry/version, executable, cwd и hash command line.
PM2 CLI не вызывается: отказ чтения не должен запускать daemon. Start ticks
сверяются до и после чтения; смена процесса блокирует текущий release-план.
Target дополнительно сверяет весь установленный adapter с опубликованными source
bytes и закрепляет digest protected media config. `nodered_support_photos_worker_rebind.mjs`
проверяет полный13-file installed baseline и меняет только64-byte whole-flow constant;
booking gateway, остальные12 файлов, service mode/cohort и текущие cursors сохраняются.
Forward и paused-recovery bundles используют разные native SHA. Worker остановить и
drain до первой фазы; после последней — двойная штатная runtime attestation, expected401,
затем start и полный scan cycle. Старый whole-flow pin не переносится автоматически.

## Проверки

`npm run test:support-photos`, существующие MAX receipt/rate/lifecycle tests,
изолированный Node-RED 4.0.9 editor/runtime loader, `npm run build`, `npm run lint`.
Результаты mock transport не доказывают работу S3/provider в production.

Первичные provider contracts: [MAX media](https://dev.max.ru/docs-api/use-cases/sending-messages/media/),
[uploads](https://dev.max.ru/docs-api/methods/POST/uploads),
[messages](https://dev.max.ru/docs-api/methods/POST/messages).
