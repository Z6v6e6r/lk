# Короткий путь frontend-фичи

До: один subscription-enforcement job для каждого diff, подготовка и публикация
вручную, отдельные разрешения на merge/push/deploy; frontend delivery не фиксировал
полный предыдущий комплект и результат browser smoke автоматически.

После включения: готовый небольшой PR → применимый CI → bot запрашивает разрешённое
GitHub protected auto-merge → CI интегрированного main → проверка всего installed..source
→ `build:prod` → `release:preflight:prod` + `package:upload:prod` → существующий
`deploy-lk.sh prod` в новый статический каталог → атомарная замена ссылки `lk-frontend-current` →
HTTP hash/cache readback и Chromium/WebKit smoke → receipt. Ошибка вызывает возврат
точного предыдущего комплекта, его повторный smoke и неуспешный результат workflow.
Неизвестные байты или неполное восстановление сохраняют lease и блокируют следующий выпуск.

## Применимые проверки

`npm run ci:delivery:route` получает immutable `BASE_SHA` и `EXPECTED_HEAD_SHA`.
PR использует merge-base..head; push — before..head. Изменённые и удалённые пути,
переименования и Git file modes учитываются без разбора имён по пробелам.

- Docs: diff/secret/PII/artifact scan, workflow/route/release regression tests.
- Frontend presentation: те же проверки, lint/typecheck, prod/dev build, быстрые
  существующие subscription/security/split/referral regressions и UI/loader checks.
- Business: frontend плюс применимые backend/Node-RED fixtures; неизвестное
  исполняемое поведение консервативно получает расширенный набор.
- Node-RED/release/root config: полный существующий CI, включая Docker custody.

CSS в `src` и изменение буквальных текстов/class/title/aria-label/placeholder
на native HTML JSX-элементах в `src/components` могут попасть в standard frontend.
Изменения JS-выражений, условий, imports, handlers, URL, props custom components,
loader, build, workflows и неизвестные пути не могут. Названия subscriptions/payments
и PR labels ничего не разрешают. Человеческая FAST/SAFE классификация шире автоматики:
не покрытая детектором операция получает business/critical checks и обычный review.
Это ограниченный пилот, не обещание универсального анализа семантики.

Итоговый `LK1 exact-head enforcement gate` всегда выполняет `Required delivery result`:
требуемая проверка должна иметь outcome `success`; неприменимая — `skipped` и запись
`NOT_APPLICABLE`. Failure/cancelled/missing/неожиданный skip не дают зелёный итог.
Существующий required-check name сохранён. PR CI не получает production secrets.
Проверки не зависят от live flow, provisioned DEV и subscription runtime readiness.

CI измерен до изменения: run `34018672265`, exact head `32e7e9e6b9e4cc36fd4b207e8c51a1c52c17254a`,
6 сентября 2026: job 212 с, subscription regressions 2 с, DEV fixtures 3 с,
typecheck 14 с, lint 35 с, build 76 с. Быстрые полезные регрессии сохранены.
Это один замер, не статистика ускорения. Полный одинаковый набор не повторяется при
production публикации: push CI проверяет интеграцию; build с production public config,
проверка комплекта и smoke имеют другие входы и назначение.

## Однократные действия владельца

Выполнить одним согласованным запуском настройки, после независимого review этого PR:

1. Объединить инфраструктурный PR обычным критическим порядком. Этот PR не может
   пройти собственный standard route. Включить защиту `main`: обязательный
   `LK1 exact-head enforcement gate` только от GitHub Actions, запрет прямого/force push
   и обхода bot, требуемый review изменений CI/release/policy (CODEOWNERS или ruleset).
   Включить repository auto-merge и squash merge. Применимость FAST не отменяет защиты.
2. Подготовить bootstrap существующего prod на `lk-primary-147`. Каталог
   `/var/www/html/lk` и его legacy URL сохраняются: academy prod/dev, index.html,
   assets, дополнительные шрифты и резервные копии не входят в переключаемый комплект.
   Отдельный реальный каталог `/var/www/html/lk-frontend-releases/<full-source-sha>-<16-hex-id>`
   содержит ровно 11 prod bundles, release.json и четыре WOFF2. Ссылка
   `/var/www/html/lk-frontend-current` указывает на этот комплект. Nginx направляет туда
   только 16 точных URL `/lk/...`; прежний alias `/lk/` и backend-location остаются
   неизменными. URL клиентов и Tilda loader не меняются. DEV остаётся на `lk-reserve-89`;
   имеющиеся дополнительные DEV/academy URL на primary также не удаляются.
   Подготовка кандидата и rehearsal описаны ниже. Установить его можно только после
   проверки свежего nginx/artifact preimage, baseline smoke и scoped SSH permissions.
   Прямые legacy `deploy:prod` после активации не обслуживают новый current path:
   стандартный маршрут использует existing upload только с exact staging destination.
   Другие writers допускаются лишь по отдельно определённому согласованному пути.
3. Создать environment `frontend-production`, разрешающий только main, без повторного
   reviewer prompt после этой настройки; scoped bot token `LK_FRONTEND_MERGE_TOKEN`
   (merge через bot нужен для push-trigger CI) и static-only `LK_FRONTEND_SSH_KEY`.
   PR job использует только trusted main scripts и получает merge token лишь в последнем шаге.
   Установить owner-controlled vars: `LK_FRONTEND_POLICY_SHA` = утверждённый infrastructure
   main SHA; `LK_FRONTEND_BUILD_ENV_JSON` = публичные REQUIRED_BUILD_ENV_KEYS (без секретов);
   `LK_FRONTEND_ASSET_BASE`; `LK_FRONTEND_SSH_CONFIG` с alias `lk-primary-147`,
   identity `~/.ssh/lk-frontend`, выделенным пользователем и strict host checking;
   `LK_FRONTEND_SSH_KNOWN_HOSTS` из проверенного host key.
4. Задать `LK_FRONTEND_SMOKE_URL`, `LK_FRONTEND_SMOKE_SELECTOR`,
   `LK_FRONTEND_SMOKE_OPEN_SELECTOR` и `LK_FRONTEND_SMOKE_RESULT_SELECTOR` для
   существующего публичного сценария загрузки/чтения, например открытия формы входа.
   Smoke блокирует POST/PUT/PATCH/DELETE, не входит в аккаунт и не оформляет покупку.
   Проверить selectors на реальной Tilda странице. Затем установить repository variable
   `LK_STANDARD_FRONTEND_ENABLED=true`. До этого оба jobs выключены.

Activation SHA pin защищает конструкцию механизма; изменение его исходников требует
нового review и обновления pin владельцем. Даже после activation installed..source
проверяется целиком. Накопленный debit/backend/release diff останавливает standard release;
для первичного baseline нужен отдельно согласованный критический выпуск, а не подмена SHA.
Отсутствие configuration/protection/access останавливает выпуск, не PR-разработку.

## Наблюдение и остановка

Для фичи достаточно в PR: владелец; аудитория; наблюдаемый результат; сигнал остановки;
как остановить. Цель пилота — выпуск в тот же рабочий день и минуты ожидания после готовности.
Измерять ready timestamp, CI completion, merge и release observation; не объявлять
ускорение или production readiness до реальных измерений.

Workflow сохраняет `frontend-release-result.json` на 30 дней, включая источник, предыдущую
версию/диапазон, время и конкретную причину отказа. Host хранит receipt и предыдущий комплект.
Отмена workflow не освобождает lease: при прерывании провести recovery под тем же lock,
проверив actual source/candidate и hashes; вручную не удалять lease ради следующего deploy.
Новые releases не auto-cancel. При smoke failure scripted rollback касается только static files.
После успешного smoke поздний ручной rollback — отдельная конкретная операция владельца;
при неизвестной совместимости он не выполняется автоматически.

Для остановки следующих выпусков выключить `LK_STANDARD_FRONTEND_ENABLED`. Не прерывать
работающий publish/rollback без восстановления его lease. Существующий feature flag
использовать только если он нужен фиче; выключение не отменяет сделанные внешние операции.

## Node-RED и подписки

Frontend route не импортирует flow, не перезапускает Node-RED и не работает с MongoDB.
Node-RED остаётся на source-driven focused patcher: fresh live preimage при реальном apply,
exact graph, lock/lease, защита чужих изменений, guarded rollback. Wide prepare-147/exports
остаются в карантине. Unified subscription graph нельзя заменять partial wrappers.
Существующие packet/contract/plan инструменты фиксируют source/candidate/results/blockers;
не нужно вручную переписывать неизменившиеся доказательства. Одно критическое согласование
охватывает определённую последовательность и recovery, пока source/scope/условия не меняются.
Один продукт и один рабочий сквозной сценарий достаточны для первого ограниченного выпуска.

## Offline static bootstrap candidate

`release:frontend:bootstrap-candidate` не имеет apply/reload/SSH-команды. Она читает
локальные копии source nginx и полного установленного комплекта, проверяет SHA-256
каждого из 16 файлов и сохраняет private candidate вне Git:

```bash
npm run release:frontend:bootstrap-candidate -- \
  /private/bootstrap/nginx.source.conf <source-sha256> \
  /private/bootstrap/installed.json /verified/build/dist /verified/build/src/fonts \
  /private/bootstrap/new-candidate
```

`installed.json`: `{ "source": "<full-source-sha>", "version": "<installed-version>",
"hashes": { "bundle.js": "<sha256>", "...all 16 exact paths...": "<sha256>" } }`.
Использовать independently read-back hashes, а не хеши заново собранного кандидата.
Родитель вывода должен существовать, принадлежать текущему пользователю и иметь mode
0700. Существующий/частичный output не перезаписывается. `bootstrap.json` создаётся
последним; source/candidate nginx имеют mode 0600. Manifest копируется byte-for-byte:
baseline `94cb4bb` нельзя переименовать в текущий main.

Результат: `release/`, `nginx.source.conf`, `nginx.candidate.conf`, `bootstrap.json`.
Кандидат заменяет только существующий exact release.json block на 16 exact locations.
Каждый location сохраняет cache/CORS, допускает GET/HEAD/OPTIONS, запрещает запись и
отключает open_file_cache, чтобы открытый inode не переживал переключение current.
Неизвестная структура, duplicate exact routes и source drift блокируют генерацию.
Ни source nginx, ни private результаты нельзя коммитить или загружать в PR artifacts.

`npm run test:frontend-static-nginx` проверяет настоящий pinned nginx 1.24.0 в
одноразовом Linux/amd64 container с network=none, без опубликованных портов и с
read-only fixture mounts. Проверяются старый/новый/восстановленный комплект, все 16
URL, headers, legacy academy/assets/index/fonts, backend path, OPTIONS/POST и 404.
Этот тест обязателен в CI только для изменения самого release-механизма.

## Bootstrap execution bundle

Runtime bundle готовится только по свежему (не старше 15 минут) read-only snapshot
целевого хоста. Сначала clean committed checkout создаёт отдельный audit kit без импорта
repository modules или `node_modules`:

Production entry не проходит через `npm`: родительский npm/Node успел бы обработать
`NODE_OPTIONS` до внутреннего `env -i`. Из clean checkout exact builder сначала извлекается
из текущего commit системным Git в новый private каталог. Затем absolute Node, SHA которого
зафиксирован и повторно проверен непосредственно перед запуском, получает только явно
заданное чистое окружение:

```bash
/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  /bin/bash -c '
set -euo pipefail
readonly REPOSITORY="$1" EXPECTED_COMMIT="$2" EXPECTED_BUILDER_SHA256="$3"
readonly EXPECTED_NODE_SHA256="$4" AUDIT_OUTPUT="$5"
readonly -a GIT=(/usr/bin/git --no-replace-objects -c core.fsmonitor=false
  -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null
  -c core.excludesFile=/dev/null -c protocol.file.allow=never)
[[ -z "$("${GIT[@]}" -C "$REPOSITORY" status --porcelain=v1)" ]]
[[ "$("${GIT[@]}" -C "$REPOSITORY" rev-parse HEAD)" == "$EXPECTED_COMMIT" ]]
[[ "$("${GIT[@]}" -C "$REPOSITORY" show
  "$EXPECTED_COMMIT":scripts/prepare_frontend_bootstrap_execution.mjs |
  /usr/bin/shasum -a 256 | /usr/bin/awk "{print \$1}")" == "$EXPECTED_BUILDER_SHA256" ]]
[[ "$(/usr/bin/shasum -a 256 /usr/local/bin/node |
  /usr/bin/awk "{print \$1}")" == "$EXPECTED_NODE_SHA256" ]]
PRIVATE_BUILDER=$(/usr/bin/mktemp -d /private/tmp/lk-frontend-builder.XXXXXX)
"${GIT[@]}" -C "$REPOSITORY" show
  "$EXPECTED_COMMIT":scripts/prepare_frontend_bootstrap_execution.mjs > "$PRIVATE_BUILDER/builder.mjs"
/bin/chmod 0400 "$PRIVATE_BUILDER/builder.mjs"
[[ "$(/usr/bin/shasum -a 256 "$PRIVATE_BUILDER/builder.mjs" |
  /usr/bin/awk "{print \$1}")" == "$EXPECTED_BUILDER_SHA256" ]]
/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  LK_FRONTEND_REPOSITORY="$REPOSITORY" LK_FRONTEND_BUILDER_COMMIT="$EXPECTED_COMMIT" \
  LK_FRONTEND_BUILDER_SHA256="$EXPECTED_BUILDER_SHA256" \
  LK_FRONTEND_NODE_PATH=/usr/local/bin/node LK_FRONTEND_NODE_SHA256="$EXPECTED_NODE_SHA256" \
  /usr/local/bin/node "$PRIVATE_BUILDER/builder.mjs" --audit-kit "$AUDIT_OUTPUT"
printf "%s\n" "$PRIVATE_BUILDER"
' bootstrap /absolute/clean/checkout FROZEN_COMMIT \
  FROZEN_BUILDER_SHA256 FROZEN_NODE_SHA256 \
  /private/bootstrap/new-audit-kit
```

`launcherSha256` и `auditSourceSha256` из результата фиксируются вне переносимого каталога.
После копирования на хост launcher и audit source должны быть root-owned, unaliased и иметь
режимы 0500/0400. Перед первым запуском SHA launcher сверяется с отдельно зафиксированным
значением. Затем launcher открывает себя, `/usr/bin/node` и audit source один раз, проверяет
custody и SHA тех же FD, очищает окружение и делает `fexecve`:

```bash
/root/frontend-bootstrap-audit/launcher audit LAUNCHER_SHA256 \
  /root/frontend-bootstrap-audit/audit.mjs AUDIT_SOURCE_SHA256
```

`audit_frontend_bootstrap_host.mjs` фиксирует в snapshot SHA фактически исполненных
launcher/Node/source, machine
identity, topology/stat/hash nginx config, каталогов, Node/curl/nginx/systemctl и системных
утилит, полный установленный комплект, preserved legacy и отсутствие старого bootstrap
state. Snapshot и private candidate передаются локальному builder:

Тот же verified committed builder и заново проверенный absolute Node создают execution bundle:

```bash
/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  /bin/bash -c '
set -euo pipefail
readonly REPOSITORY="$1" EXPECTED_COMMIT="$2" EXPECTED_BUILDER_SHA256="$3"
readonly EXPECTED_NODE_SHA256="$4" PRIVATE_BUILDER="$5"
[[ "$(/usr/bin/shasum -a 256 /usr/local/bin/node |
  /usr/bin/awk "{print \$1}")" == "$EXPECTED_NODE_SHA256" ]]
[[ "$(/usr/bin/shasum -a 256 "$PRIVATE_BUILDER/builder.mjs" |
  /usr/bin/awk "{print \$1}")" == "$EXPECTED_BUILDER_SHA256" ]]
/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C \
  LK_FRONTEND_REPOSITORY="$REPOSITORY" LK_FRONTEND_BUILDER_COMMIT="$EXPECTED_COMMIT" \
  LK_FRONTEND_BUILDER_SHA256="$EXPECTED_BUILDER_SHA256" \
  LK_FRONTEND_NODE_PATH=/usr/local/bin/node LK_FRONTEND_NODE_SHA256="$EXPECTED_NODE_SHA256" \
  /usr/local/bin/node "$PRIVATE_BUILDER/builder.mjs" "$6" "$7" "$8"
' bootstrap /absolute/clean/checkout FROZEN_COMMIT \
  FROZEN_BUILDER_SHA256 FROZEN_NODE_SHA256 \
  /private/tmp/lk-frontend-builder.XXXXXX /private/bootstrap/offline-candidate \
  /private/bootstrap/host-snapshot.json /private/bootstrap/new-execution
```

Production builder запускается с очищенным окружением, использует только Node built-ins,
требует clean committed checkout и до чтения входов сверяет всю рекурсивную execution
closure с точным Git commit. Он не загружает repository modules или `node_modules`, повторно
строит nginx candidate из source, сравнивает байты, дважды собирает одинаковые статические
Linux launcher и guard в pinned network-disabled Docker image и
отклоняет нерепродуцируемый ELF. Новый каталог создаётся вне repository: все каталоги
0700, `payload/launcher`, `payload/guard` и `payload/runtime.mjs` 0500, остальные файлы 0400.
`manifest.json` связывает exact audit producer, host, repository sources, launcher/guard
build, runtime source, offline plan, source/candidate nginx и все payload hashes. Его SHA
определяет единственный допустимый root-путь
`/root/.padlhub-frontend-bootstrap-<manifest-sha256>`.

Guard запускается только через independently pinned `payload/launcher`: launcher проверяет
root custody и внешний SHA exact guard FD, затем делает `fexecve`. Guard повторно проверяет
себя, открывает exact Node/runtime через `O_NOFOLLOW`, очищает окружение и запускает Node по
проверенному FD. Каждый runtime child получает отдельный process group; при ошибке, выходе с
живым потомком или hard timeout guard убивает и reap-ит всю группу до освобождения locks.
`preflight` выполняет read-only `inspect` до создания lock-файлов.
Остальные действия держат global bootstrap и общий nginx-writer flock, а после durable
инициализации также release flock. Существующий lock с неверным owner/mode/type/nlink
отклоняется без chmod/chown.

Runtime повторно проверяет bundle и host identity, пишет global/release lease и durable
INTENT до публикации. Release root с blocking lease публикуется одним rename; baseline
создаётся через O_EXCL, hard-link publication и fsync, `current` — exact relative symlink.
Guard меняет только известный nginx source/candidate: `renameat2(RENAME_EXCHANGE)`, затем
сверяет displaced inode/hash и при расхождении выполняет обратный exchange. После этого
runtime выполняет `nginx -t`, journal-before-reload, reload и readback 16 URL через
loopback origin и публичный маршрут, включая CORS/cache, OPTIONS, candidate POST 403,
source POST 405 и preserved legacy.

Действия guard принимают явный `--authority`: `apply` — `CONFIRM_EXACT_BOOTSTRAP`,
`recover` — `CONFIRM_EXACT_BOOTSTRAP_RECOVERY`, `rollback` —
`CONFIRM_EXACT_BOOTSTRAP_ROLLBACK`, `finalize` — `CONFIRM_EXACT_BOOTSTRAP_FINALIZE`.
`apply` заканчивается durable `SERVER_SUCCESS` и сохраняет lease. После отдельного
браузерного smoke оператор выбирает `finalize` либо `rollback`; только `finalize` пишет
terminal SUCCESS и снимает lease. `recover` продолжает durable rollback intent, известную
инициализацию или candidate state; неизвестный config/current/release/journal drift
оставляет leases. Terminal receipt fsync-ится до снятия lease, поэтому повторный recover
безопасно завершает частично снятую блокировку. Legacy каталог и retained release не
удаляются.

`npm run test:frontend-bootstrap-runtime` проверяет state machine, source cross-binding и
crash recovery, включая partial temp, hardlink orphan и невозможный candidate/current state.
`npm run test:frontend-bootstrap-guard` в pinned Docker проверяет воспроизводимую static
сборку, independent launcher, подменённый guard, clean-env exact-FD audit/runtime execution,
process-group cleanup, lock custody, atomic exchange и отказ без изменения current config
при неверном preimage. Execution bundle не разрешает upload, nginx replace, reload или
другую live mutation.
