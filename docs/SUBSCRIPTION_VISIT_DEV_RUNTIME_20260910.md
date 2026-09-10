# Изолированная проверка JOIN по абонементу

Состояние: компоненты подготовлены для локальной репетиции. Установка, запуск на
`lk-reserve-89`, merge, push и любые реальные платежи этой задачей не выполняются.
Основа: `a7be8cdc31f8511ad8c34e41f390bec2fc96222a`; прежние task/worktree сохранены.

## Что исполняется

`build_subscription_visit_dev_packet.mjs` строит новый минимальный DEV-граф из
точного исторического preimage через существующий group composer и paid JOIN patch.
Сохраняются production Function-узлы JOIN/checkout, product identity, durable booking
journal, leave/refund, daily allowance, Mongo CAS удаления участника и четыре scoped
catch-цепочки. Это новый граф, не артефакт для импорта в production.

Вместо HTTP/Mongo config nodes используются адаптеры: реальные loopback HTTP и MongoDB.
В граф не входят уведомления, автоочистка, inject и канонический post-payment callback.
Этот callback явно отвечает 501. Подтверждение оплаты и проекция участника — отдельная
синтетическая команда `/dev/control/pay` с actual bookingId из JOIN; она сохраняет
paid marker прежде проекции, проверяет точную CONFIRMED operation/transaction и
использует game generation CAS. Повтор восстанавливает незавершённую проекцию,
отменённая старая транзакция не может восстановить участника.

Native Node-RED 4.0.9 не предоставляет глобальный `URL` внутри Function. Исправлены
обе проверки HTTPS в paid JOIN patch: первичный readback и повтор checkout. Общая
чистая функция допускает HTTPS DNS authority/стандартный 443, запрещает userinfo,
backslash, control bytes и escapes в authority. IPv6 и нестандартный порт намеренно
отклоняются. Это исправление исходного patch; на сервер оно не применено.

## Фикстуры и изоляция

- Standalone зависимости: Node-RED **4.0.9**, MongoDB driver **7.2.0**, отдельный lockfile.
  Это runtime существующего DEV-контура, root dependencies не меняются.
- Node-RED `127.0.0.1:1882`, synthetic provider `127.0.0.1:3038`.
- Mongo только `127.0.0.1:27030`, база `lk1_subscription_dev_fixture` либо
  `lk1_subscription_dev_fixture_verify_*`. Другие URI/БД запрещены.
- Только фикстурные service/user tokens; HTTP adapter переписывает allowlisted Viva
  origin на loopback, redirects выключены; реального proxy/identity/payment SDK нет.
- Provider принимает точные synthetic actor/booking/studio/phone/payment DTO.
  Ссылка `https://checkout.invalid/fixture-pay/...` — неплатёжный маркер; переходить
  по ней не требуется. Оплата проверяется только через control endpoint.
- CLI по умолчанию disabled. Явный `--run` проверяет полный SHA256 inventory,
  привязку entry к пакету и новый приватный userDir в `/tmp`. Editor/admin выключены.
  Hash inventory — контроль изменения одобренного пакета, не цифровая подпись.
- Worker вызывается явно `/dev/control/worker`; планировщик на сервере не установлен.
  Fault injection доступен из test runtime API, не опубликован отдельным HTTP route.

## Репетиция

Собрать новый внешний каталог (существующий output запрещён):

```sh
node scripts/build_subscription_visit_dev_packet.mjs \
  /private/tmp/approved-input/source.flow.json \
  /private/tmp/visit-dev-packet /private/tmp/visit-dev-config.json
```

Пример config: `environment: DEV`, `mongoUri: mongodb://127.0.0.1:27030`,
`database: lk1_subscription_dev_fixture_verify_local`, `providerPort: 3038`,
`nodeRedPort: 1882`.

В пакетном `scripts/lk1_subscription_visit_dev` выполнить
`npm ci --ignore-scripts --no-audit --no-fund` для установки lockfile-зависимостей.
Запускать `verify.mjs` только в fixture-owned контейнере Node22 с сетью
`container:<fixture Mongo>`; Mongo запускается с `--network none` и bind127.0.0.1:27030.
Никакие порты на host не публикуются. Контейнеры удаляются после проверки.

`verify.mjs` исполняет native Node-RED, реальные Mongo CAS и loopback HTTP:

1. 90 минут: base112500 minor, free60, overage30 со скидкой30%, платёж26250 minor.
   Одна ON_PLACE booking, одна SERVICE transaction, повтор отдаёт ту же ссылку.
2. Durable synthetic payment marker, сбой до roster projection, безопасный повтор.
3. Два worker одновременно: ровно одно списание −1 только с выбранного экземпляра.
4. SELF leave: фикстурный возврат26250, удаление участника, inverse job+1,
   RELEASED только после подтверждения возврата; повторный JOIN в тот же день снова
   получает60 бесплатных минут и26250 minor к оплате.
5. Отмена неоплаченной booking: возврат посещения без денежного возврата.
6. Потеря ответа на −1 либо +1 после durable provider effect: UNKNOWN и lock сохранены.
   Отдельный перезапуск процесса с той же Mongo базой не повторяет дельту и не освобождает
   лимит. Требуется ручная сверка, автоматическая компенсация не угадывается.

## Проверки и ограничения

Локальная физическая репетиция не доказывает работу VivaCRM, реального payment callback,
фискализации, deployed frontend или серверного планировщика. Browser UAT этого контура
не заявляется. Unit/contract suite дополнительно проверяет конфигурацию, DTO, provenance,
HTTPS без URL global, lifecycle/worker/leave; отдельный исторический Mongo unit fixture
может быть SKIP, его не подменяют PASS — новая physical suite запускается отдельно.

Полная frontend сборка использует inert `https://ci.invalid/...` env как в CI.
Сборка с отсутствующими ignored env останавливается до компиляции; это не live artifact.
`nodered:modular:validate` без обязательного private `--workspace` не запускается;
DEV candidate проверяется собственным graph builder и native загрузкой. Release
модульный пакет из свежего live147 в рамках этой задачи не собирается.

## Следующие отдельные переходы

Read-only аудит обнаружил dedicated DEV units inactive/disabled и отсутствие
`/srv/lk1-subscription-dev/node-red/flows.json`. Исторический аудит не заменяет свежую
проверку перед установкой. Shared1880/27029 не являются target.

Перед будущей stopped-install: заново проверить exact dedicated units/user/paths,
ABSENT preimage, отсутствие listeners1882/3038/27030 и выделенную БД; утвердить manifest
SHA и dependency inventory. Пакет сейчас запускает native Node-RED и provider внутри
одного процесса; существующие отдельные fixture units не включать одновременно.
Нужны отдельно reviewed unit/egress ограничения и согласованный server launcher:
текущий CLI намеренно допускает только новый временный userDir. Исполняемого server
installer/enable/start в пакете нет. Shared flow и main branch не менять.

## Зафиксированные результаты локальной проверки

- Native suite: **7 PASS**, включая production scoped recovery202 после отказа Mongo
  между созданием Viva booking и подтверждением журнала.
- Актуальные DEV/paid-patch unit contracts: **8 PASS**. Lifecycle/worker/leave:
  **42 PASS**, один прежний физический Mongo test **SKIP** без его отдельного URI.
  Новая native suite выше использует реальную Mongo и не пропущена.
- HUB paid JOIN subset: **11 PASS**, 15 старых installation/CREATE cases SKIP вне
  переданного historical ingress fixture. Это не общий PASS всех HUB сценариев.
- `tsc -b`: PASS; full lint: 0 errors/387 existing warnings; scoped lint: PASS.
- Полная `npm run build` с inert CI env: PASS. Release с реальными env не собирался.
- Payment/recovery specialist review: блокирующих замечаний после правок нет.
- Secret/PII pattern review: реальные секреты/персональные выгрузки не добавлены.
  Перед push synthetic E.164/invalid userinfo fixtures переведены в сборку строк,
  как в существующих тестах. Из npm deprecation metadata удалена только рекламная
  фраза с публичным контактом; предупреждение о vulnerabilities сохранено.
  Scanner и runtime-значения фикстур не менялись.
- Pinned Node-RED4.0.9 lock включает deprecated tar7.4.3 с предупреждением registry
  о vulnerabilities. Editor/module auto-install отключены; тесты network-none.
  Перед серверной активацией отдельно проверить dependency advisory/обновление runtime.
  Этот пакет не является разрешением эксплуатации устаревших зависимостей на сервере.

Изменённые файлы: этот документ, `docs/WORKLOG.md`,
`scripts/nodered_lk1_hub_nodes/gateway.js`, `scripts/patch_nodered_subscription_paid_join.mjs`,
`scripts/build_subscription_visit_dev_packet.mjs`, `scripts/tests/subscriptionVisitDev.test.mjs`,
а также `scripts/lk1_subscription_visit_dev/{fixture,graph,packet,runtime,start,verify}.mjs`
и локальные `package.json`/`package-lock.json`.
