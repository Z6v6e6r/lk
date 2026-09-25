# «Дружба Топократы» в контуре ограничений LK1 (2026-09-26)

Решение владельца: клубная подписка «Дружба Топократы» входит в тот же контур, что и
«Дружба», а её тренировочное направление получает отдельную доплату.

## Продукт

| Поле | Значение |
| --- | --- |
| Viva product id | `14692232-12be-4218-9fa1-2d5b79b62035` («Дружба Топократы») |
| `planKey` | `topocraty` (только для receipts) |
| `enforceFrom` | `2026-09-01` — как у стандартной «Дружбы» (продажи клуба начались 24.09.2026) |
| Пять чисел правила | `maxActiveBookings=4`, `freeGameMinutesPerDay=60`, `gameOverageDiscountPercent=30`, `groupTrainingDiscountPercent=50`, `tournamentDiscountPercent=50` |

То есть все стандартные ограничения и скидки «Дружбы» действуют на эту подписку: лимит
четырёх активных записей, общий с играми бесплатный час (60 минут в день, списывается одно
посещение), скидка 30 % на платную часть игры, 50 % на групповые тренировки и турниры.

## Направленческое правило 6233 «Топократы тренировка»

Направления клуба в Viva: `6180` «Топократы игра» и `6233` «Топократы тренировка»; тип у обоих
`2349` «Корпоративные клиенты» (тот же, что у «Атлантов»), поэтому правило привязано к
**направлению**, а не к типу.

Для направления `6233` при продукте `14692232-…` тренировка покрывается механикой игры:

1. Сначала списывается общий дневной бесплатный час (60 минут, тот же счётчик, что у игры) и
   ровно одно посещение.
2. За минуты свыше часа — доплата `1/4` базовой стоимости корта события (`target.basePriceMinor`
   из тарифа Viva для выбранной станции и корта), пропорционально длительности:
   `доплата = floor(стоимость × ¼ × минуты_свыше / длительность)`.
3. Если бесплатного часа нет (дневные 60 минут уже израсходованы **или** у клиента ≥ 4 активных
   записей) — полная разовая цена события, скидки нет, посещение не списывается.

Пример: тренировка 2 часа, стоимость корта 4 000 ₽. Свободен весь час → `freeMinutes=60`,
`paidOverageMinutes=60`, `chargeBeforeDiscountMinor=200000`, скидка 75 % на платную часть,
`finalPriceMinor=50000` (500 ₽). Тренировка 90 минут после 30 израсходованных минут →
`freeMinutes=30`, `paidOverageMinutes=60`, к оплате 666,67 ₽. Тренировка 60 минут → 0 ₽ и одно
посещение. Направление `6180` и турниры клуба правило не затрагивают: у них остаётся
стандартная логика «Дружбы».

## Что изменено в источнике

| Файл | Что |
| --- | --- |
| `scripts/lib/lk1PlanRulesTransition.mjs` | `LK1_TOPOKRATY_PRODUCT_ID`, `LK1_PLAN_RULES_WITH_TOPOKRATY` (установленный payload + клубное правило) и `buildTopokratyPlanRulesTransition()` с guarded-записью поверх точного prior. Установленный `LK1_PLAN_RULES_DESIRED` не тронут. |
| `scripts/nodered_lk1_hub_nodes/evaluator.js` | Отдельная ветка `category === "GROUP_TRAINING" && isTopokratyTrainingBenefit(...)` (до стандартной ветки, поэтому reviewed-текст free-first-event остаётся байт-в-байт), помощники `topokratyDirectionId`/`moscowLocalDate` и аддитивное поле решения `eventDiscountPercent` (100 для полного покрытия, иначе процент платной части). |
| `scripts/nodered_lk1_hub_nodes/gateway.js` | `directionId` в серверно-разрешённом `lk1.target` (алиасы `direction.id` / `direction` / `directionId` / `exerciseDirectionId`), и проверка клиентской котировки сравнивает процент с `lk1ExpectedEventDiscountPercent(decision, route)` — для частичной оплаты это процент решения, иначе прежнее поле правила; сумма по-прежнему сверяется с `decision.benefit.finalPriceMinor`. Все точки денежного мандата переведены на `lk1EventPaymentQuoteBinding`. |
| `scripts/nodered_lk1_hub_nodes/event_payments.js` | Новые `lk1ClubEventPaymentBinding` (частичная доля с процентом решения и полная цена при 0 %) и `lk1EventPaymentQuoteBinding` (клубная форма → reviewed-binding). Reviewed-функция `lk1EventPaymentBinding` оставлена байт-в-байт, поэтому пины поколения `lk1-free-event-checkout` не двигаются. |
| `scripts/patch_live_lk1_payment_readback.mjs` | Перепин `reviewedStepSha256` шага `lk1_transaction_readback` (в нём сменился вызов мандата). |
| `scripts/nodered_subscription_price_preview_nodes/router.js` | `previewDirectionId` в target превью и ветка `paidShare` для событийной котировки: проверяет арифметику решения и отдаёт `amountMinor`, `freeMinutes`, `paidMinutes`, `discountPercent`. |
| `src/utils/groupSubscriptionDiscount.ts` | Котировка с оплачиваемой долей: `isPartialSubscriptionEventDiscountQuote` (минуты обязаны покрывать длительность события), `subscriptionEventQuoteAmountMinor`; валидатор `isSubscriptionEventDiscountQuote` принимает обе формы (плоскую и долю), добавлены `freeMinutes`/`paidMinutes`. Подпись «Доплата за N мин» использует тот же предикат, что и расчёт суммы. |
| `src/components/group-schedule/GroupSchedulePage.tsx` | Для доли на кнопке показывается «Доплата за N мин по подписке …» вместо «Скидка N %». |
| `scripts/patch_live_lk1_plan_rules.mjs` | Перепинён `PLAN_RULES_REVIEWED_EVALUATOR_SHA256` (аддитивные поля `eventDiscountPercent`). |
| `scripts/tests/lk1TopokratyFriendship.test.mjs` | Новый набор: матрица решений, прямой тест денежного мандата (доля/полная цена/подделанные вердикты), привязка к продукту/направлению, fail-closed по дневному бакету, payload/transition, прямой прогон evaluate-шага превью (частичная/полная/обычная/покрытая котировка и подделанные решения), маркеры booking/preview/widget. |
| `scripts/tests/groupSubscriptionDiscount.test.ts` | Кейс котировки с оплачиваемой долей. |
| `scripts/tests/lk1PreviewFreeFirstEventHotfix.test.mjs` | Пины reviewed-источника приведены к новой форме сравнения процента. |

Контракт паритета: `decision.eventDiscountPercent` — единственный источник процента для
клиентской котировки. Превью цитирует его, gateway сверяет с ним ожидание клиента, а сумма
всегда сверяется с `decision.benefit.finalPriceMinor`, поэтому клубная доплата не может
разойтись между превью и записью, а несовпадение закрывается отказом (`GROUP_DISCOUNT_QUOTE_CHANGED`),
не списанием.

## Денежный мандат клубной тренировки

Клубные формы отличаются от конфигурируемого процента события, поэтому reviewed-мандат
`lk1EventPaymentBinding` (он требовал «посещение не списывается и скидка равна полю правила»)
их бы отверг — и уже **после** подтверждённой записи в Viva, оставляя неоплаченную бронь.
Поэтому мандат разрешается через `lk1EventPaymentQuoteBinding`:

- доля выше бесплатного часа: посещение списывается, к оплате идёт
  `floor(база × paid / (free + paid))` минус процент решения (75 %), и запись остаётся
  `paymentType=SUBSCRIPTION` (посещение тратится, доплата выставляется транзакцией);
- нет бесплатного часа: `decision.eventDiscountPercent = 0`, к оплате полная базовая цена;
- пустой/непроверяемый вердикт по-прежнему возвращает `null` и закрывает шаг
  (`LK1_GROUP_PAYMENT_BINDING_INVALID` / `LK1_TOURNAMENT_PAYMENT_BINDING_INVALID`), не проводя денег.

## Затронутые узлы и endpoint'ы

- `POST /lk/subscription-bookings` — узлы `lk_subscription_booking_router_20260804` (gateway),
  `lk_subscription_managed_policy_20260820` (решатель) и
  `lk_subscription_price_preview_20260908_evaluate` (тот же решатель в превью).
- `POST /lk/subscriptions/game-price-preview` — узел `lk_subscription_price_preview_20260908_router`.
- Глобал `subscriptions_lk1_plan_rules` (guarded-запись внутри `initialize` шлюза).
- Фронтенд: окно записи ЛК1 на `/group` и витрина Топократов (`group-schedule.js`).

## Проверки (LOCAL)

- `node --experimental-strip-types --test scripts/tests/lk1TopokratyFriendship.test.mjs` — 12/12 PASS.
- `node --experimental-strip-types --test scripts/tests/lk1*.test.mjs scripts/tests/lk1*.test.ts` —
  385 тестов, 302 pass, 83 skip (приватные live-фикстуры), 0 fail.
- `node --experimental-strip-types --test` по подписочным наборам (`subscription*`, `managedSubscription*`,
  `groupEventPayment`, `groupScheduleSubscriptionOffer`, `proTrainingExclusion`,
  `tournamentSubscriptionDiscount`, `groupSubscriptionDiscount`) — 718 тестов, 626 pass, 88 skip,
  4 fail. Эти 4 (`subscriptionBindingPatch` ×2, `subscriptionReturnVerificationPatch` ×2) падают
  идентично на чистом `origin/main` (eacdab61) — красный baseline, к изменению не относятся.
- `npx tsc --noEmit -p tsconfig.app.json` — 0 ошибок.
- `npx eslint` по изменённым файлам — 0 ошибок (три Node-RED источника исключены конфигом ESLint,
  как и раньше).

## RELEASE (не выполнялся)

Живой флоу `147` не читался, ничего не деплоилось, не импортировалось и не рестартилось; глобал
`subscriptions_lk1_plan_rules` на серверах не менялся. Для включения нужен авторизованный
CRITICAL-проход:

1. Свежий read-only pull флоу с `147` (`nodered:modular:pull-147`) в приватный внешний воркспейс,
   сверка sha и числа узлов; `HUB_PREIMAGES`, `preimages.json` и пины поколений — только по нему.
2. Новая focused-генерация `patch_live_lk1_topokraty_friendship_hotfix.mjs` по образцу
   `patch_live_lk1_pro_training_exclusions_hotfix.mjs`: вставить клубную ветку и помощники в
   **установленное** тело решателя (якоря — `const floorRatio = (amount, numerator, denominator) => {`,
   `  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {` и
   `const { selectedRule, surchargeMinor, category } = selectBenefit();`), `directionId` и
   `lk1ExpectedEventDiscountPercent` — в тело шлюза, ветку `paidShare` — в роутер превью; пересобрать
   preview-композицию тем же `previewSources(flow, { pins })`.
3. Guarded-запись plan-rules: приоритет — установленный payload (7 правил), desired —
   `LK1_PLAN_RULES_WITH_TOPOKRATY`; блок `initialize` заменяется, а не дописывается (иначе
   повторный прогон вернёт старый глобал).
4. Перепины `PLAN_RULES_TARGETS.*` (live/patched sha), `PREVIEW_CANONICAL_SOURCE_SHA256.booking`,
   `preimages.json`, `HUB_PREIMAGES` — по свежему телу; exact-graph contract и postcheck.
5. Приёмка: read-only превью и запись по абонементу клуба дают одинаковую сумму; проверяются
   четыре сценария (полный час, 90 минут после 30 израсходованных, исчерпанный день, ≥ 4 активных
   записей).
6. Откат — упорядоченный: сначала `buildTopokratyPlanRulesRevert()` (guarded-возврат
   установленного payload из 7 правил), затем откат генерации решателя. Обратный порядок
   оставил бы в глобале клубный продукт, а старый решатель без клубной ветки посчитал бы
   тренировку 6233 обычными 50 % вместо доплаты.

## Остаточные риски

- **Асимметрия правила.** Когда бесплатного часа нет, клубная тренировка идёт по полной разовой
  цене без скидки (решение владельца), тогда как игра/турнир той же подписки сохраняют стандартные
  скидки 30 %/50 %. Это осознанное решение, но его стоит перепроверить на реальных продажах.
- **Скоуп продукта.** Правило продукта не ограничено станцией: пока у подписки нет станционных
  исключений, она даёт стандартные льготы «Дружбы» на любых станциях, а клубная доплата действует
  в направлении `6233` независимо от станции. Если клуб продаёт подписку только для своих кортов,
  нужен отдельный station-exclusion/allow-list.
- **Списание посещения.** Клубная тренировка тратит общий дневной счётчик минут и одно посещение;
  при исчерпанном балансе посещений (visitsLeft = 0) решателя это не блокирует — блокировка
  остаётся на стороне Viva (как и для остальных продуктов контура).
- **Пины поколений.** Локально доступны только source-пины; live-body пины пересчитываются на
  свежем pull (см. RELEASE). До этого момента патчеры старших поколений на новом теле не пройдут
  preimage-guard — это ожидаемый fail-closed.
- **Доплата против SUBSCRIPTION-брони (нужно живое подтверждение).** В клубной частичной форме
  запись идёт с `paymentType=SUBSCRIPTION`, а `lk1PrepareEventPayment` ищет разовый продукт Viva
  по `bookingId` и требует `cost === basePriceMinor`. Если Viva не отдаёт разовый продукт против
  подписочной брони, шаг остановится на `LK1_GROUP_PAYMENT_PRODUCT_UNAVAILABLE` (деньги не
  двигаются, но бронь уже подтверждена). Альтернатива — вести клубную доплату «платной игрой»
  (ON_PLACE + visit job); выбор подтверждается первым живым прогоном.
- **Правило требует направления в DTO.** Если боевое упражнение придёт без `direction`/`directionId`,
  клубная ветка не сработает (без блокера) и превью/запись согласованно посчитают 50 % вместо
  доплаты — нужна read-only приёмка на направлении 6233 после включения.
- **В строгом prior нет «пустого» состояния.** `buildTopokratyPlanRulesTransition` требует ровно
  установленный payload из 7 правил; рантайм без глобала (невозможный на живом 147, но возможный
  на свежем стенде) будет отвергнут, а не молча перезаписан.
- Красный baseline `subscriptionBindingPatch`/`subscriptionReturnVerificationPatch` (4 теста) не
  связан с изменением, но остаётся в наборе.
