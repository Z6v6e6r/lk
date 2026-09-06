# Partner API: raw-request guard и локальная Nginx-репетиция

Статус: **реализованный локальный кандидат, не установлен в production**.
Выбран Nginx; существующая ветка и ранее собранный v0.2 packet сохранены.
6 сентября [новый guarded release candidate](PARTNER_GAME_MEMBERSHIP_GUARDED_RELEASE.md)
включён в source-driven packaging/controls/binding; production не изменён.
`verifyPartnerProductionIngress()` по-прежнему возвращает
`UNSUPPORTED_INGRESS_ADAPTER`; capability preflight остаётся BLOCKED. Его pins
проверяют baseline capability, а не live activation нового guarded candidate.

[Редактируемая схема](assets/partner-game-membership-ingress-evidence.drawio),
[общая ingress-модель и live gates](PARTNER_GAME_MEMBERSHIP_INGRESS_VERIFIER.md).

## Что добавлено

| Файл | Ответственность |
| --- | --- |
| `scripts/partner_game_membership_sidecar/raw-request-guard.cjs` | Ограниченный разбор stream, raw headers и duplicate JSON keys до Node-RED parser |
| `scripts/partner_game_membership_sidecar/settings-guarded.cjs` | Фабрика кандидатных настроек и проверка трёх HTTP-In routes; frozen settings не мутируются |
| `scripts/tests/partnerGameMembershipRawGuard.test.mjs` | Unit/negative/lifecycle tests и отказ на ошибке подготовки fixture |
| `scripts/tests/fixtures/partner-raw-guard-runtime.cjs` | Реальный Node-RED HTTP In → test observer; HTTPS/raw HTTP probes |
| `scripts/tests/fixtures/partner-raw-guard-http.cjs` | Fixture-only HTTP response framing; reset/interim-100 regression |
| `scripts/rehearse_partner_game_membership_raw_guard.mjs` | Одноразовая изолированная Docker-репетиция, доказательства и cleanup |

Новых зависимостей нет. Переиспользован exact lock Node-RED 5.0.6. Nginx Docker
1.24.0 — **тестовая сборка**, не аттестация Ubuntu package на боевом сервере и не
рекомендация установить старый Docker image в production.

## Порядок обработки и обязательные настройки

1. Nginx завершает TLS/mTLS; edge отклоняет framing, который мог бы измениться при
   proxying: Transfer-Encoding, Content-Encoding, Trailer, Expect, Upgrade,
   Proxy-Connection и недопустимый Connection. В fixture только HTTP/1.1, без
   URI rewrite и upstream retries; HTTP/2 не включён и не проверен.
2. `httpNodeMiddleware` проверяет неизменённый `originalUrl`, метод, exact Host и
   `rawHeaders`. Отказ не запускает чтение тела и закрывает соединение без reuse.
3. Guard единолично читает stream в пределах 16 KiB и абсолютного deadline
   максимум 5 секунд. Нельзя предварительно читать body, добавлять другой body
   parser, включать `skipBodyParsing`/upload или воспроизводить stream повторно.
4. UTF-8 decoder с fatal validation и ограниченный JSON lexer проверяют ключи
   **до** `JSON.parse`. Затем сохраняется обычный JS object в `req.body`.
5. Только после подтверждённого audit выставляются `req._body=true` и
   `req.skipRawBodyParser=true`, затем вызывается `next()` ровно один раз.
   Actual Node-RED 5.0.6 / body-parser 1.x пропускают повторный parse. Для POST и
   DELETE HTTP-In передаёт тот же объект в `msg.payload`; GET передаёт пустой
   `req.query`, поскольку query запрещена.
6. Далее остаётся существующая бизнес-защита: HMAC, timestamp, nonce,
   idempotency, ACL, принадлежность integration membership и provider fencing.
   Raw guard не заменяет ни один из этих механизмов и не включает provider.

`settings-guarded.cjs` экспортирует **фабрику**, это не готовый файл для прямой
передачи в `node-red --settings`. Новый `settings-runtime.cjs` вызывает фабрику
через guarded startup, проверяет actual candidate и закрепляет graph в storage
snapshot. Это проверено отдельной CLI-репетицией, описанной в release-документе.

Фабрика допускает только root `/`, выключенный editor/admin, отсутствие другого
`httpNodeMiddleware`, `httpNodeCors`, `httpNodeAuth`, и ровно три HTTP-In:

| Метод | Route | Тело |
| --- | --- | --- |
| POST | `/lk/integrations/v1/open-games/:gameId/members` | JSON object; бизнес-schema проверяется следующим слоем |
| DELETE | `/lk/integrations/v1/open-games/:gameId/members/:membershipId` | Пустой JSON object `{}` |
| GET | `/lk/integrations/v1/operations/:operationId` | Нет body, Content-Length отсутствует либо `0`; canonical body `{}` |

Для POST/DELETE нужен один `Content-Type: application/json` без параметров и один
канонический положительный Content-Length. Все security headers обязательны;
Content-Type для bodyless GET может отсутствовать. Повтор любого raw header
отклоняется без учёта регистра, comma-joined security values также запрещены.
Запрещены query/fragment, percent-encoded или неоднозначный path и лишний slash.
Идентификаторы в path ограничены ASCII `[A-Za-z0-9_-]`, 1..160 символов; бизнес-слой
сохраняет собственные более строгие ограничения.

## Ошибки, ресурсы, audit

- Body ≤16384 **байт**, headers ≤16384 байт / 100 пар, target ≤2048 байт.
- JSON depth ≤32, values ≤4096. Duplicate keys проверяются во всех объектах,
  включая вложенные в массивы и escaped Unicode aliases. Invalid UTF-8/BOM,
  bad escape, trailing garbage, scalar/array/null root отклоняются.
- Whitespace, порядок полей и безопасные `JSON.parse` semantics сохраняются;
  wire JSON не обязан быть canonical. Поля `__proto__` не присваиваются объекту
  вручную. Предметная schema и ограничения чисел остаются в существующем core.
- Таймаут, abort, IO error, premature end, response close, bytes mismatch и
  признаки предыдущего parser дают отказ до `next()`, с очисткой buffers/listeners.
- Ответ guard содержит только фиксированный `error` и новый случайный
  `requestId`, `Cache-Control: no-store`, `Connection: close`; CORS не добавляется.
  Статусы: 400 для запрещённого input, 408 deadline, 413 oversize, 503 audit failure.
- Неожиданные ошибки нормализуются в `RAW_GUARD_INTERNAL_ERROR`. Audit event имеет
  только `stage`, фиксированный `code`, новый `requestId`; нет body, headers,
  подписи, nonce, пути, IP, client ID или пользовательского correlation ID.
- Trusted audit sink обязан **синхронно вернуть `true`** после принятия записи.
  Throw, false, Promise/thenable блокируют dispatch. В fixture запись выполняется
  через write + fsync. Новый release включает bounded disk sink; его production
  custody/retention, monitoring и сквозная ingress/application корреляция ещё не подтверждены.

Важно: при отказе самого audit нельзя обещать сохранение отклонённой записи в
недоступном хранилище. Fail-closed исключает бизнес-операцию; для production нужны
независимый сигнал недоступности audit и его восстановление.

## Воспроизводимая локальная проверка

Предусловия: уже доступный Docker, Node.js ≥22 и OpenSSL, отсутствие конфликтующих
writers в этой task worktree. Не перезапускать Docker и чужие контейнеры.
Из корня этой ветки:

```sh
npm run test:partner-game-membership-api
docker pull --platform linux/amd64 node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96
docker pull --platform linux/amd64 nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1
node scripts/rehearse_partner_game_membership_raw_guard.mjs --install-locked-runtime
```

Команда явно разрешает registry access **только setup-контейнеру**. Он создаёт
чистый private runtime по checked-in lock и семи custom-node source files,
выполняет `npm ci --ignore-scripts --no-fund --no-audit`, без host `.npmrc`, секретов,
Docker socket, lifecycle scripts или опубликованных портов. Чужой preinstalled
`node_modules` не принимается. Это не повторный vulnerability audit dependencies.

Сам тест: Node container `--network none`; Nginx делит только его network namespace.
Оба работают от непривилегированного UID, с read-only root, `cap-drop ALL`,
`no-new-privileges`, ограниченными CPU/RAM/PIDs и временным tmpfs. Нет опубликованных
портов, production env, provider/DB доступа. Diagnostic observer существует только
в fixture: успешный ответ 200 **не является успехом Partner бизнес-операции**.

135 физических probes проверяют direct и Nginx→Node-RED варианты: POST/DELETE/GET,
raw header duplicates (same/different values, same/mixed case), comma values,
Unicode/nested JSON duplicates, malformed JSON, byte boundary, query, deadline,
framing, no-client-cert и client abort. Для отказов observer count остаётся 0;
для успеха 1, payload deep-equal, POST/DELETE identity сохранена. Дополнительно
три `skipBodyParsing:true` mutants отклоняются preflight до запуска Node-RED.

Bare reset/timeout не считается PASS. Раннее закрытие oversized request иногда
даёт ECONNRESET **после** полного length-framed 413; только в этом случае fixture
принимает HTTP refusal. Промежуточный HTTP 100 отделён от финального ответа.
Ранние Nginx/parser отказы не приписываются guard; их слой явно отмечен.

## Evidence и безопасное завершение

Private results directory содержит `receipt.json`, `probes.json`, redacted
`guard-audit.jsonl`, `nginx-access.jsonl`, install log. Receipt связывает source,
orchestrator, installed-tree before/after, exact images/versions/config, публичные
синтетические certificate hashes, OpenSSL version, probes и audit digests.
Проверяются exact probe-name set, zero-write flags, Docker network/mount/user/cap
readback до/после и неизменность установленного runtime.

Cleanup работает только по созданным exact container IDs и уникальной run-label.
Ошибка cleanup одного контейнера не отменяет попытку очистки остальных.
`PASS_LOCAL_ONLY` появляется только после доказанного отсутствия всех собственных
контейнеров, проверки журналов и удаления exact allowlist временных keys/CSR.
`FAILED_CLEANUP`, `FAILED_FINALIZATION`, `FAILED_RECEIPT_WRITE` — не PASS.
При неизвестном остаточном состоянии сначала проверить exact run-label/IDs;
никаких `docker prune`, общих stop/rm или удаления чужих volumes.

Ошибки подготовки также проходят cleanup, включая OpenSSL failure до Docker.
Abrupt SIGKILL/крах хоста не даёт гарантий выполнения finally: после восстановления
оператор проверяет оставшиеся IDs и private output directory, прежде чем повторять
run. Повторный запуск не должен автоматически удалять ресурсы прошлой попытки.

## Что ещё не готово и вопросы по приоритету

Проверки 2026-09-05: combined Partner **229/229**, включая 86 новых raw-guard/
fixture regression tests; физических probes **135/135**, flow preflight negatives
**3/3**. Full ESLint: 0 errors, 387 существующих warnings; TypeScript и inert
prod/dev builds PASS. Independent security и release/custody review: P0–P2 = 0
для локального scope. Drawio XML: 0 errors/warnings; PNG/visual QA не выполнены
(ранее подтверждённая ошибка Electron helper, повторные безрезультатные экспорты
не запускались).

Exact-head remote CI и production checks не запускались. Modular Node-RED validate
не запускался: он требует отдельный verified source workspace и selector; production
flow в этом этапе не получали и не пересобирали. Вместо него проверены actual
locked HTTP-In middleware path и candidate flow preflight в изолированном runtime.

| Приоритет / владелец | Решение до следующей границы |
| --- | --- |
| P0, release/security | Guard/factory/startup уже включены в новую source closure; дальше свежий private packet, exact-head CI и отдельные integration/deploy gates; старый packet не модернизируется на месте |
| P0, инфраструктура | Закрытый production Nginx generator, exact Host/SNI, TLS/mTLS termination, отсутствие direct ingress и protocol policy; full wrong-cert/SNI/shared-host/reachability matrix пока NOT_RUN |
| P0, инфраструктура/security | Production audit sink, retention/access, backpressure/disk-full recovery, корреляция отказов Nginx с application log; fsync fixture не доказывает это |
| P0, партнёр | Владельцы client certificate/key, источник запросов, подпись canonical body, безопасная передача ключей, clock sync, nonce uniqueness и хранение idempotency key; повторный wire request нельзя использовать как retry |
| P1, партнёр | Согласовать HTTP/1.1, exact content type/length, отсутствие compression/chunked/query, stable membership IDs, timeout/status polling и обработку UNKNOWN без повторной бизнес-операции |
| P1, release/provider owner | Exact-head CI, отдельные main integration/push/deploy gates, реальные Mongo/Viva preconditions, canary и rollback; этот observer не проверяет Viva/paid flags |
| P1, инфраструктура | Controlled reload/effective-config evidence для Nginx 1.24; `nginx -t` не доказывает конфигурацию боевых workers |
| P2, партнёр/операции | Rate limits, мониторинг отказов/nonce collisions, дежурный контакт, периодическая проверка восстановления и сертифицированная ротация |

Перехваченный запрос не становится безопасным только от raw guard: anti-replay
обеспечивают совместно mTLS, подпись, ограничение времени, одноразовый nonce и
durable idempotency существующего API. Production доказательство этой полной
цепочки, бизнес-проверка удаления только integration-owned участников и реальная
оплата/отмена в Viva остаются самостоятельными gates.
