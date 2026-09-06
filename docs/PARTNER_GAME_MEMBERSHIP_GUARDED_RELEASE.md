# Partner API: пакет с защищённым запуском

6 сентября 2026. **Локальный release candidate; не боевой деплой и не активация.**
Существующая ветка сохранена. Новый пакет включает raw guard, фактический startup
entrypoint и дисковый audit. Старый уже созданный packet не изменяется на месте.

## Состав и границы

`sidecar/settings-runtime.cjs` — единственный выбранный `--settings` в service unit.
Он вызывает `guarded-startup.cjs`, а не экспортирует одну лишь фабрику.
Builder, production controls и private binding проверяют девять exact sidecar
артефактов, включая policy и новый `guarded-sidecar-rehearsal.json`.
Baseline `settings.cjs` остаётся зависимостью фабрики, но не service entrypoint.
Resealed manifest с изменённым или отсутствующим guard не проходит проверку.

Старый `sidecar-rehearsal.json` сохранён как исторический документ, но исключён
из нового packet. Исторические runtime audit/functional evidence и семь файлов
custom-node не переписаны: их прежний scope не расширен новым startup proof.
`npm ci` в новой репетиции не является новым vulnerability audit. Audit от
`2026-09-05T06:35:59.436Z` допускается максимум 24 часа; перед выпуском требуется
независимая свежая проверка, а не изменение даты в JSON.

## Защищённый запуск

1. Разрешены только `--userDir … --settings … candidate.flow.json`. Лишние,
   сокращённые, повторные CLI flags и альтернативные targets дают startup refusal.
   `NODE_OPTIONS`, `NODE_PATH`, safe-mode/projects env запрещены; unit их удаляет.
2. `current` может быть symlink на конкретный release. CLI targets приводятся к
   canonical paths этого release. Проверяются тип, permissions, owner, links,
   bounded read, inode/size/timestamps и SHA-256 actual candidate.
3. Policy допускает только `DEFAULT_OFF_UNBOUND`, Host `unbound.invalid`,
   `ENABLED=false`, `PROVIDER_MODE=disabled`, `VIVA_MUTATIONS_ENABLED=false`.
   Даже env drop-in с `true` не активирует эту версию. Host и активация требуют
   отдельного reviewed source/binding изменения; `.invalid` не заменяет auth.
4. Ровно три HTTP-In routes; upload/skipBodyParsing запрещены. Node-RED получает
   сохранённую копию graph через storage adapter. Его поздняя CLI assignment не
   перечитывает pathname, и последующая замена `current` не меняет captured graph.
5. Editor/admin закрыты. Flow/credential/library writes запрещены; credentials
   возвращаются пустыми. Обычные Node-RED settings/sessions остаются в private state.
   Startup failure не открывает listener. Нельзя вручную подменять settings baseline.

[Инфографика, страница «Guarded release startup»](assets/partner-game-membership-ingress-evidence.drawio).
XML проверен структурно; PNG/export и visual QA не выполнены из-за ранее
подтверждённого сбоя draw.io Electron в этой среде.

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
сохранение записи отказа не обещается: гарантируется отсутствие бизнес-dispatch.
Нужны независимая сигнализация и дальнейшая корреляция ingress/application logs.

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

Новая suite: **54 unit/negative tests**. Весь Partner набор: **283/283**.
Physical proof: **20/20**, в том числе три business default-off `503`, loopback-only
listener, admin `404`, duplicate header/JSON `400`, шесть durable audit rows,
graceful stop/restart и десять startup refusals. Snapshot/symlink swap проверен unit
тестом; нет заявления о live filesystem race test. Receipt и source hashes закреплены
в `guarded-sidecar-rehearsal.json`. Предыдущие 135 Nginx observer probes — отдельное
историческое доказательство, не повторный тест нового service path.

## Что требуется до боевого результата

| Приоритет | Владелец | Следующий обязательный результат |
| --- | --- | --- |
| P0 | Инфраструктура и партнёр | Отдельный Host/SNI, DNS owner, выдача/отзыв mTLS client certificate, разрешённые источники |
| P0 | Release/security | Свежий runtime audit, exact-head main/CI, новый private packet из свежего shared-flow collision readback; отдельные merge/push/deploy gates |
| P0 | Инфраструктура/security | Nginx generator и effective-config/live verifier: сейчас `UNSUPPORTED_INGRESS_ADAPTER`; protocol/direct-reachability/wrong-cert/SNI матрица |
| P0 | Эксплуатация | Audit custody, monitoring, retention/recovery, host systemd и rollback readback |
| P0 | Партнёр/provider owner | Viva credential lifecycle, idempotency/cancellation/payment semantics; реальные Mongo indexes и fencing; согласованный canary |
| P1 | Партнёр | Canonical signing, clock sync, уникальные nonce, persistent idempotency key; новый подписанный retry вместо повторной отправки перехваченного wire request |

Raw guard не заменяет HMAC/timestamp/nonce/ACL/ownership. Добавление/оплата/удаление
в Viva и защита от replay на production должны быть подтверждены отдельной
согласованной интеграционной проверкой. Сейчас передавать партнёру «боевые настройки»
как работающие нельзя: endpoint не активирован и ingress не подтверждён.
