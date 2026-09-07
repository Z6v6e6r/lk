# Короткий путь frontend-фичи

До: один subscription-enforcement job для каждого diff, подготовка и публикация
вручную, отдельные разрешения на merge/push/deploy; frontend delivery не фиксировал
полный предыдущий комплект и результат browser smoke автоматически.

После включения: готовый небольшой PR → применимый CI → bot запрашивает разрешённое
GitHub protected auto-merge → CI интегрированного main → проверка всего installed..source
→ `build:prod` → `release:preflight:prod` + `package:upload:prod` → существующий
`deploy-lk.sh prod` в новый статический каталог → атомарная замена `lk-frontend-releases/current` →
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
   `/var/www/html/lk-frontend-current` принадлежит root и неизменно указывает на
   `lk-frontend-releases/current`. Publisher переключает только `current` внутри store. Nginx направляет туда
   только 16 точных URL `/lk/...`; прежний alias `/lk/` и backend-location остаются
   неизменными. URL клиентов и Tilda loader не меняются. DEV остаётся на `lk-reserve-89`;
   имеющиеся дополнительные DEV/academy URL на primary также не удаляются.
   Подготовка кандидата и rehearsal описаны ниже. Установить его можно только после
   проверки свежего nginx/artifact preimage, baseline smoke и scoped SSH permissions
   по схеме forced-command ниже.
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

Однократное применение: под согласованным writer boundary сверить nginx и все
artifact preimages; установить baseline/new symlink; проверить nginx-кандидат;
guarded заменить exact config и выполнить nginx -t до reload; затем проверить
16 публичных hashes, сохранённые legacy URL и браузерный сценарий. При ошибке вернуть
только exact nginx source и reload. Чужой nginx drift запрещает rollback. Legacy
каталог, baseline и candidate artifacts не удаляются. Это последовательность для
отдельного утверждения, а не разрешение выполнить её из offline builder.

## Static-only SSH installation boundary

Выделенный `lk-frontend` UID не получает sudo, привилегированные группы или write в
`/var/www/html`. Root владеет внешней ссылкой, home, SSH policy/authorized key и
`/usr/local/libexec/lk-frontend/frontend-release-remote.py`; UID владеет только
`/var/www/html/lk-frontend-releases`. Public link имеет точный относительный target
`lk-frontend-releases/current`, а store/current — только имя retained release.

Owner устанавливает проверенный `scripts/ssh/lk-frontend.conf` в действующий include
sshd, проверяет полный `sshd -t` и effective `sshd -T -C user=lk-frontend,...` до reload.
Public key хранится в root-owned `/etc/ssh/authorized_keys/lk-frontend` с `restrict`;
родитель 0755, файл 0644. Home root-owned 0755. У helper и всех родителей root ownership
и отсутствие group/other write; helper 0444, каталог 0555. Private key не выводить,
не коммитить и не помещать в build artifacts. Генерация/установка ключа — только
отдельно согласованная часть owner activation.

ForceCommand запускает установленный Python helper с `-I -B`; разрешён ровно
`lk-frontend-v1 <sha256 установленного helper>`. CLI проверяет hash и ownership до
чтения запроса. Клиентский Python/shell, SFTP, forwarding, PTY и user-rc запрещены.
`inspect/acquire/upload/publish/rollback/finish` принимают JSON через stdin. Upload
разрешён только для одного из 16 файлов внутри candidate действующей uploading lease;
проверяются token, size (до 32 MiB на файл), SHA-256, exclusive/no-follow запись.
Previous release, legacy namespace и файлы вне store через протокол недоступны для записи.

`deploy-lk.sh` сохраняет текущие inventory/provenance проверки и legacy transport.
Только standard route устанавливает `DEPLOY_FRONTEND_TRANSPORT=forced-command-v1`
и передаёт lease token адаптеру `frontend-upload.mjs`; arbitrary mkdir/scp не вызываются.
Изменение helper требует owner-reviewed установки нового exact hash и policy pin.

`npm run test:frontend-static-access`: локальный одноразовый Linux fixture с настоящим
sshd; временные ключи остаются внутри контейнера. Запуск network=none, без опубликованных
портов, 1 CPU / 512 MiB / 128 PID, 120 s run limit; image build имеет 180 s timeout и
ставит test-only python3/openssh-server из Debian на pinned Node base. Удаляются только
собственные container/tag/context. Проверяются реальные запреты shell/forwarding/PTY,
права dedicated UID и upload/publish/rollback. Этот check обязателен для release diff.
