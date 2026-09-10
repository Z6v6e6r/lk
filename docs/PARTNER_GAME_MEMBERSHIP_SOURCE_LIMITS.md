# Partner API: независимые IP-лимиты Nginx

Локальный этап после `c828762`, без деплоя, изменений секретов или общих данных.
При одном TLS-клиенте ограничение по IP маскировалось более строгим ограничением
клиента. Поэтому любой ответ 429 нельзя считать доказательством обеих защит.

## Неизменённая политика и границы стенда

| Ключ | Rate | Burst | Concurrent requests |
| --- | --- | --- | --- |
| Server-owned TLS client bucket | 2r/s | 10 | 4 |
| Реальный socket source (`$binary_remote_addr`) | 5r/s | 20 | 8 |

Генератор остаётся **LOCAL_FIXTURE**: его конфигурация не допускается к деплою.
Нет переопределений порогов, dry-run, произвольных CIDR, меток, фрагментов
конфигурации или выключателей лимитов. Стандартная конфигурация одного клиента
побайтово совпадает с предыдущей версией при одинаковых входных данных.
Опциональный `sourceLimitClients` принимает ровно две дополнительные пары public
leaf/SPKI. Каждая проходит CA/signature/issuer/time/client-EKU/SPKI проверки;
повтор leaf или SPKI между любыми двумя identities отвергается. Bucket labels
создаёт generator, а не `X-Padlhub-Client-Id`. Все три synthetic keypairs независимы.
Это не конфигурация ротации нескольких сертификатов одного боевого партнёра.

Только явно выбранный расширенный стенд разрешает второй фиксированный loopback:
источник A — `127.0.0.1`, источник B — `127.0.0.3`. Адрес `127.0.0.2` остаётся
запрещён. Сертификат `other-client` от того же CA не привязан к разрешённому
клиенту и получает 403 даже с поддельным заголовком имени разрешённого клиента.
Фиксируется фактический `socket.localAddress`, а не только запрошенный адрес.
Оба контейнера используют одно изолированное сетевое пространство `network:none`.
Это не проверка внешнего маршрута, NAT или недоступности sidecar снаружи.

## Как исключается ложное доказательство

Nginx `$limit_req_status`/`$limit_conn_status` не называют отказавшую zone.
Attribution основана на полном бюджете TLS identities, неизменённой политике,
холодном состоянии, actual socket и differential запросе с другого source.
[Rate module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html),
[connection module](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html).

Перед каждой нагрузочной группой проверяются отсутствие активных обработчиков и
новых запросов/передач в обработчик за измеренные минимум 6000 мс. Этого достаточно
для полного восстановления обоих лимитов после предыдущих запросов.
Rate использует leaky-bucket, не фиксированное секундное окно: после cold start
допускается первый запрос плюс burst, а refill зависит от фактического времени.

| Probe | Почему это именно source proof |
| --- | --- |
| 30 последовательных запросов с A: по 10 от каждой из трёх TLS identities | Каждая ниже собственного first+burst = 11; источник превышает first+burst = 21. Серия должна уложиться в 1500 мс, иначе FAIL |
| Caller ID меняется, XFF/Forwarded указывают B внутри этих 30 попыток | Заголовки не создают новый IP-лимит; скрытых дополнительных попыток нет |
| После серии та же третья TLS identity с B, но XFF указывает A | Это её 11-я попытка, ещё в клиентском бюджете; ожидается 503 от тестового обработчика, а не 429 |
| 8 одновременно удерживаемых обработчиков с A: 3+3+2 по identities | Все ниже клиентского предела 4; подтверждены 8 фактических передач и 8 активных обработчиков |
| Девятая попытка третьей identity с A; затем повтор с поддельными заголовками | Обе получают 429 при клиентской concurrency лишь 3; в логах `concurrency=REJECTED`, `rate=PASSED`, upstream отсутствует |
| Та же identity с B проходит, пока 8 обработчиков A ещё активны | Отказ не объясняется глобальным пределом 8 или только клиентским лимитом; поддельный XFF не блокирует другой фактический IP |
| Восстановление после обеих групп | Приём восстанавливается; после запроса нет активных обработчиков, была ровно одна передача в upstream |

503 здесь — **полный synthetic observer response**, не результат включённого
business API. Rate-rejection имеет `rate=REJECTED`, пустые `upstream` и
`concurrency`; concurrency-rejection — `rate=PASSED`, `concurrency=REJECTED` и
пустой `upstream`. Missing/dash/неожиданные значения не принимаются как доказательство.
Произвольные transport errors/timeout/incomplete framing — FAIL. Rate matrix
сохраняет все30attempt observations и differential; concurrency сохраняет8held
responses,2denials и другой source. Данные целиком synthetic.

## Воспроизведение и текущие доказательства

```sh
node --test scripts/tests/partnerGameMembershipNginxCandidate.test.mjs
node scripts/rehearse_partner_game_membership_nginx_candidate.mjs --audited-runtime-root /absolute/owned-audit-root
```

Физический запуск требует отдельно согласованных ресурса и system admission.
Новые77rows — прежние70 плюс7source probes. Runner180s;2ownedpinnedcontainers
Linux/amd64, каждый1CPU512MiB128PID,rootfsRO,capdropALL,nonroot,no-new-privileges.
Нет host ports, downloads, SSH, credentials или provider/DB. Existing audited
runtime RO; fixture RO; private result RW. Receipt связывает THREE_CLIENT_TWO_SOURCE_LOCAL,
3identity hashes,5public certificates, configuration, source/copies, runtime
before-after и точные контейнеры. Keys/CSRs удаляются только после owned cleanup.

Проверки исходного кода: **28/28 PASS**, полный Partner suite — **325/325 PASS**,
без пропусков. ESLint всех шести изменённых JS-файлов: 0 errors / 0 warnings.
Физический прогон завершён `2026-09-06T13:34:20.347Z`: **77/77 PASS**, состояние
`PASS_LOCAL_MATRIX_ONLY`. Это один запуск после отдельного ресурсного согласования
и system admission. Предыдущие результаты 70/20/321 остаются историческими.
Guard/audit/service/settings/runtime/custom-node bytes и CLI closure не меняются;
повторный guarded CLI/install не требуется на этих unchanged inputs.

| Фактическое наблюдение | Результат |
| --- | --- |
| Source rate: 30 попыток, по 10 на клиента | 22 приняты, 8 отклонены; серия 328.97 мс, холодный интервал 6011.89 мс |
| Та же третья TLS identity с другого фактического IP | Полный ответ 503 тестового обработчика; поддельный XFF с прежним IP не мешает приёму |
| Source concurrency | 8 активных обработчиков: 3+3+2; две следующие попытки с того же IP получают 429 |
| Другой IP при восьми занятых обработчиках первого IP | Приём подтверждён с той же TLS identity; всего 9 передач в upstream, после завершения active = 0 |
| Восстановление после обеих групп | PASS; корректные запросы снова принимаются |

Collector и отдельный readback сверили 9 текущих исходников, 6 копий стенда,
5 публичных сертификатов, конфигурацию и неизменность runtime до/после запуска.
Process/container identities сохранены; 135 строк access log соответствуют закрытой
metadata-схеме. Два собственных контейнера удалены; отдельная проверка по точным ID
подтвердила их отсутствие. Synthetic keys/CSRs удалены; чужие ресурсы не затронуты.
Ресурсный слот освобождён. Исходники во время физического прогона не менялись.
Независимые security/source и release/evidence reviews завершены без существенных
P0–P2 замечаний; второй reviewer проверил фактические receipt/probes/access logs
и текущие source hashes, не подменяя эти доказательства повтором unit tests.

- Receipt SHA-256: `f17379631ca8b50962e5449c6bf98f00c4c855835310893594f0bef93d08671a`.
- Probes SHA-256: `af47b62dc2a8076d3ea7ad748959e93b2c6d871f2271a26459d07bb443f2fae2`.
- Config SHA-256: `c23ac6420603b788132243fe2a9ff7f3503d015a197438dd10b12227f34f37cc`.

`notTested=[]` относится только к названным 77 локальным сценариям: внешняя
недоступность sidecar, реальная Viva/БД и production readiness этим не доказаны.
Общерепозиторный lint, frontend/modular builds и guarded CLI повторно не запускались:
проверены затронутые JS-файлы и весь Partner suite; остальные inputs не менялись.

Инфографика — новая страница `Independent source IP limits` в
[existing drawio](assets/partner-game-membership-ingress-evidence.drawio).
Native exporter ранее недоступен; используется XML-only fallback, PNG/visual QA
не заявляется выполненным. Никаких новых зависимостей или renderer-контейнеров.

## Что это не закрывает и вопросы к владельцам

- **P0:** Production effective-config/application/worker-generation verifier,
  external direct-sidecar denial и revoke proof всё ещё обязательны;
  `UNSUPPORTED_INGRESS_ADAPTER` остаётся безусловным stop.
- **P0:** Как боевые сертификаты связываются с HMAC client identity; несколько
  сертификатов одного партнёра должны сохранять согласованный общий client budget.
  Стенд использует три разных клиента и не подтверждает rotation-policy.
- **P1:** Сколько партнёров и backend workers делят один NAT/egress IP; достаточно
  ли общих 5r/s + burst 20 / 8 concurrent requests для пилота, включая operation polling.
- **P1:** Retry/backoff по 429, общий retry budget, метрики отказов и ответственный
  за согласование новых источников. Лимиты не повышаются автоматически по retry.
- **P1:** Боевые client/source identifiers должны быть наблюдаемы без PII; отдельный
  owner задаёт privacy-safe корреляцию/retention, а не копирует synthetic fixture logs.

Generator сам оставляет `SOURCE_LIMIT_INDEPENDENT_PROOF` unresolved: создание
конфига не доказывает его выполнение. Local collector может закрыть только свою
фактически выполненную матрицу из 77 сценариев, не production verifier или
эксплуатационную политику партнёра.
