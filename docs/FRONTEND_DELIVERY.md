# Короткий путь frontend-фичи

До: один subscription-enforcement job для каждого diff, подготовка и публикация
вручную, отдельные разрешения на merge/push/deploy; frontend delivery не фиксировал
полный предыдущий комплект и результат browser smoke автоматически.

После включения: готовый небольшой PR → применимый CI → bot запрашивает разрешённое
GitHub protected auto-merge → CI интегрированного main → проверка всего installed..source
→ `build:prod` → `release:preflight:prod` + `package:upload:prod` → существующий
`deploy-lk.sh prod` в новый статический каталог → атомарная замена ссылки `/lk` →
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
2. Подтвердить bootstrap существующего prod на `lk-primary-147`: только 11 prod bundles,
   `release.json` и четыре fonts из `scripts/frontend-release-remote.py`; никаких DEV,
   academy, index.html или чужих файлов. DEV остаётся на `lk-reserve-89`.
   Любые дополнительные маршруты сначала изолировать отдельным согласованным изменением.
   Сохранить проверенный текущий комплект как реальный каталог
   `/var/www/html/lk-frontend-releases/<full-source-sha>-<16-hex-id>` и сделать `/var/www/html/lk`
   ссылкой на него. Проверить hash/public readback, полный sourceCommit/sourceDirty=false,
   совместимость Tilda loader и `no-cache`/`no-store` для release.json. Проверить
   atomic switch/restore на синтетическом host rehearsal и права выделенного SSH пользователя
   только на эти static paths. Все последующие writers обязаны уважать `.lease.json`.
   Bootstrap не выполняется этой задачей; неизвестный installed source — стоп выпуска.
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
