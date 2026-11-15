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

Откат не удаляет объекты/refs, не меняет signing key, не переотправляет команды и не
трогает архив/held queue. Сохранить media reader и прежнюю S3 конфигурацию. Переключение
outgoing graph требует inverse с новым source SHA и worker binding, а не восстановления
старого полного flow поверх чужих изменений. До E2E и remote parity feature не объявляется live.

## Проверки

`npm run test:support-photos`, существующие MAX receipt/rate/lifecycle tests,
изолированный Node-RED 4.0.9 editor/runtime loader, `npm run build`, `npm run lint`.
Результаты mock transport не доказывают работу S3/provider в production.

Первичные provider contracts: [MAX media](https://dev.max.ru/docs-api/use-cases/sending-messages/media/),
[uploads](https://dev.max.ru/docs-api/methods/POST/uploads),
[messages](https://dev.max.ru/docs-api/methods/POST/messages).
