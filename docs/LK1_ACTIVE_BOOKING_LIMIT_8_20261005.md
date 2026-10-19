# Лимит восьми активных занятий по подпискам

Решение 05.10.2026: единый порог **8 активных записей** для подписок контура,
включая «Дружбу 2 часа» (ранее 6). Дневные минуты, скидки, дата продажи
`2026-09-01`, исключения станций и учёт выбранного экземпляра подписки сохраняются.
Абонемент «Энергия 5» не получает нового ограничения: прежнего лимита активных
записей у него нет.

Это подготовка исходников и локальных кандидатов. Merge, deploy, изменение
production globals, политик ЦУП, продаж или клиентских записей не выполнялись.

## Проверенные места

| Место | Изменение / результат проверки |
| --- | --- |
| `subscriptions_lk1_plan_rules` | Новое поколение `PLAN_RULES_LIMIT_8`: РА, Дружба, Академия, Спорт, три акционных продукта, Топократы, Дружба 2 часа — всего 9 продуктов текущего live flow |
| `subscriptions_lk1_product_policy` | Отдельная годовая ХАБ: новая политика и защищённый переход 4 → 8 |
| Gateway / preview | Оба встроенных `lk1ReadBoundPolicy` должны читать новую политику ХАБ; правила остальных продуктов берутся из global |
| Evaluator / preview evaluator | Уже используют `activeCount >= rule.maxActiveBookings`; тела не меняются |
| `subscriptions_lk1_hub_sale_runtime` | Квитанция продаж пересчитывается по кандидатному графу; старая квитанция с политикой 4 перестаёт подтверждать политику 8 |
| Витрина подписок | Общая подпись и отдельная «Дружба 2 часа»: «До 8 активных записей» |
| Старые карточки и Петербург | Текстовые условия 8; четыре старых растровых картинки содержат 4, поэтому больше не импортируются и не показываются. Кнопка просмотра условий сохранена |
| Тильда | Исходные блоки Атлантов и Патриотов обновлены; публикация блоков не выполнялась |
| DEV | Годовой shadow fixture, synthetic visit provider, browser/server clamps, fallback и seed 0–8 обновлены; дневной счётчик не изменён |
| ЦУП | `compileDraftPolicy` читает внешнее `activeServicesLimit.max`; существующий DRAFT/PUBLISHED требует отдельного обновления разрешённого экземпляра политики. Выключенные лимиты остаются выключенными |

При **семи** уже активных записях очередная запись ещё может получить бесплатные
минуты. При **восьми и более** работает прежняя логика после порога: бесплатные
минуты и посещение не расходуются; скидки и специальные правила клуба сохраняются.
Это порог использования льготы, а не полный запрет дальнейшей записи.

«Патриоты» отсутствуют в девяти правилах текущего live flow. Отдельно подготовлено
`PLAN_RULES_WITH_PATRIOTS_LIMIT_8` для будущего разрешённого включения; этот кандидат
не активирует дополнительный продукт.

## Node-RED: кандидат и откат

Источник: свежий read-only pull `lk-primary-147:/root/.node-red/flows.json`,
4815 узлов, SHA256
`7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1`.

Команда подготовки (ничего не пишет на сервер):

```bash
node scripts/prepare_lk1_active_booking_limit.mjs \
  /absolute/private/fresh-live-workspace \
  /absolute/private/new-candidate-directory
```

Скрипт требует свежий подтверждённый origin, точный hash всего flow и точные тела
прежних readers/initializers. При дрейфе требуется новый pull и пересмотр preimage.
Выходные файлы остаются вне репозитория с правами 0600: `candidate.json`,
`contract.json`, `rollback.json`, `rollback-contract.json`.

| Function node | Поля |
| --- | --- |
| `lk_subscription_booking_router_20260804` | `func`, `initialize` |
| `lk_subscription_price_preview_20260908_router` | `func` |
| `piter_atomic_router_20260903` | `initialize` |

Основные затронутые пути: запись через `POST /lk/subscription-bookings`,
`POST /lk/subscriptions/game-price-preview`; HUB-продажи используют ту же квитанцию
в summer-subscription status/purchase/confirm. Новых endpoints, wires или узлов нет.

Переход принимает только точный прежний global, уже установленное новое значение
или пустой контекст после restart. Чужие значения не перезаписываются. Откат
согласованно восстанавливает 4/6, readers и квитанцию; конфигурация открытия продаж
не изменяется. Старые `LK1_PLAN_RULES_*`, исторические binding JSON, preimage/hash
контракты и отчёты сохраняют 4/6 как доказательство прошлых поколений.

После будущего разрешённого применения необходим readback обоих globals, receipt,
preview и записи. Начатый до перехода запрос покупки ХАБ может получить защитный
отказ `HUB_LK1_SALE_BINDING_DRIFT` и потребовать новой попытки с актуальной квитанцией.

## Проверки

- `lk1ActiveBookingLimit.test.mjs`: переход из пустого/прежнего контекста, повтор,
  отказ чужой политике, границы 0/4/7/8/9 по каждому продукту, сохранение 120 минут,
  согласованность readers/receipt, текущий приватный live snapshot, совместный откат
  и неизменённые evaluators записи/preview.
- Регрессии старых поколений, resolver, preview, витрины, продаж, DEV и Tilda.
- Полная `npm run build` (prod/dev) и `npm run lint`; изменённый frontend после
  ревью проверяется повторной сборкой затронутого bundle.
- `nodered:modular:build` / `validate` для свежего `LK Games`: 356 узлов,
  44 HTTP inputs, 0 broken wires/links. Это проверка исходного графа;
  точные изменения кандидата и отката проверяет отдельный contract validator.
- `npm ci` на локальном Node 26 отказал из-за отсутствующих platform optional
  packages в исходном lockfile. Lockfile не изменён; локальная сборка и lint используют
  существующие зависимости основного checkout через symlink.

Production UI/API smoke, запись клиента, оплата и применение отката не выполнялись.
Проверка приватного live snapshot в CI пропускается: flow и credentials не публикуются.

## Итоговая проверка и состав diff

- Новые тесты: 6/6, включая приватный свежий snapshot, согласованный откат и
  запрет raw-flow output внутри любых Git checkout.
- Целевые регрессии: 192 PASS, 9 SKIP (приватные snapshots).
- Набор CI: 1688 тестов, 1588 PASS, 99 SKIP, один sandbox EPERM на локальном
  fixture listener; отдельный запуск этого файла с localhost-доступом — 21/21 PASS.
- Независимое payment/security/reliability review: существенных открытых замечаний нет.
- Docker-зависимые legacy/custody и real-nginx проверки отдельно локально не запускались;
  их обязательный результат остаётся за CI.

Изменённые файлы:

- `.github/workflows/lk1-subscription-enforcement.yml`
- `docs/MANAGED_SUBSCRIPTION_DEV_RUNTIME.md`
- `docs/PITER_SUBSCRIPTION_CONTRACT.md`
- `docs/atlanty-landing-tilda/3-markup.html`
- `docs/patriots-tilda/2-events.html`
- `docs/patriots-tilda/README.md`
- `scripts/lib/hubLk1SaleContract.mjs`
- `scripts/lib/lk1HubPolicyTransition.mjs`
- `scripts/lk1_subscription_visit_dev/fixture.mjs`
- `scripts/managed_subscription_dev_runtime.ts`
- `scripts/tests/managedSubscriptionDevRuntime.test.ts`
- `scripts/tests/patriotsTilda.test.mjs`
- `scripts/tests/piterSubscriptionPage.test.ts`
- `scripts/tests/subscriptionStorefront.test.ts`
- `scripts/tests/subscriptionUsageShadow.test.ts`
- `scripts/tests/tournamentSubscriptionLayout.test.ts`
- `src/MyApp.css`
- `src/components/subscription-storefront/SubscriptionPlanCard.tsx`
- `src/components/subscription-storefront/presentation.ts`
- `src/components/subscriptions/HostedSubscriptionUsageTestPage.tsx`
- `src/components/subscriptions/ManagedSubscriptionDevPage.tsx`
- `src/components/subscriptions/subscriptionUsageShadow.ts`
- `src/components/tournament-subscription/TournamentSubscriptionPage.tsx`
- `docs/LK1_ACTIVE_BOOKING_LIMIT_8_20261005.md`
- `scripts/lib/lk1ActiveBookingLimit.mjs`
- `scripts/prepare_lk1_active_booking_limit.mjs`
- `scripts/tests/lk1ActiveBookingLimit.test.mjs`

Локальный browser DOM smoke: 393×852 и 1440×1000, кнопки flip работают,
видимый текст содержит 8, старого текста 4 нет; горизонтальный overflow и
переполнение обратной стороны отсутствуют. Screenshot API браузера дал timeout,
поэтому пиксельный screenshot не подтверждён. Fixture блокирует внешние запросы;
его ожидаемые ошибки аналитики/отсутствующих внешних API не являются production smoke.

MODEL_ROUTE: parent
