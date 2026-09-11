# Partner API: несовместимость Nginx, 10 сентября 2026

Статус: **причина отказа установлена; совместимость и пункт 1 ещё не закрыты**.
Условия допуска не ослаблены. Production verifier сохраняет
`UNSUPPORTED_INGRESS_ADAPTER`; deploy/activation не выполнены.

## Наблюдения

- Чтение 08:19:45 UTC подтвердило `/etc/nginx/nginx.conf:33`:
  `ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3`. SHA основного файла совпадает
  с историческим `48c6a4ec…`. Причина отказа — `ssl_protocols / ARGUMENTS_UNSUPPORTED`.
- Полный scoped snapshot: **08:27:46.776–08:27:47.149 UTC**, SSH exit 0, stderr пуст,
  14 точных config paths, skipped include targets 0. Root ownership, same-FD/name/
  identity/hash и host/process-set проверки до/после завершены. Это стабильные
  границы наблюдения, не атомарный snapshot или proof загруженной конфигурации.
- 11 файлов совпали с историческим снимком, `sites-enabled/padlhub.su` изменился.
  Два новых subscription guard-файла отличаются от файлов в fetched `origin/main`.
  Actual hashes и `sourceMatches: false` сохранены отдельно; старые/source pins
  не изменены. Source equivalence не заявляется.
- Структурный обход показывает 14 server blocks. Для обеих wildcard TLS families
  (`443`, `[::]:443`) первый default-кандидат выбран **неявно** и переопределяет TLS
  на `TLSv1.2 TLSv1.3`. Поэтому root-строка **не доказывает фактическую доступность
  TLS 1.0/1.1**.
- У этого кандидата не доказаны exact declarations пяти header controls:
  `client_header_buffer_size`, `large_client_header_buffers`, `client_header_timeout`,
  `ignore_invalid_headers`, `underscores_in_headers` (`MISSING_OR_DUPLICATE`).
  Параметры `listen` не соответствуют поддерживаемому профилю; их значения не
  экспортировались. Это структурная проекция, не native/effective runtime proof.

Начальные scoped reads остановились на обновлённом include-наборе и сравнении
нового файла с source expectation. Сохранены отдельные failed receipts. Последнее
полное чтение один раз повторено после SSH connect timeout, до запуска helper.
Новые произвольные include-цели, keys/certs/env/client logs не читались.

## Диагностика checker

`readLocalSharedNginxRejection(error)` возвращает замороженную проекцию только для
настоящей ошибки checker из внутреннего WeakMap: прежний code, fileIndex, line,
context `HTTP`, директива из закрытой source-owned таблицы (иначе `UNKNOWN`) и
причина `BLOCK_UNSUPPORTED`, `DIRECTIVE_UNSUPPORTED` или `ARGUMENTS_UNSUPPORTED`.
Аргументы, raw tokens, пути и содержимое строки не экспортируются. Подделка или
копирование ошибки не создаёт запись. Успешная схема и все предикаты неизменны;
проекция не создаёт preparation, host receipt или разрешение на выпуск.

## Необходимый выбор для продолжения

Одного разрешения legacy TLS в checker недостаточно: останутся explicit-default,
header и listener ограничения. Нельзя заменить unconditional production stop
локальным флагом: нужны operator/application/external-probe evidence.

| Вариант | Что подготовить | Влияние |
| --- | --- | --- |
| Отдельный HTTPS listener на 8443 | Изолированные TLS/default/header настройки API, URL с `:8443` | Сохраняет существующий 443; требует проверки порта и изменения API binding |
| Прежний общий 443 | Точный shared-default/TLS/header/listener diff и проверки остальных сайтов | Меняет общие условия обработки соединений; требуется согласование влияния |
| Выделенный IP и 443 | Exact IP listener, DNS/PKI binding, изолированные настройки | Сохраняет URL без порта; нужен выделенный IP и настройка DNS |

Варианты пока только планируются. Новый порт/IP не выбран; конфигурация на сервере
не менялась. Запрос выбора размещения не является разрешением на deploy.

Решение принято 2026-09-11: выбран **общий 443**. Обоснование, влияние, оставшиеся
блокеры и порядок живых операций — в
[PARTNER_GAME_MEMBERSHIP_INGRESS_LAYOUT_443.md](PARTNER_GAME_MEMBERSHIP_INGRESS_LAYOUT_443.md).
Живые операции по-прежнему не выполнялись.

## Проверки и сохранность

- Targeted SharedAdapter + DialectDiagnostics: **120/120 PASS**.
- Full sequential Partner: **911 tests / 887 PASS / 24 FAIL / 0 skipped**, actual
  exit 1, 33.886 s. Exact failing-name set совпал с прежним 904-test baseline.
  Первоначальные дополнительные 26 `listen EPERM` исчезли в разрешённом окружении
  с собственными loopback fixtures. Release gate остаётся RED.
- Root lint: exit 0, **0 errors / 387 warnings**. Build остановлен env guard:
  отсутствуют 17 production VITE inputs; env/секреты не копировались.
- Private helper: syntax; 5 process-set, 24 compatibility/projection, 43 scope/
  redaction, 13 scanner/path, 7 fd/race assertions; structural-default include/
  implicit/explicit/redaction checks. Specialist review закрыл до исполнения
  соответствующих SSH-режимов два дефекта: late worker-set recheck и root-only
  fallthrough. В финальной проверенной delta существенных открытых замечаний нет.
- Native `nginx -t/-T`, TLS/HTTP probes, reload/restart, installation, certificate/
  key/env/client-log reads, Mongo/Viva mutation: **не выполнялись**.

Private receipts: `/private/tmp/partner-nginx-step1-20260910/`, вне Git. Прежняя
ветка/worktree сохранена, исходный HEAD `f66ec8154c8f417733c74ee8adf2bf3c04d94789`.
Fetched `origin/main`: `d0e8394f150bdf251055baaeb31b97f777ede8ce`; merge-base:
`df03b4ceaa196c8ce8f8a5622dad44eb61b9f9f3`. Main не интегрирован.
