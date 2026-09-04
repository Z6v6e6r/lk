# Подписка «Падел.Дружба.Питер»

## Текущий режим

Страница использует отдельный storefront-вариант `piter_friendship`, отдельный
счётчик и отдельный inventory. Кандидат от 2026-09-03 готовит временный
compatibility-контур годовой продажи, а managed policy и новые ограничения
использования остаются выключенными до отдельного этапа готовности.

Сервер выбирает точный Viva product ID, цену и партию из атомарного inventory
ledger, проверяет сумму ответа провайдера и годовой lifecycle. ХАБ и Котельники
остаются закрытыми managed sale guard. Само изменение production Node-RED и
активация ledger выполняются только отдельными разрешёнными этапами.

## Guarded-подготовка и переключение

`scripts/prepare_piter_atomic_activation_packet.mjs` офлайн сверяет четыре полных
read-only snapshot: scoped Mongo ledger, все Viva-транзакции точного product ID
и единственную карточку этого Viva-продукта, а также readback точного Node-RED
global binding `summer_subscription_piter_friendship_product_id`. Snapshot должен иметь явный
источник, полный pagination receipt и возраст не более пяти минут; допустимое
расхождение времени между источниками — не более минуты. Активация блокируется
при любом nonterminal legacy-платеже, возврате, несовпадении provider/Mongo,
повторе идентификатора, иной стоимости продукта, lifecycle drift или неполной
выгрузке. Полный packet содержит чувствительные payment/transaction IDs и
пишется только в новый каталог `0700` файлами `0600`; stdout и report содержат
только хеши.

`scripts/manage_piter_atomic_ledger.mjs` работает в dry-run без флага
`--apply`. Будущая live-запись дополнительно требует:

- точного `contractDigest` приватного packet;
- ожидаемой `revision` и exact Mongo CAS;
- action-specific допуска `SEED_147`, `ACTIVATE_147` или `DEACTIVATE_147`;
- запуска на `lk-primary-147` под владельцем canonical runtime и общего с
  reviewed-flow deploy непрерывного `flock`; значение environment-переменной не
  является доказательством lock: apply-процесс запускается через `flock -F`, наследует
  descriptor и перед каждой Mongo mutation подтверждает свой PID, inode/device lock
  file и exclusive `FLOCK WRITE` запись в Linux `/proc/locks`;
- canonical root-owned `/root/.node-red/flows.json`, Mongo URI только в
  `LK_PITER_ATOMIC_MONGO_URI`, фиксированных database `games` и collection из
  packet, а также exact SHA-256 readback host machine identity и replica-set
  identity;
- свежей повторной проверки срока packet непосредственно перед mutation и
  bounded Mongo query/write;
- durable canonical Extended JSON preimage snapshot с manifest SHA-256,
  `fsync` и readback перед записью (это forensic snapshot, restore rehearsal
  остаётся отдельным обязательным доказательством);
- для seed/activate — byte SHA активного flow, равного reviewed candidate SHA,
  и полного неистёкшего reviewed-flow lease в фазе `soaking`; lease обязан
  совпасть по source/candidate/deployment и быть получен до самого раннего из
  четырёх evidence snapshot, то есть reconciliation выполняется уже на
  установленном fail-closed candidate.

Seed создаёт sentinel только с `ready:false`. Activate разрешён только из
точного пустого seed-состояния. Deactivate меняет только `ready:true -> false`
по CAS и сохраняет резервы, платежи и счётчики. После deactivate новые покупки
закрыты, но уже отправленные provider result/confirm могут завершить durable
фиксацию. `rollback-check` сообщает только неавторизующую offline-предпосылку.
Реальный flow rollback требует отдельного live majority read, exact revision,
`ready:false`, отсутствия atomic reservations/`piter-sale:*` и выполнения
reviewed rollback под тем же непрерывным lock. Сам ledger operator flow не
откатывает. Deactivate без candidate flow явно возвращает
`runtimeStopProven:false` и не может считаться доказательством остановки всего
legacy runtime.

## Атомарность покупки

- единый sentinel `inventory:piter_friendship_12m_2026_v1` хранит `revision`,
  `paidCount`, `reservedCount`, `takenCount`, terminal baseline
  `legacyPaymentRefs` и записи новых резервов;
- место резервируется optimistic CAS до любого финансового POST в Viva;
- партия и цена пересчитываются из подтверждённого ledger-снимка;
- повтор одного `paymentRef` возвращает сохранённый результат и не запускает
  второй POST; несовпадающий intent завершается `409`;
- переход в `DISPATCHING` фиксируется durable CAS непосредственно перед POST;
- HTTP `201` возвращается только после подтверждения ledger и sale record;
- неоднозначный ответ Viva фиксируется как `PROVIDER_UNKNOWN`: место остаётся
  занятым, автоматического повторного POST или TTL-освобождения нет;
- отсутствующий или `ready != true` sentinel оставляет витрину fail closed.

Перед отдельной активацией sentinel создаётся из свежего read-only снимка.
Активация разрешена только при отсутствии legacy-записей Питера в
`PAYMENT_PENDING`, неоднозначном или истёкшем без терминального ответа
провайдера состоянии. В baseline входят только терминальные `PAID` и каждый их
уникальный `paymentRef`; повтор такого идентификатора после cutover блокируется
до Viva POST. Затем проверяются counts, уникальность ссылок и digest. Любая незавершённая legacy-транзакция сначала должна
быть сверена с Viva до явного терминального статуса. Этот data write и
переключение `ready:false -> true` не входят в deploy кандидата.

После установки fail-closed candidate любой confirm legacy-записи без
`requestFingerprint`, включая scheduled reconcile, не выполняет Mongo update.
Он требует отдельной offline-сверки и нового свежего packet. Это исключает
гонку между поздним legacy `FAILED -> PAID` и seed baseline; поэтому все четыре
snapshot снимаются только после получения совпадающего `soaking` lease.

## Витрина и счётчик

- `counterKey`: `piter_friendship`;
- `inventoryId`: `piter_friendship_12m_2026_v1`;
- общий объём: 400 подписок;
- одна партия: 100 подписок;
- партии и цены: 1 — 19 800 ₽, 2 — 23 800 ₽, 3 — 36 800 ₽, 4 — 56 800 ₽;
- `paidCount + reservedCount` атомарного sentinel определяет текущую партию на
  сервере; до активации baseline содержит только подтверждённые `PAID`;
- браузер передаёт только `counterKey`: `productId`, цена и номер партии из
  браузера не принимаются как источник истины.

Проверенный server-side product binding:

```text
summer_subscription_piter_friendship_product_id
```

Опциональные tier-specific overrides:

```text
summer_subscription_piter_friendship_inventory_id
summer_subscription_piter_friendship_tier_1_product_id
summer_subscription_piter_friendship_tier_2_product_id
summer_subscription_piter_friendship_tier_3_product_id
summer_subscription_piter_friendship_tier_4_product_id
summer_subscription_piter_friendship_tier_1_product_name
summer_subscription_piter_friendship_tier_2_product_name
summer_subscription_piter_friendship_tier_3_product_name
summer_subscription_piter_friendship_tier_4_product_name
```

Нельзя подставлять product ID по сходству названия. Серверная скидка каждой
партии считается от подтверждённой базовой стоимости привязанного Viva-продукта.

## Политика использования

Для активации нужен отдельный `PUBLISHED` snapshot managed policy и точное
server-side отображение Viva product → `subscriptionTypeId`. Целевой контракт:

1. правила применяются только к точному PITER product с подтверждённым Viva
   `purchaseDate(Europe/Moscow) >= 2026-09-01`; более старые, недатированные,
   невалидные или неоднозначные экземпляры остаются на Friendship compatibility
   path без миграции;
2. одна 60-минутная операция `CREATE_GAME` или `JOIN_GAME` в локальный день
   бесплатна;
3. `CREATE_GAME` и `JOIN_GAME` длительностью 90 или 120 минут получают скидку
   30% от полной подтверждённой сервером цены события, а не бесплатный первый
   час с доплатой только за остаток; такая платная скидочная операция не
   расходует отдельный бесплатный 60-минутный лимит независимо от порядка
   операций; после использования бесплатного часа
   duration-filter разрешает эту скидку только для 90/120 минут, а повторная
   60-минутная операция по подписке блокируется;
4. игра с тренером, групповая тренировка и формат «Время на друзей» получают
   скидку 50% только после точного server-side сопоставления категории и
   provider event/product type;
5. одновременно разрешено не более 4 активных записей с использованием льготы;
6. окно записи — 14 локальных календарных дней станции: текущая дата и ещё
   13 дней; дата с локальным смещением `+14` уже вне окна;
7. цена, скидка, длительность, категория, станция и event/product type всегда
   разрешаются из доверенного server/provider read, а не из payload браузера.

Изображение правил и frontend-копия не являются runtime policy. До публикации
совпадающего CUP snapshot неизвестная категория или отсутствующее provider
сопоставление должны оставаться недоступными fail closed. Публикация policy,
runtime enablement и любой provider write относятся к отдельному live-этапу.
Текущая DEV-кандидатура поэтому не трактует произвольный турнир как «Время на
друзей»: для игры с тренером и «Времени на друзей» ещё нужны точные Viva
`directionId/typeId` и CUP mapping.

Возврат legacy-продажи не меняет этот раздел: новая managed policy не
публикуется, managed usage router не включается, а купленная подписка до
отдельной активации managed-контура обслуживается по compatibility path.

## Приёмочные сценарии до включения

| Сценарий | Ожидаемый результат |
| --- | --- |
| 99 занятых мест | партия 1, остаток 1, цена 19 800 ₽ |
| 100 занятых мест | партия 2, остаток 100, цена 23 800 ₽ |
| Нет product ID активной партии | `bindingReady=false`, оплаты нет |
| Подмена `productId` в браузере | значение игнорируется |
| Не отмечен чекбокс условий | вход и покупка не запускаются |
| Неавторизованный пользователь после чекбокса | показывается штатная авторизация |
| Продажа `2026-08-31 23:59:59 +03` | Friendship compatibility; новые правила не применяются |
| Продажа `2026-09-01 00:00:00 +03` | допускается PITER managed path при allowlist и полном runtime evidence |
| Создание/присоединение 60 минут, usage=0 | бесплатно по опубликованной политике |
| Создание/присоединение 90/120 минут | скидка 30% от полной server-resolved цены |
| 90/120 минут, затем первые 60 минут | скидочная операция не расходует free-hour bucket; 60 минут бесплатно |
| 60 минут, затем 90/120, затем ещё 60 | скидка 30% разрешена; повторные 60 минут заблокированы |
| Вторая 60-минутная игра в тот же локальный день | отказ по дневному лимиту; скидка 30% не подставляется |
| Игра с тренером/группа/«Время на друзей» | скидка 50% только при точном server-side mapping |
| Пятая активная запись | отказ по active-services limit |
| Запись за пределами 14 локальных дней | отказ по booking window |
| Неизвестная категория или отсутствующий benefit rule | отказ fail closed |
| Отмена/неоплата/возврат | счётчик меняется только по подтверждённому статусу |

Перед активацией managed policy также нужны санитизированный Golden HAR и
read-back тесты для реального расчёта скидок, debit/return визитов, отмены,
неоплаты и возврата. Переход между ценовыми партиями разрешено открывать только
через описанный выше атомарный ledger: compatibility legacy lifecycle не
является доказательством конкурентной безопасности на границе 100 мест.

Проверенный station ID Питера и общий DRAFT-протокол для Питера, Котельников и
сети находятся в `docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md`.
