# Subscription visit: подготовка серверного DEV

Owner: LK subscription gateway. Audience: разработчик/оператор выделенного DEV,
только синтетические клиенты. База исходников: `ba2588af1492c76fa44dbcd75246762dcefcc309`.
Это подготовка в изолированной ветке, не установка и не разрешение запуска сервера.

## Что подготовлено

- `scheduler.mjs`: scan каждые 5 секунд после завершения предыдущего. Ручной trigger
  получает тот же in-flight promise. Сбой одного job не завершает scan, пока остальные
  jobs не завершены (`allSettled`). Stop прекращает планирование и ждёт весь scan.
- `start.mjs`: API по умолчанию сохраняет manual-only режим. В серверном режиме
  `/dev/control/state` добавляет счётчики worker (циклы/ошибки/итоги), без raw ошибок.
  Shutdown сначала закрывает приём HTTP, дожидается worker, затем закрывает runtime.
  Загрузка Node-RED имеет предел60с; rejection обрабатывается вместе с RED.start.
- `serve.mjs`: отдельный foreground entry, точный hash manifest, чистый source,
  Node22, immutable packet и только dedicated конфигурация1882/3038/27030.
  Новый приватный `/tmp` userDir при каждом запуске; вся долговечная история в Mongo.
  SIGTERM/SIGINT выполняют drain; ни очистки БД, ни освобождения UNKNOWN-lock нет.
- `units/`: stopped-кандидат `lk1-subscription-visit-dev.service` и PrivateNetwork
  drop-in для существующей dedicated Mongo. Один flock на процесс, Restart=no,
  RefuseManualStart=yes, отдельный approval marker, readonly filesystem, shared private
  network namespace только с dedicated Mongo. Публичных портов/ingress нет.
  Старые nodered/provider/cup/identity fixture units должны оставаться выключенными;
  Conflicts= намеренно не используется, чтобы не остановить чужие units автоматически.
- `prepare-server.mjs`: копирует только проверенный payload в новый внешний каталог,
  добавляет unit/env/audit и `server-plan.json`. Не запускает SSH/systemctl/npm,
  не копирует `.env`, private exports или node_modules, не пишет `/srv`/`/etc`.
  План всегда PREPARED_NOT_INSTALLABLE до отдельной сборки и сверки зависимостей,
  Node22 и свежего exact host preflight. Audit JSON — evidence, не разрешение запуска.

Это продолжение существующих production worker/CAS правил. Формула26250 minor,
выбор экземпляра, payment/refund и daily allowance не меняются. UNKNOWN требует
сверки и удерживает бесплатные минуты. Штатный ACK возврата освобождает их.
Production payment callback остаётся501; pay/roster — явно синтетическая команда.

## Проверка зависимостей и сервера

Read-only SSH на `lk-reserve-89` 2026-09-10 подтвердил: dedicated Mongo/Node-RED/provider
inactive+disabled,1882/3038/27030 свободны, dedicated flows.json отсутствует.
Это наблюдение устаревает и должно быть повторено перед установкой. Shared1880/27029
не читались как источник бизнес-данных и не изменялись.

На сервере dedicated Node **18.20.8** и Mongo **7.0.24**. Драйвер MongoDB7.2.0
требует Node>=20.19.0; новый launcher принимает только22.23.2. Нужен отдельный pinned
Node22 binary с проверенным hash, root-owned closure и Linux x64 проверкой.
Для подготовки выбран официальный Node **22.23.2 Linux x64**, архив
`node-v22.23.2-linux-x64.tar.xz`, SHA256
`d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`.
Источник: https://nodejs.org/dist/v22.23.2/SHASUMS256.txt. Существующий Node18
не заменяется этой задачей; новый binary предназначен для отдельного node22 path.

DEV Node-RED обновлён **4.0.9→4.1.15**, Mongo driver7.2.0 без изменения.
Точечные overrides: npm11.19.1 и qs6.16.0. Встроенный npm относится к module installer; явные
`palette.allowInstall/allowUpload=false`, `modules.allowInstall=false`,
`autoInstall=false` и выключенный admin/editor сохраняют его неактивным; установка/обновление модулей в runtime не разрешена. Root package
и зависимости frontend не менялись. [Релиз4.1.15](https://github.com/node-red/node-red/releases/tag/4.1.15)
содержит backport исправления JSONata. Обновление проверяется локально, не установлено
на сервер. `npm audit --package-lock-only --omit=dev --json` дал:

| Lockfile | critical | high | moderate | low | Всего package findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| прежний4.0.9 | 4 | 9 | 4 | 2 | 19 |
| промежуточный4.1.15 | 0 | 15 | 7 | 1 | 23 |
| итоговый4.1.15 + npm11.19.1 + qs6.16.0 | 0 | 0 | 0 | 0 | 0 |

Числа включают транзитивные/metavulnerability записи и не равны числу независимых
уязвимостей. Совместимый `npm audit fix --package-lock-only --ignore-scripts` без
force не устранил остаток: Node-RED registry включает npm10.9.9 с bundled dependencies;
express4.22.2 удерживает вложенный qs6.15.x. Force/downgrade, удаление security warnings,
ручная правка dependency integrity и runtime установка не выполнялись.

**Dependency audit итогового lockfile: PASS,0 findings.** Промежуточный npm11.17
был проверен только вне Git и отвергнут из-за оставшихся bundled advisories.
Закреплена npm11.19.1, включая обновлённые bundled зависимости; qs6.16.0 закрывает
вложенные старые qs. Это override внутреннего npm major, поэтому native startup,
JOIN/worker/return/restart проверяются повторно. Нулевой audit не доказывает отсутствие
неизвестных уязвимостей и не заменяет Linux x64 closure/host readback.
Оригинальный4.0.9 packet и пользовательский локальный UI5191 сохранены.

## Воспроизводимая подготовка

Из чистого task checkpoint собрать новый immutable runtime packet существующим
`build_subscription_visit_dev_packet.mjs`, config строго:
`DEV`, `mongodb://127.0.0.1:27030`, `lk1_subscription_dev_fixture`, provider3038, NodeRED1882.
Затем:

```sh
node scripts/lk1_subscription_visit_dev/prepare-server.mjs \
  /private/tmp/approved-visit-packet /private/tmp/new-server-staging \
  /private/tmp/dependency-audit.json
```

Подготовленный каталог — остановленный план, **не executable live installer**.
До будущей установки согласовать точные source/manifest/dependency hashes, Node22,
preimages units/drop-in/env и ABSENT visit-packet. Никогда не заменять неизвестный
существующий пакет и не использовать прежний installer другого bootstrap-контракта.

Для локальной репетиции: новый Mongo container `--network none`, native Node22 container
в его network namespace, readonly packet и зависимости; host ports не публиковать.
`verify.mjs`: native8 сценариев, включая automatic worker, unpaid cancel и lost ACK
с перезапуском. Drain незавершённых jobs проверяется негативным scheduler unit-тестом.
`verify-server.mjs <packet>`: фактический serve CLI, scheduled debit/
return, SIGTERM clean stop и перезапуск с той же Mongo; только свежая fixture-owned база.

При ошибке или расхождении остановить visit service и сохранить Mongo/журналы/пакет.
Остановка не возвращает реальные деньги/визиты. Никогда не удалять lock и не делать
inverse PUT ради rollback кода. Любая серверная установка, изменение unit и старт
требуют отдельного разрешения; существующие stopped guards не снимать этим пакетом.
