# LK1 «Дружба 2 часа» — выпуск серверной части (2026-09-30)

Продукт: `products/subscriptions/6b98e7e3-5bd3-4e94-9dc3-7723ea52513e` («Падел.Дружба 2.0»),
19 800 ₽ / 30 дней, `planKey: friendship_two_hours`.

## Что сделано на 147

Миграция установленного flow выполнена штатным защищённым контуром
(`deploy_reviewed_flow_147_remote.mjs`, deployment `lk1-friendship-two-hours`), без ручной правки
прод-файлов и без пересборки из устаревшего композитора пинов.

| Шаг | Значение |
| --- | --- |
| Источник (живой flow до применения) | `845e03694c10a14b966a47179ee01afd20d42e85bef61239b43550afaa550acd`, 4804 узла |
| Кандидат (опубликован) | `cc2d76f4ad9b7462cb5534434a52d9e8a58633a9c2134b179cb7b921b871c80f`, 4804 узла, 219 http-входов |
| Изменённых узлов | 5 (6 полей), добавленных узлов 0 |
| Stage | `/root/.node-red/.padlhub-reviewed-flow-stage-20260930T173624+0300-1` (0700 root:root) |
| Бэкап прежнего flow | `/root/.node-red/.padlhub-reviewed-flow-backups/flows-pre-lk1-friendship-two-hours-20260930T173653+0300.json` |
| Контракт | `/root/.node-red/.padlhub-reviewed-flow-backups/contract-lk1-friendship-two-hours-20260930T173653+0300.json` |
| Кандидат (копия) | `/root/.node-red/.padlhub-reviewed-flow-backups/candidate-lk1-friendship-two-hours-20260930T173653+0300.flow.json` |
| Node-RED | online, pid 2353771, restart_count 293 |

Изменённые узлы:

| Узел | Поле | Было → стало |
| --- | --- | --- |
| `lk_subscription_booking_router_20260804` | `func` | `e3b46e691517…` → `cfce248c…` |
| `lk_subscription_booking_router_20260804` | `initialize` | `08f6b84d73e1…` → `d7aec140…` |
| `lk_subscription_price_preview_20260908_router` | `func` | `7605df8c0f89…` → `06819480…` |
| `lk_subscription_managed_policy_20260820` | `func` | `443f2633e92f…` → `2d3f5b50…` |
| `8fdc7076a0c436a2` (статус, prepare) | `func` | `752ebf525a26…` → `92dec6b2…` |
| `c165e43eba668c25` (статус, response) | `func` | `cf4beffffedc…` → `79619c18…` |

## Что именно изменилось в поведении

- **Правило в глобале `subscriptions_lk1_plan_rules`**: восемь правил расширены до девяти —
  добавлено правило продукта `6b98e7e3…` (`maxActiveBookings: 6`, `freeGameMinutesPerDay: 120`,
  скидки 30 % на игру и 50 % на групповые, турниры и «Время на друзей»). Прежние восемь правил
  сохраняются; чужой приор писатель отвергает («plan rules prior mismatch; no overwrite»).
- **Распознавание продукта**: `friendship_two_hours` по id и по именным маркерам; ветка маркеров
  стоит до общей ветки «Дружбы», поэтому «Дружба 2 часа» не схлопывается в старый план.
- **Одно событие в день**: `PLAN_CATEGORIES["friendship_two_hours"] = ["open_game","tournament"]` —
  игра 60/90/120 и «Время на друзей» делят один дневной слот; вторая игра того же дня отклоняется.
- **Бесплатное событие дня** для «Времени на друзей» ограничено направлением `5278`:
  `LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES` знает только этот продукт; турнир ПадлхАБ той же
  категории остаётся на обычной скидке 50 %. Проверка одна на целевое событие, броню и записи
  провайдера — дневное ведро не расходится.
- **Порог активных записей**: с седьмой записи бесплатных часов нет — evaluator больше не считает
  прикрытым дневное событие выше порога (`freeFirstCovered = !aboveActiveLimit && …`), запись при
  этом остаётся доступной со скидкой.
- **Счётчик**: `counterKey=friendship_two_hours` в паре prepare/response; `bindingReady` читает
  глобал правил и доказывает правило, а не цену; явный запрос счётчика не подменяется fallback.

## Доказательства после применения

```
GET https://padlhub.su/lk/tournaments/summer-subscription/status?counterKey=friendship_two_hours
200 {"counterKey":"friendship_two_hours","productId":"6b98e7e3-5bd3-4e94-9dc3-7723ea52513e",
     "productName":"Падел.Дружба 2.0","priceMinor":1980000,"unlimited":true,
     "bindingReady":true,"canPurchase":true,"totalLimit":0,"bindingError":null}
```

`bindingReady: true` означает, что писатель правил отработал на старте процесса и правило продукта
`6b98e7e3…` найдено в `subscriptions_lk1_plan_rules`.

Агрегатный ответ остался прежним — пять счётчиков, ничего не сломалось:

| counterKey | priceMinor | bindingReady | canPurchase | totalLimit |
| --- | --- | --- | --- | --- |
| friendship | 980000 | true | true | 7 |
| sport | 1980000 | true | true | 132 |
| academy | 2380000 | true | true | 0 |
| ra | 2380000 | true | true | 0 |
| energy5 | 1980000 | true | true | 0 |

Живой дайджест после применения: `cc2d76f4…` = дайджест кандидата; `node-red` online, новых
ошибок в `node-red-error.log` нет (только известное предупреждение драйвера MongoDB).

## Откат

Полный байтовый откат — восстановлением бэкапа штатным контуром (lease применённого деплоя
истекает через 15 минут после применения):

```
ssh lk-primary-147 "cd /root/.node-red && node <stage>/deploy_reviewed_flow_147_remote.mjs rollback \
  --deployment-id lk1-friendship-two-hours --stamp <YYYYMMDDTHHMMSS+ZZZZ>"
```

Парный откат уровня кода — инверсия тех же дельт: `scripts/patch_live_lk1_friendship_two_hours_hotfix.mjs`
экспортирует `revertFriendshipTwoHoursPlanStoreBody` / `revertFriendshipTwoHoursEvaluatorBody`, а тест
`scripts/tests/friendshipTwoHoursHotfix.test.mjs` доказывает, что `revert(apply(live)) === live`
байт-в-байт (в том числе на реальных телах из живого снимка).

## Публикация frontend (2026-09-30, после merge)

PR #169 влит в `main` merge-коммитом `6cf842c81e4ebc3684b49860398d0b063843fbd6`; exact-head гейт
(`LK1 exact-head enforcement gate`) завершился `success` на `363ef11f`.

Сборка выполнена из чистого checkout этого коммита (DETACHED, рабочее дерево чистое —
`release:preflight` подтвердил источник).

| Артефакт | Версия / хеш | Куда |
| --- | --- | --- |
| Основной prod-комплект | `release.json` `20260930T151748Z`, `bundle.js` `a6310172…` | `lk-primary-147:/var/www/html/lk/` (`npm run deploy:all`) |
| Основной dev-комплект | `release-dev.json` `20260930T151803Z` | `lk-reserve-89:/var/www/html/lk/` (см. ограничение ниже) |
| Витрина prod | `release.json` `20260930T151806Z`, `subscription-storefront.js` `b13d42ff…` | `lk-primary-147:/var/www/html/lk/subscription-storefront/` |
| Витрина dev | `release-dev.json` `20260930T151807Z`, `subscription-storefront-dev.js` `a602200d…` | `lk-reserve-89:/var/www/html/lk/subscription-storefront/` |

Подмена файлов витрины — с бэкапами по штатному соглашению о именах
(`subscription-storefront.js.backup-20260930T114514Z-20260930T151806Z`, `release.json.backup-…`) и
атомарным `mv` из временного файла в каталоге, чтобы не отдать частично записанный бандл.

Проверено по HTTPS: серверные хеши совпадают с локальной сборкой (`bundle.js`, `games.js`,
`tournaments.js`, `release.json`, оба бандла витрины), а доставленный prod-бандл витрины содержит
текст карточки — `Одно событие в день: игра 60, 90 или 120 минут либо «Время на друзей»` — и ключ
счётчика `friendship_two_hours`.

Допуск продукта прочитан заново в Viva: направления `{4588, 5278}`, типы `{1613, 839}`,
`hasDirectionLimitation`/`hasTypeLimitation` = `true`, `cost 1980000`, `validityDays 30`,
`visits 30` — то есть `parseFriendshipTwoHoursProduct()` пропускает карточку, и она открывается для
покупки вместе с серверным счётчиком (`bindingReady: true`).

Откат витрины: вернуть пару `.backup-<старая версия>-<новая версия>` (`subscription-storefront.js`
и `release.json`, на 89 — `-dev`-варианты) и повторить чтение манифеста.

## Что ещё НЕ сделано

- **Проверка «одно событие в день»** на живых записях (две игры 60 в один день) не воспроизводилась
  end-to-end: доказательство — тесты путей + установленное правило, не реальная запись.
- **DEV-канал основного комплекта**: `deploy:dev` выложил файлы в `/var/www/html/lk/` на 89, но nginx
  на 89 отдаёт dev-бандлы из неизменяемого namespace `lk-frontend-dev-releases/<sha>-<hash>` через
  ссылку `lk-frontend-dev-current` (сейчас `5fecc7dc…`, 2026-09-15). То есть dev-канал основного
  виджета не обновился; публикация туда — отдельный шаг (frontend-delivery pilot или осознанная
  публикация в namespace). Витрина dev обновилась штатно: её каталог отдаётся напрямую.
- `npm run build` в ветке падает из-за отсутствующих `VITE_*`, `npm run nodered:modular:validate`
  требует `--workspace` — обе проверки не запускались.
- Манифест витрины `/lk/subscription-storefront/release.json` отдаётся с `max-age=31536000,
  immutable`; T123 пробивает кэш параметром `force_ts`, но правило `no-store` из
  `docs/README_DEPLOY.md` на этот путь не распространено.
