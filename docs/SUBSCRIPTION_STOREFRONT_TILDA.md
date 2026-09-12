# Витрина подписок для Tilda `/subsription`

Подготовлена отдельная IIFE-витрина по схеме LK1. UI перенесён из
[LK2 PR #173](https://github.com/Z6v6e6r/lk2/pull/173), автор Orlik780,
head `53753ac9e607a00b7b2d64a77bbac08c430fc221`.
PR направлен в feature-ветку `codex/subscription-storefront-ui-20260831`,
base `15f4452521b494538adcca1df2e68209c5d56897`, а не в `main`.
GitHub status checks на момент проверки отсутствовали.

LK1-база: `160180124d5708f2a71f0480f6e6dc682620158f` (`origin/main`).
Ветка: `codex/subscription-skins-tilda-20260909`. Основной dirty checkout сохранён.

## Результат ревью исходного PR

| Приоритет | Файл и строка в PR | Подтверждённый сценарий |
|---|---|---|
| P1 | `preview/SubscriptionStorefrontTestPreview.tsx:76` | `purchaseBusy` не блокирует повторный POST; каждый клик создаёт новый paymentRef. |
| P2 | `preview/summer-subscription-api.ts:14` | DEV base пустой, а Vite не проксирует `/lk`; документированный live preview получает HTML вместо JSON. |
| P2 | `preview/SubscriptionStorefrontTestPreview.tsx:41` | Параллельный polling раз в 5 секунд позволяет старому ответу перезаписать новые цены и доступность. |

Пути в таблице относительны `apps/web/src/features/subscription-storefront/`.
Исходные локальные тесты PR прошли: 4 файла, 28 тестов. Наличие дефектов выше
означает, что одного зелёного тестового набора недостаточно для публикации live preview.
Комментарии в GitHub не отправлялись; PR не изменялся и не объединялся.

## Реализация LK1

- Отдельные `subscription-storefront.js` и `subscription-storefront-dev.js` с CSS, SVG и шрифтами внутри JS.
- API виджета: `window.LKWidgetSubscriptionStorefront.mount({targetId, onClose})` и `unmount()`.
- Контейнер по умолчанию: `padlhub-subscriptions`. Повторный mount удаляет предыдущий React root.
- Подключение T123: `docs/tilda-subscription-storefront.html`.
- Карточки: Дружба, РА, Академия. Снятый с витрины Спорт и демонстрационные X2/годовые цены не добавляются.
- Цены/остатки — существующий `apiFetchTournamentSubscriptionStatus`. Неизвестная цена не подменяется нулём/моком.
- Последовательное обновление через 30 секунд, timeout 12 секунд, отмена при unmount/retry. Ошибка обновления блокирует CTA.
- CTA создаёт оплату внутри витрины и уводит на `paymentUrl` банка: «Дружба 30 дней» и «Дружба год» — через `POST /lk/tournaments/summer-subscription/purchase` (`counterKey` `friendship` / `network_friendship`), «РА» и «Академия» — через `POST /end-user/api/v1/<tenant>/transactions` по своим продуктам. Переход на `/ab_leto` с `autoPurchase` из витрины убран.
- Неавторизованному клиенту показывается то же окно авторизации, что на `/ab_leto` (общий `AuthForm`; его стили из `MyApp.css` продублированы в `storefront-auth.css`/`storefront-auth-overlay.css`, потому что на Tilda-странице стили кабинета не подключены); после входа оплата продолжается кнопкой «Продолжить оплату». Для годовой подписки требуется явное согласие с условиями.
- После оплаты банк возвращает клиента на страницу витрины с `summerPaymentRef`, виджет подтверждает платёж через `confirm` и переводит подтверждённую оплату в личный кабинет (`cabinetUrl`, по умолчанию `/lk_new`).
- Новый адаптер не создаёт обходных платежей: он вызывает те же LK1-контракты, что и страница `/ab_leto`. Существующий API client может отправлять диагностику при ошибках запросов.
- Автопрокрутка из PR не переносилась; лента поддерживает ручной scroll и клавиши ←/→/Home/End. Размеры ограничены контейнером Tilda.
- `apiFetchTournamentSubscriptionStatus` получил необязательный второй параметр `{signal}`; прежние вызовы совместимы.

## Сборка и локальная проверка

```sh
npm run build:subscription-storefront
npm run build:subscription-storefront:dev
npx vite --host 127.0.0.1 --port 5193 --strictPort
```

Предпросмотр: `http://127.0.0.1:5193/docs/subscription-storefront-preview.html`.
Он загружает собранный prod IIFE; данные демонстрационные, CTA отключены, запросов каталога нет.
Вспомогательный previewView принимается только на localhost/127.0.0.1/file preview.

Интерактивная проверка оплаты без боевых запросов:

```sh
node scripts/preview-subscription-storefront.mjs      # http://127.0.0.1:5194/?auth=1
node scripts/check-subscription-storefront-payment.mjs # headless-проверка клика и редиректа
```

Харнесс отдаёт собранный `dist/subscription-storefront` и подменяет в `window.fetch`
status/purchase/confirm/transactions, поэтому клик по CTA доходит до «банка» локально
и не создаёт реальную транзакцию.

Файлы сборки лежат в `dist/subscription-storefront/`:

- `subscription-storefront.js`, `release.json`;
- `subscription-storefront-dev.js`, `release-dev.json`.

Ожидаемые адреса после отдельной публикации:

- prod: `https://padlhub.su/lk/subscription-storefront/`;
- dev: `https://lk-reserve.89-108-64-209.sslip.io/lk/subscription-storefront/`.

T123 читает собственный release-манифест и добавляет `?v=` к JS по схеме LK1.
Новая сборка не заменяет общий `release.json` или существующие LK1 bundles.
Текущий общий deploy скрипт не публикует этот новый каталог автоматически: до выпуска
нужно включить каталог в согласованный механизм публикации статических артефактов.

## Проверки и ограничения

- LOCAL: 28/28 исходных тестов PR.
- LOCAL: 17/17 тестов адаптера, каталога, status loader и нормализации платежного статуса.
- LOCAL: полный frontend TypeScript check; ESLint новых компонентов, entrypoint, Vite config и затронутого apiClient — без ошибок.
- LOCAL: prod/dev IIFE builds; `git diff --check`.
- LOCAL UI: desktop 1280, mobile 375, tablet 768; документ не расширяется горизонтально; mount/unmount/remount; консоль без warn/error в макете.
- Independent review: исходный платёжный preview проверен отдельно; timeout-дефект нового адаптера исправлен и повторно проверен.
- Полный `npm run lint`: 0 errors, 387 warnings вне затронутого набора.
- Полный `npm run build` остановлен build-env preflight: в изолированной рабочей копии отсутствуют ignored `.env`/VITE-переменные общего LK1. Самостоятельные prod/dev сборки новой витрины прошли.
- Node-RED suite, CI и реальные платежи не запускались: backend/платёжный обработчик не меняются.
- Тексты преимуществ взяты из PR. Фактическое применение этих условий/скидок у провайдера не проверялось.
- Первоначально редактор Tilda требовал входа. Позже создан черновик страницы `233220109` с alias `subsription`, сохранён и повторно проверен T123 loader. Страница не опубликована.
- Исходный checkpoint: `5719399`. Позже локально интегрирован и отправлен `main` `7342973`. Deploy и публикация Tilda не выполнялись; Draft PR не создавался, provider/database mutation в этой задаче отсутствуют.

## Прямая оплата из витрины (2026-09-11)

- Задача: кнопки на `https://padlhub.ru/subsription` больше не должны уводить на `/ab_leto` с `autoPurchase=0`, а должны сразу открывать оплату.
- Реализация: `payment.ts` (адаптер покупки), кабинетный `AuthForm` в окне входа, `SubscriptionPage.tsx` (состояния, согласие, подтверждение после банка), `subscription-storefront.tsx` (`AuthProvider`, `cabinetUrl`), `subscriptions.css`; навигационный `subscriptionCheckoutUrl` удалён.
- LOCAL: `node --experimental-strip-types --test scripts/tests/subscriptionStorefront.test.ts` — 8/8 PASS (включая VM-тест привязки счётчиков и продуктов).
- LOCAL: `tsc --noEmit -p tsconfig.app.json` PASS; ESLint затронутых файлов PASS; `git diff --check` PASS.
- LOCAL: prod/dev IIFE builds PASS (`dist/subscription-storefront/subscription-storefront.js` ≈2.44 МБ, базовая live-сборка ≈2.37 МБ).
- LOCAL E2E (headless Chrome + CDP, `scripts/check-subscription-storefront-payment.mjs`): неавторизованный клик открывает окно входа по SMS; авторизованный клик вызывает `POST /lk/tournaments/summer-subscription/purchase` с `counterKey=friendship`, сохраняет `paymentRef` в pending-хранилище и переходит на `paymentUrl` банка. PASS.
- НЕ проверено на этом этапе: боевые API SERV2/Viva (обе проверки шли на подменённом `fetch`), боевой Node-RED `network_friendship`/`ra`, реальная транзакция, выкладка на prod/dev, страница Tilda.

## Browser-комментарии по `/subsription` (2026-09-11, вторая итерация)

- Согласие с условиями годовой подписки больше не показывается над витриной: сообщение открывается отдельным окном только по нажатию «Оформить подписку» и остаётся обязательным гейтом — без отметки кнопка «Продолжить оплату» недоступна и платёж не создаётся. Вход для гостя и подтверждение условий идут последовательно, окна не накладываются.
- Карточки приведены к присланному макету: одинаковая высота у всех карточек, заливка рамки «Дружба» в цвете бейджа, CTA без заливки у всех планов кроме РА, подпись цены «/ 30 дней» вместо «мес.», заголовок «1 час в день бесплатно:», строка «ⓘ До 4 активных записей на 2 недели вперёд» в нижнем колонтитуле карточки.
- Добавлена карточка «Абонемент «Энергия 5»»: цена и доступность берутся из существующего статуса `counterKey=energy5`, покупка идёт тем же прямым продуктовым контрактом (`apiBuySubscroption`, продукт `dfa72adf-233b-4285-8d69-e5eab4234fbe`), что и РА/Академия. Без ответа с валидной ценой карточка не рисуется, цена не подменяется.
- LOCAL: `node --experimental-strip-types --test scripts/tests/subscriptionStorefront.test.ts` — 13/13 PASS; `tsc --noEmit -p tsconfig.app.json` PASS; ESLint затронутых файлов PASS.
- LOCAL: prod/dev IIFE builds PASS; `node scripts/check-subscription-storefront-payment.mjs` на локальном харнессе — три сценария PASS (гость, «Дружба 30 дней», годовая с окном условий), платёж идёт на подменённый `fetch`.
- LOCAL UI: desktop 1400/1600 и mobile 390 — одинаковая высота, колонтитул внизу карточки, зелёная рамка «Дружбы», CTA без заливки кроме РА, карточка «Энергия 5».
- НЕ проверено: боевой ответ `/summer-subscription/status` для `energy5` (в момент проверки публичный endpoint не отвечал), реальная продажа «Энергии 5», выкладка bundle, страница Tilda и боевые Viva/SERV2.

### Уточнения по тому же кругу (2026-09-11, вечер)

- Колонтитул карточек сокращён до «До 4 активных записей» (без «на 2 недели вперёд»).
- Кнопка «Другие действия» (⋯) удалена со страницы вместе со ссылками «Личный кабинет»/«Главная»; ветка `onMore` в компоненте сохранена для хостов, которые её передают.
- Стрелка «Назад» больше не занимает отдельную строку: навигация вынесена из потока и наложена на полосу заголовка, поэтому на мобильном карточка помещается без прокрутки.
- В `.subscription-storefront__hero` добавлен `background: transparent`: локальный preview-харнесс (и потенциальная host-CSS Tilda) стилизует голый `header`, из-за чего заголовок получал чёрную заливку. Правило харнесса тоже сужено до `body > header`.
- LOCAL: focused 13/13, TypeScript, ESLint, prod/dev builds и headless-проверка CTA (три сценария) — PASS. Проверки UI: desktop 1400 и mobile 390.

### Годовая цена «Дружбы» (2026-09-11)

- Витрина не хранит цену: карточка показывает `priceMinor` из `GET /lk/tournaments/summer-subscription/status?counterKey=network_friendship`. Поэтому «98 000 ₽» на карточке появятся ровно тогда, когда живой счётчик начнёт возвращать 9 800 000 minor.
- Одобренная цена ХАБ зафиксирована в `docs/HAB_ANNUAL_PRICE_98000_20260909.md`: каталог Viva уже показывает 98 000 ₽, а публичный статус LK возвращает 56 800 ₽, пока в Node-RED не включён флаг `summer_subscription_network_friendship_price_98000_enabled` (кандидат: `scripts/prepare_hab_annual_price_candidate.mjs` + `scripts/nodered_games_nodes/init_hab_annual_price_98000.js`). Включение флага — живая операция на `147`, отдельная от этой фронтенд-задачи и не выполнявшаяся.
- В локальном preview-харнессе заглушка `network_friendship` приведена к одобренной цене 9 800 000, чтобы макет проверялся с «98 000 ₽ / год»; боевая выдача при этом не менялась.

### Переключатель карточек по макету (2026-09-11)

- Точечный индикатор `subscription-rail-dots` заменён именованным переключателем под лентой: белая «пилюля» с пунктами «Дружба / РА / Академия / Энергия», активный пункт — тёмная заливка, как в макете. Пункт ведёт к своей карточке, стрелки ←/→ внутри переключателя двигают выбор, `aria-current`/`aria-controls` сохранены.
- В `model.ts` добавлен `shortLabel`, в презентации — короткие имена: `Дружба`, `РА`, `Академия`, `Энергия` (полное «Абонемент «Энергия 5»» остаётся заголовком карточки).
- Одна кнопка на план: позиции карточек больше не схлопываются, поэтому на широком экране, где последние карточки упираются в правый край, переключатель всё равно показывает все четыре пункта.
- LOCAL: focused 13/13, TypeScript, ESLint, prod/dev builds; UI desktop 1400 и mobile 390 — клик «Энергия» прокручивает ленту и переводит активный пункт. Headless-проверка CTA (три сценария) — PASS.

### Мобильная посадка на один экран (2026-09-11)

- Уплотнены только мобильные контейнеры (`subscription-storefront` ≤ 719px и `subscription-card` ≤ 400px): canvas 12px/14px, заголовок 24px с gap 10px, панель карточки 16/14/16 с gap 14px, CTA 44px, меньше межстрочные интервалы в списках, компактнее переключатель. Десктопная раскладка не менялась.
- Локальный preview-харнесс получил `meta viewport` и переносимый лог: без этого страница харнесса расширяла layout до 471px и масштабировала измерение.
- Измерение headless Chrome 393×852: hero 88–131, карточка 155–690 (535px), переключатель 704–750 — весь блок помещается в один экран, `pageScrollHeight` растёт только из-за отладочного лога харнесса.
- Проверки: focused 13/13, TypeScript, ESLint, prod/dev builds, desktop 1400 без изменений, headless CTA (три сценария) — PASS.

### Подпись недоступного варианта (2026-09-11)

- У недоступного варианта «месяц 2 часа» кнопка теперь читается «Скоро. Может быть» вместо «Скоро»; пояснение «Дружба 2.0 скоро появится в продаже» осталось под кнопкой. Кнопка по-прежнему `disabled`, покупка этого варианта отклоняется в `payment.ts` (`resolveStorefrontBillingTarget` возвращает `null`).

### 375px и короткие экраны (2026-09-11)

- Стрелка «Назад» на узких телефонах уменьшена до 38px и прижата к углу (`top: 6px; left: 4px`): на 375px её правая граница 50px, первая строка заголовка начинается с 65px — пересечения нет.
- Добавлен компактный режим для коротких экранов: `@media (max-height: 700px)` + контейнерные запросы уменьшают поля canvas, заголовок до 22px, панель карточки до 12px, CTA до 40px и переключатель.
- Замер headless Chrome 375×667 (вместе с баннером харнесса): hero 42–81, карточка 105–614, переключатель 624–666 — всё в пределах экрана. Замер 393×852: карточка 113–649, переключатель 663–709.
- Баннер локального preview-харнесса сокращён до одной строки, чтобы он не искажал мобильные замеры.

### Колонтитул абонемента и нижний переключатель (2026-09-11)

- У «Абонемента «Энергия 5»» убрана строка «До 4 активных записей…»: у пяти занятий нет ограничения на активные записи, поэтому общая `planning`-заметка к этой карточке не подключается (`energy5Benefits` больше не использует `planning`).
- Для остальных планов текст заметки возвращён к макету — «До 4 активных записей на 2 недели вперёд»; на телефонной ширине шрифт заметки 10px, чтобы строка оставалась в одну строку.
- На телефоне переключатель прижат к нижнему краю экрана: `margin-top: auto` в растянутой flex/grid-цепочке canvas → content → sections → section плюс `position: sticky; bottom: 8px` (4px в коротком режиме). Замеры: 393×852 — переключатель 798–844, карточка 113–649; 375×667 — переключатель 621–663, карточка 103–618 (пересечения нет).

### Окно входа как в кабинете (2026-09-11)

- `.subscription-auth-block` переведён на белый фон (`#fff`, граница `#ededed`), заголовок и подпись — тёмные/серые, крестик — серый на светлом: раньше окно было тёмным, а кабинетный `AuthForm` рассчитан на белый `.auth-wrapper` (`background: var(--white)` в MyApp.css), поэтому блок «войти в личный кабинет» с VK ID/Mail.ru и Yandex выглядел иначе, чем в ЛК.
- Тот же светлый фон получило окно подтверждения годовых условий (общая оболочка `.subscription-auth-block`).
- Проверки: focused 13/13, ESLint 0 ошибок, prod/dev сборки, headless CTA (три сценария) — PASS; UI 393×852 для окна входа и окна условий.

## Выкладка 2026-09-11 (release 20260911T190102Z)

- Источник: `main` = `b9769074d380e67f50f0311eacf4edc4d34a118c` (чистое дерево), prod-манифест `20260911T190102Z`, dev-манифест `20260911T190104Z`, `sourceDirty=false`.
- Куда: `lk-primary-147:/var/www/html/lk/subscription-storefront/` (prod-пара) и `lk-reserve-89:/var/www/html/lk/subscription-storefront/` (prod- и dev-пары). Прежние файлы сохранены рядом как `*.backup-6e63c08-20260911T1910Z`.
- Хеши совпали локально, на хостах и публично: prod `dbb32c5e3024…` (2 488 870 байт), dev `06f31dc96cea…` (2 489 328 байт).
- Публичный readback: `https://padlhub.su/lk/subscription-storefront/release.json` → `20260911T190102Z` / `b976907`; dev-манифест на резервном origin → `20260911T190104Z` / `b976907`.
- Постпроверка живой страницы `https://padlhub.ru/subsription` (headless Chrome, 393×852, только чтение): грузится бандл `?v=20260911T190102Z`, видны четыре карточки (Дружба, РА, Академия, Абонемент «Энергия 5» 19 800 ₽ / 5 занятий — публичный `energy5`-статус отдаёт цену), рамка Дружбы зелёная `#49d8a1`, РА фиолетовая `#9a74ef`, Академия лаймовая `#91dd1c`, кнопки без заливки кроме РА, колонтитул «До 4 активных записей на 2 недели вперёд» есть у трёх подписок и отсутствует у абонемента.
- Годовой вариант «Дружбы» на живой странице показывает **98 000 ₽ / год** — публичный счётчик уже отдаёт 9 800 000 minor, отдельного включения Node-RED-флага не потребовалось.
- Наблюдение: на телефоне нижний переключатель прижат к краю экрана (786–832 при 852), поэтому до принятия cookie-баннера Tilda баннер перекрывает его; после «Ок» переключатель виден.

### Растяжение карточки и текст заметки (2026-09-12)

- На телефоне карточка тянется до ряда переключателей при любой высоте экрана: `.subscription-rail-frame { flex: 1 1 auto }`, `.subscription-plan-rail { height: 100% }`, у переключателя остаётся только `margin-top: auto` (sticky убран — он поднимал блок и давал наложение на карточку). Замеры без баннера харнесса (`?bare=1`): 375×667 — карточка 76–611, переключатель 611–653; 393×852 — карточка 87–786 (699px), переключатель 786–832. Наложений нет, карточка упирается в переключатель.
- Колонтитул снова сокращён до «До 4 активных записей» (без «на 2 недели вперёд»).
- В preview-харнессе появился параметр `?bare=1`: он убирает отладочный баннер, чтобы мобильная геометрия совпадала с Tilda-страницей.
- Проверки: focused 13/13, TypeScript, ESLint, prod/dev сборки, headless CTA (три сценария) — PASS. Первый холодный прогон харнесса упал по таймауту, три последующих прогона — PASS (флак холодного старта Chrome).


MODEL_ROUTE: parent

## Изменённые файлы

- `package.json`
- `src/utils/apiClient.ts`
- `src/subscription-storefront.tsx`
- `vite.config.subscription-storefront.ts`
- `scripts/tests/subscriptionStorefront.test.ts`
- `docs/tilda-subscription-storefront.html`
- `docs/subscription-storefront-preview.html`
- `docs/SUBSCRIPTION_STOREFRONT_TILDA.md`
- `src/components/subscription-storefront/SubscriptionOfferSection.tsx`
- `src/components/subscription-storefront/SubscriptionPage.tsx`
- `src/components/subscription-storefront/SubscriptionPlanCard.tsx`
- `src/components/subscription-storefront/SubscriptionStorefront.tsx`
- `src/components/subscription-storefront/assets/benefit-icons.ts`
- `src/components/subscription-storefront/assets/brand/подписка.svg`
- `src/components/subscription-storefront/assets/fonts/Inter_18pt-Regular.ttf`
- `src/components/subscription-storefront/assets/fonts/Inter_24pt-Regular.ttf`
- `src/components/subscription-storefront/assets/fonts/RFDewi-Bold.woff`
- `src/components/subscription-storefront/assets/fonts/RFDewi-Regular.woff`
- `src/components/subscription-storefront/assets/fonts/RFDewi-Semibold.woff`
- `src/components/subscription-storefront/assets/fonts/RFDewi-Ultrabold.ttf`
- `src/components/subscription-storefront/assets/fonts/RFDewiExpanded-Bold.ttf`
- `src/components/subscription-storefront/assets/icons/back.svg`
- `src/components/subscription-storefront/assets/icons/game.svg`
- `src/components/subscription-storefront/assets/icons/group.svg`
- `src/components/subscription-storefront/assets/icons/lightning.svg`
- `src/components/subscription-storefront/assets/icons/more.svg`
- `src/components/subscription-storefront/assets/icons/time.svg`
- `src/components/subscription-storefront/assets/icons/tournament.svg`
- `src/components/subscription-storefront/assets/icons/training.svg`
- `src/components/subscription-storefront/assets/plan-art/академия.svg`
- `src/components/subscription-storefront/assets/plan-art/дружба.svg`
- `src/components/subscription-storefront/assets/plan-art/ра.svg`
- `src/components/subscription-storefront/catalog.ts`
- `src/components/subscription-storefront/model.ts`
- `src/components/subscription-storefront/presentation.ts`
- `src/components/subscription-storefront/subscriptions.css`

## Исправление CI после push 2026-09-09

- GitHub run `34339637653` на `7342973` остановился на встроенном custody scan: семь шрифтов не были включены в список разрешённых бинарных ресурсов. До push этот встроенный сканер был пропущен при локальной проверке.
- Исправление ограничено семью точными путями и SHA-256 Git blobs в `.github/workflows/lk1-subscription-enforcement.yml`; запреты на остальные бинарные файлы, secrets/PII и подмену diff сохранены.
- В `scripts/tests/lk1SubscriptionEnforcementWorkflow.test.mjs` добавлены проверки хешей шрифтов, принятия разрешённых файлов, отказа при изменении пути и содержимого.
- Отдельный workflow suite: 13/13 PASS; `git diff --check`: PASS.
- Независимое release/security review: существенных замечаний нет, все семь хешей подтверждены по Git blobs.
- `npm run test:delivery`: 68 passed, 1 cancelled; отменён DEV readback с `Promise resolution is still pending but the event loop has already resolved`. Такая же отмена воспроизведена на неизменённом `7342973` отдельным запуском `scripts/tests/lk1DevFrontendRelease.test.mjs`; это ограничение baseline, не PASS.
- Последующая ошибка финализатора CI `ERR_MODULE_NOT_FOUND: js-yaml` возникла после раннего отказа scanner до установки зависимостей. Финализатор в этом исправлении не меняется.
- Эта коррекция подготавливается в прежней рабочей ветке; новая интеграция и отправка main требуют следующих отдельных этапов.
