# Промокод обычной месячной «Дружбы» на /sub_hab

Владелец: PadlHub LK. Аудитория: покупатели обычной месячной «Дружбы».
Кнопка «у меня есть промокод» открывает существующий диалог входа, ввода кода,
проверки скидки и подтверждения итоговой цены. Годовая «Дружба» и клубные варианты
не получают нового платёжного маршрута. Полностью бесплатная покупка этим новым
маршрутом не поддерживается: перед созданием транзакции требуется положительная сумма.

Обычная покупка сохраняет counter gateway. Покупка с кодом проходит тот же
`POST /lk/tournaments/summer-subscription/purchase`, включая admission, остаток,
дневную квоту и существующую регистрацию/подтверждение оплаты. Обе кнопки используют
общий product/phone lock; после неоднозначной отправки promo сохраняется блокировка
повтора. Только явный ответ `promoAttempt` с `schemaVersion: 1`,
`providerAttempted: false` и совпадающим `paymentRef` снимает её после отказа до create.
Код и телефон в новом локальном marker не сохраняются.

## Контракт и источники

- `GET /lk/tournaments/summer-subscription/status?counterKey=friendship` возвращает
  `promoCodeSupported: true` только при включённом серверном
  `summer_subscription_friendship_promo_enabled`.
- Purchase принимает `promoCode` (непустая строка до 100 символов) и
  `expectedPromoQuote: { productId, sumMinor, discountMinor, toPayMinor }` только для
  обычной месячной `friendship`. Все суммы — целые копейки; сумма и скидка сверяются
  с продуктом и свежим Viva preview, а не становятся ручной скидкой в create.
- Диалог использует существующий end-user Viva `POST /transactions/preview`.
  Node-RED перед create проверяет admin Viva `POST /api/v1/transactions/preview`
  с методом `WIDGET`, затем отправляет ровно один `POST /api/v1/transactions`
  с тем же кодом и методом. `discount` в строке продукта не задаётся.
- Ответ create должен содержать transaction id, ссылку банка и точную согласованную
  `toPay`. Для promo отключён legacy fallback повторного create с другим методом.
- Возврат банка использует существующий `summerPaymentRef` и штатный confirm.

Изменённые function sources:

- `fn_tournament_subscription_purchase_prepare.js`
- `fn_tournament_subscription_purchase_limit.js`
- `fn_tournament_subscription_purchase_router.js`
- `fn_tournament_subscription_status_response.js`

Генерируемые flow/import JSON не менялись. Сборка/выкладка backend требует свежего
live preimage и отдельного focused source-driven кандидата по действующим правилам
Node-RED; нельзя выкладывать целый stale локальный flow.

## Граница готовности и остановка

Флаг по умолчанию выключен. До включения обязательны проверка реального контракта
admin preview (endpoint, поля `sum/discount/toPay`, единицы и `WIDGET`) и сравнение
с end-user preview на разрешённом тестовом контуре. Эти live проверки в данной
сессии не выполнены: публичный API и SSH сервера 147 недоступны. Реальная покупка
не выполнялась. Успех VM-тестов не подтверждает доступность provider endpoint.

Порядок разрешённого будущего выпуска: проверенный контракт provider -> свежий live
preimage -> focused backend candidate/review -> согласованная выкладка backend ->
публикация чистого frontend artifact -> отдельное включение флага -> проверка
status/диалога и наблюдение. Merge, deploy и изменение флага требуют отдельной
авторизации в соответствии с AGENTS.md.

Сигнал остановки: несовпадение цены, отсутствие capability, ошибка preview или
неоднозначный create. Метод остановки: выключение
`summer_subscription_friendship_promo_enabled`; повторная отправка неподтверждённой
покупки запрещена. Выключение флага не отменяет уже созданные транзакции.
Существующая legacy гонка между проверкой остатка и записью резерва не исправляется
этим изменением; прямого обхода gateway новый promo маршрут не добавляет.

## Проверки и изменённые файлы

Локально: `npm run build` (prod/dev, публичные VITE-настройки существующего checkout),
`npx tsc -b`, обе сборки `build:subscription-storefront`, scoped ESLint,
`git diff --check`. Профильные promo/storefront/Node-RED тесты пройдены.
Первый локальный проход critical matrix обнаружил три несовпадения исторических source pins:
добавлен отдельный successor, исторический error patch проверяется на его
immutable candidate; исправленные historical/source-chain проверки пройдены.
Private live-preimage composition, provider preview и реальные платежи не проверены.
В браузере на подставных API проверены desktop/390 px: auth gate, открытие
диалога, применение, итоговая цена, сброс quote после изменения текста и закрытие
с восстановлением фокуса. Платёжный create в браузере не вызывался.

Изменения:

- `docs/SUB_HAB_FRIENDSHIP_PROMO.md`
- `scripts/lib/subscriptionSourceGenerationPins.mjs`
- `scripts/nodered_games_nodes/fn_tournament_subscription_purchase_limit.js`
- `scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js`
- `scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js`
- `scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js`
- `scripts/subscription_friendship_promo_generation.json`
- `scripts/tests/lk1ErrorSourceFixes.test.mjs`
- `scripts/tests/subscriptionPaymentPolling.test.mjs`
- `scripts/tests/subscriptionPromoCode.test.ts`
- `scripts/tests/subscriptionStorefront.test.ts`
- `scripts/tests/tournamentSubscriptionSalesCandidate.test.mjs`
- `src/components/subscription-storefront/SubscriptionPage.tsx`
- `src/components/subscription-storefront/SubscriptionPromoCodeDialog.tsx`
- `src/components/subscription-storefront/catalog.ts`
- `src/components/subscription-storefront/payment.ts`
- `src/components/subscription-storefront/promoCodePayment.ts`
- `src/utils/apiClient.ts`

CI на первом commit подтвердил полную critical regression matrix. В следующем
шаге обнаружены ещё два source-generation/topology несовпадения. Новый hash
роутера добавлен в существующий guard: function-only композиция по-прежнему
запрещена, старый unified production candidate остаётся UNBOUND. Целевые
13 тестов и scoped ESLint после исправления пройдены.

Дополнительно изменены:

- `scripts/lib/piterAtomicTopologyContract.mjs`
- `scripts/tests/lk1SubscriptionEnforcementCandidate.test.mjs`
- `scripts/tests/piterAtomicTopologyContract.test.mjs`
