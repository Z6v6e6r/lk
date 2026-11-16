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
