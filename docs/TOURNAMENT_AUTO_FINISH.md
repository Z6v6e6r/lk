# Автоматическое завершение через три часа

Владелец реализации — LK tournament backend; пользователи — организаторы и участники.
Результат — закрытый турнир и итоги по сохранённым результатам через три часа после
фактического серверного запуска. Публикация по расписанию не запускает таймер.

## Поведение

- Generic Americano/Mexicano: первый успешный create с генерацией игровой сетки
  фиксирует серверный `params.autoFinish` версии 1 (`startedAt`, `deadlineAt`, `session`).
  Дата браузера и повторное создание не меняют этот старт. Созданный локально турнир
  становится управляемым только при отправке открытого протокола на сервер.
  Уже завершённый импорт не запускается повторно.
- FPR: ready-протокол не запущен. Первый подтверждённый сервером `start_round` или
  `score` с запуском подготовленного раунда фиксирует старт. Спортивный `endsAt`
  остаётся без изменений; трёхчасовой административный дедлайн хранится отдельно.
- После дедлайна обычный ввод отклоняется сервером, даже если фоновая задача ещё
  не успела обновить статус. Финализация выполняется независимо от браузера.
- Generic: пересчитываются только сохранённые матчи с полным счётом. Матчи без счёта
  сохраняются без искусственных очков. При отсутствии завершённых матчей standings,
  totals и playerLogs пусты: рейтингового результата нет. BYE действует по существующим
  правилам полного раунда. Первая дата завершения — дедлайн; `processedAt` — время обработки.
- FPR завершается существующим `finish` reducer: неполный общий раунд исключается целиком,
  меньше шести закрытых раундов означает `incomplete`. Generic rating flags остаются false.
  Спортивные правила/формулы/допуск к лиге не меняются. Дата FPR finish — время обработки,
  поскольку reducer запрещает команды раньше уже записанного audit; дедлайн остаётся в lifecycle.
- Generic resume сохраняет сетку, очищает завершение и создаёт новую сессию с дедлайном
  через три часа после возобновления. Старый deadline/job или payload прошлой сессии
  не может закрыть/перезаписать её. FPR не поддерживал resume; этот контракт сохранён.
- Поздние generic офлайн-результаты остаются в IndexedDB с `reviewRequired=true`.
  Фоновая отправка остановлена; организатор видит предупреждение. Ручная отправка
  остаётся явным действием и подчиняется серверной проверке сессии. Для переноса
  результатов в возобновлённый турнир нужно проверить и сохранить их в новом сеансе.
- Для ФПР поздние команды сохраняются отдельно в localStorage и включаются в JSON-экспорт;
  они не пересылаются автоматически и не теряются при обновлении серверного протокола.
- Старые записи без server lifecycle не подбираются. Месячная финализация делегирует
  управляемые записи новому worker, включая возобновлённые турниры.

## Конкурентные записи и восстановление

Все результаты, resume и finalizer используют CAS по снимку исходных полей документа,
включая `_id`, `updatedAt`, params, rounds, summary и standings. Сохраняются уже установленные
FPR revision/monthly guards. Изменение трансляции тоже приводит к конфликту, а не к потере
её состояния. Повторный create управляемого протокола — атомарный no-op с ответом 409.

Worker читает все страницы due cursor пакетами по 100, поэтому пропущенные/неоднозначные
записи не занимают вечные первые 100 мест. Два worker могут работать одновременно:
ровно один CAS выигрывает; остальные подбирают актуальное состояние на следующем проходе.
Перед записью сохраняется приватный EJSON preimage, после — выполняется readback.
После рестарта worker подбирает просроченные управляемые протоколы.

Триггер остановки — ошибка финализации/readback или неожиданный конфликт источника.
Остановить новые фоновые записи можно остановкой timer/service и выключением
`TOURNAMENT_AUTO_FINISH_ENABLED`; завершённые турниры это не открывает.

## Изменяемые Node-RED границы

Публичные маршруты остаются прежними:
`POST /lk/tournaments/americano`, `POST /lk/tournaments/americano/results`,
`GET /lk/tournaments/americano/history`.

`scripts/patch_tournament_auto_finish.mjs` оборачивает только три существующие функции:

| ID | Роль |
|---|---|
| `4f0f1ce8189a9e8c` | prepare/create, первый серверный старт и защита от повторного create |
| `2e70b2e547e77c00` | results/recalculate, deadline/session и CAS |
| `745f991e11130b08` | create acknowledgement, no-op возвращает 409 |

Новые HTTP endpoints, изменения прав, сырые flow JSON и импорт в production в этот PR
не входят. Патчер требует SHA256 всего исходного flow, отказывает при повторной установке,
выключенных узлах/вкладках и перезаписи существующего candidate. Граф и legacy function
суффиксы сохраняются. Применять поверх актуального installed FPR/monthly flow.

## Подготовка будущего выпуска — без активации

Нужны отдельное разрешение на deploy и свежий приватный flow с сервера 147. На нём:

```sh
node scripts/patch_tournament_auto_finish.mjs \
  --source /private/workspace/live.flow.json \
  --source-sha256 <verified-sha256> --output /private/workspace/candidate.json
```

Перед применением проверить diff трёх функций и граф, затем штатный import/ack/readback.
Нельзя регенерировать широкие modular artifacts или использовать старый flow snapshot.
После установки guards отдельно подготовить worker из того же commit: scripts worker,
scripts/lib (включая существующие зависимости), src/components/tournaments/fpr6x25.ts,
src/services/community-rating/monthlyContract.ts и необходимые его imports, npm runtime
с mongodb. Проще использовать чистый checkout этого commit с `npm ci --ignore-scripts`.
Требуется Node 22.18+ с type stripping; копирование/установка в PR не выполняются.

В `/etc/padlhub-tournament-auto-finish/writers.json` хранить только три guarded function
nodes и их tab metadata, экспортированные из установленного live flow. Не копировать туда
Mongo clients, credentials или весь raw flow. При каждом следующем flow deploy обновлять
этот снимок и сверять тела функций с live; несовпадение блокирует включение worker.
Файл должен быть доступен только service user и root. Unit `ProtectHome=true` намеренно
не даёт читать `/root/.node-red`.

Приватный env (значения provision отдельно, без секретов в Git):

```text
TOURNAMENT_AUTO_FINISH_ENABLED=false
NODERED_FLOW_PATH=/etc/padlhub-tournament-auto-finish/writers.json
MONGODB_URI=<runtime database credential>
MONGODB_DB=games
TOURNAMENT_AUTO_FINISH_RUNTIME_DIR=/var/lib/padlhub-tournament-auto-finish
```

Сначала dry-run: `node --experimental-strip-types scripts/tournament_auto_finish_worker.mjs`.
Проверить кандидатов, права service user и резервное копирование. Затем отдельно разрешённая
активация env и units из `deploy/tournament-auto-finish/`. Timer запускается через 30 секунд
после окончания предыдущего прохода; обработка/большая очередь может увеличить задержку.
Серверный запрет ввода действует уже с дедлайна. В ЛК статус обновляется при чтении и
проверках раз в 30 секунд. Полный автоматический runtime smoke остаётся этапом deploy.

Откат: остановить worker, сохранить readback/preimages, восстановить только три функции
по проверенному postimage. Не возвращать старый полный flow поверх чужих изменений.
Уже записанные завершения восстанавливаются только отдельным разрешённым resume/repair;
автоматически откатывать результаты или рейтинг нельзя.

## Проверки

`npm run test:tournament-auto-finish` проверяет дедлайн, частичные/пустые результаты,
FPR isolation, resume, подмену client params, фокус patcher и dry-run. С отдельным локальным
`TOURNAMENT_AUTO_FINISH_TEST_MONGO_URI` тот же suite выполняет настоящие Mongo CAS,
два одновременных finalizer, stale score/create, backup и readback. Используется только
одноразовая тестовая база. Также обязательны lifecycle/offline/monthly/FPR/rating suites,
typecheck, lint и prod/dev builds. CI включает новый suite в существующий regression job.
