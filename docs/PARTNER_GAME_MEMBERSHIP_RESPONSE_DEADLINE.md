# Partner API: 15-секундный deadline HTTP-ответа

Локальное исправление после `32c0ad6`, в той же Partner-ветке. Это не deploy,
активация, live ingress proof или изменение брони. Production verifier остаётся
`UNSUPPORTED_INGRESS_ADAPTER`. Боевые Nginx/Node-RED/Mongo/Viva не меняются.

## Что ограничиваем

Независимый watchdog в `raw-request-guard.cjs` отсчитывает **15000 ms от входа
в middleware** по монотонным часам. Он переживает чтение body, `next()` и
промежуточные байты ответа. Отдельный body deadline остаётся максимум5000ms.
Trusted factory может только сократить response budget, не ниже body budget;
пользовательские headers/body не управляют настройкой.

`finish`/`close` ответа снимают watchdog и его listeners. `close` запроса этого
не делает: входной stream может закончиться раньше ответа. Раннее пробуждение
таймера перепроверяет remaining budget; после синхронного audit перед `next()`
есть дополнительная проверка, запрещающая запуск новой операции после deadline.

По истечении budget guard выполняет только `res.destroy()` **без Error argument**,
не синтезирует503/504 и не подменяет методы response. Это важно для позднего
настоящего Node-RED HTTPOut: уже завершённый synthetic response вызвал бы попытку
повторной отправки headers. Перед закрытием ещё не прочитанный body останавливается.
Затем делается одна попытка записать `RAW_REQUEST_DEADLINE` с тем же trusted
`requestId`, что у `RAW_ACCEPTED`. Это fixed metadata, без подписи, nonce, body,
пути, IP и персональных данных. Ошибка sink не сохраняет соединение открытым;
сохранность события при недоступном диске не обещается. Нужен отдельный audit alert.

Границы гарантии:

- Не включает TLS и чтение заголовков на edge; их ограничения остаются у Nginx.
- Это не hard real time: занятый JS event loop или синхронный fsync задерживают
  callback. Физические проверки отдельно показывают измеренное время и допуск.
- Nginx `proxy_read_timeout` остаётся idle timer, а не абсолютным deadline.
  На молчащем upstream два15s таймера могут состязаться: допустим502 либо504;
  этот probe подтверждает лишь общий предел, а не владельца cutoff.
- При начавшемся ответе клиент может получить неполный503/chunked stream, а не
  валидный JSON error. Это **transport failure, не успешный API response**.
- Освобождённый transport slot не означает завершение business work: зависшие
  провайдерные операции требуют своих limits/reconciliation и наблюдаемости.

Основание: [Node22 timers](https://nodejs.org/download/release/v22.23.2/docs/api/timers.html#settimeoutcallback-delay-args),
[HTTP response lifecycle](https://nodejs.org/download/release/v22.23.2/docs/api/http.html#class-httpserverresponse),
[Nginx idle timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout).

## Что должен делать партнёр при обрыве

Обрыв **не отменяет** уже начатое добавление/удаление в Viva и не доказывает его
неуспех. Watchdog не меняет reservation/operation/nonce, не выполняет compensation
и не делает provider retry. Существующий core и provider не изменяются.

1. Если известен `operationId`, читать operation status существующим подписанным GET.
2. Иначе повторить ту же команду с **тем же Idempotency-Key и идентичным body**,
   но новыми nonce/timestamp/signature. Состояние pending/UNKNOWN возвращает202;
   завершённая операция возвращает сохранённый результат без второго provider call.
3. Не генерировать новый ключ операции только из-за timeout. Не повторять
   перехваченный wire request: использованный nonce должен дать409.
4. Для UNKNOWN применять согласованную reconciliation, не угадывать итог Viva.

## Проверки и источник доказательств

Unit regressions: body rejection/timeout, normal finish, early client close,
req.close после body, early timer callback, delayed synchronous audit, failing
deadline audit, один terminal event, освобождение listeners, durable sink reopen.
Отдельный тест соединяет actual guard с существующим подписанным core и
in-memory repository/synthetic provider: после cutoff exact replay409,
pending retry202, поздний success201, completed retry200; ровно один add,
participant и payment, ни одного remove. Это не реальная Viva/Mongo проверка.

Физическая local matrix использует installed pinned Node22.23.2/Node-RED5.0.6 и
Nginx1.24 в двух owned network:none контейнерах, без host ports и внешних данных.
Новый direct loopback sidecar probe отличает watchdog от гонки с Nginx: response
закрывается до headers; synthetic operation завершается в18s и идёт через actual
HTTPOut, `complete`/`catch` counters проверяют один результат и отсутствие ошибок.
Drip probe обязан показать ровно8 writes, закрытие около15s, незавершённое HTTP
framing и один matching trusted audit. Обычные probes по-прежнему требуют полный
HTTP response. Arbitrary reset, timeout самого клиента или отсутствие audit — FAIL.

Actual physical run завершён `2026-09-06T12:33:54.677Z`: **70/70 PASS**, state
`PASS_LOCAL_MATRIX_ONLY`, без подтверждённых failures среди этих named70rows.

| Actual probe | Наблюдение |
| --- | --- |
| Combined silence bound | Полный502 через15032ms; один dispatch/upstream. Не standalone Nginx-idle attribution |
| Nginx drip cutoff | Через15029ms, первый байт22ms,9 response chunks; incomplete503, один watchdog event, active0 |
| Direct sidecar before headers | Через15030ms,0байт/без HTTP status; matching watchdog event |
| Позднее завершение synthetic operation | После закрытия один operation result и actual HTTPOut complete1/catch0; ни одного повторного dispatch |
| Recovery после cutoff и late completion | Полный503 через25ms, один upstream/dispatch; drip writes не возобновились |

- Receipt SHA: `3afb400ba653b43dbf1d8b3a1fc7502d38dccd3511c9043f6faf107c863a2250`.
- Probes SHA: `f80b6d0547ef30db2b78460ca0317da18063940ab7e4b580ebdf17235c9b1284`.
- Config SHA: `e86f030658b80c2fec2078bae0e7d205ea357b9d322a7dd5611890914e684be9`.
- Collector проверил9 source hashes,6 fixture copies, config/runtime tree и
  container/process identities до/после. Runtime tree `6daf6d15…` не изменён;
  reused read-only audit input проверен свежим digest, без install/download.
- Два owned containers удалены; отдельный exact-ID Docker readback пуст.
  Synthetic keys/CSRs отсутствуют; чужие контейнеры не тронуты.
- Допуск physical observation:14500..17000ms, в отчёте сохранены реальные числа.
  Это не обещание hard15s cutoff при произвольной блокировке event loop.
- `notTested=[]` только для named70row matrix. Independent source limits,
  external direct-sidecar denial, production verifier/revocation — OPEN.

Свежая guarded CLI-репетиция завершена `2026-09-06T12:37:38.718Z`: **20/20 PASS**,
6durable audit rows,10startup refusals, actual Node-RED CLI; systemd не выполнялся.
Отдельно допущенный locked install — scripts OFF, затем probe network:none;
19copied source files сверены с retained receipt и текущими source bytes.
Оба owned containers удалены, fresh exact-ID readback пуст. Runtime/custom-node
lock и7custom-node файлов не изменялись; обновлены только guard/audit/sidecar proof
и связанные production-controls/preflight hash pins. Все authority flags false.

- CLI receipt SHA: `5c3937eb037baa5ca023d820f00878ee66307959429914e0055bdff5d6ca7829`.
- CLI probes SHA: `7990bb1630f4c2100e0fa99c87fde770a7a489c117c6d25b586c5e4e8806b629`.
  Результат20детерминированных rows совпал с прошлым run; свежесть подтверждает
  новый receipt с новыми source hashes, а не само совпадение probes hash.
- Normalized sidecar proof SHA: `23d0a7684835c39600c493edba6066f59d29c3a282a2c63978875a2ea9a7b0a7`.
- Production-controls SHA: `6226f692004944a0c93bca18fce04ba6328a6c91afd0619562fc8f7f40be3d26`.

Deadline disk-audit/reopen проверен отдельным unit с реальным temporary filesystem;
CLI default-off не запускает медленный provider и не заменяет этот тест.
Исторические20CLI и матрица, показавшая18.048s без cutoff, не переписываются.
Published disabled packet не меняется; свежий production packet не выпускался.

Final source checks: **321/321 Partner tests**, skipped0; full lint0errors/
387existingwarnings; production-controls validator, `git diff --check` и drawio
XML parse PASS. Security/reliability и отдельный release/evidence review закрыли
два P2: раннее пробуждение timer и чрезмерно широкую формулировку audit fail-closed.
Frontend build и modular regeneration не повторялись: их source/lock inputs не
менялись. Fresh exact-head main/CI, production packet/deploy, live provider/DB,
systemd и PNG/visual QA в этом gate не выполнялись.

Инфографика: страница `Response deadline and operation ownership` в
[существующем drawio](assets/partner-game-membership-ingress-evidence.drawio).
XML-only fallback: native Electron exporter ранее недоступен; PNG/visual QA
не заявляются пройденными.

## Открытые вопросы к партнёру и владельцам

| Приоритет | Необходимое решение перед пилотом |
| --- | --- |
| P0 | Кто хранит Idempotency-Key до получения окончательного результата; подтверждение, что transport failure не создаёт новую бизнес-команду |
| P0 | Поведение Viva при timeout после commit, provider idempotency и процедура UNKNOWN reconciliation без дубля/неверного удаления |
| P0 | Владелец mTLS/HMAC/ACL/revoke, exact game allowlist; статус операций доступен тому же клиенту |
| P1 | Тайминги partner HTTP client, retry backoff и предел poll/retry; совместимость с502/504 и неполным ответом |
| P1 | Alert по deadline/audit failure, длительным pending/UNKNOWN и числу продолжающихся операций; ответственный за ручную сверку |
| P2 | Отдельные метрики edge latency, sidecar latency и provider duration без секретов/PII; согласованные retention и нагрузочный тест |

Транспортный deadline не закрывает остальные P0 из основного integration plan.
