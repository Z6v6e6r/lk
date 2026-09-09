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
- CTA открывает существующую `/ab_leto?variant=single_artwork&artworkKey=...&autoPurchase=0` в соответствующем prod/dev канале. Авторизация и платёж остаются в LK1.
- Новый адаптер не создаёт платежи. Существующий API client может отправлять диагностику при ошибках запросов.
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
- В редакторе Tilda получена форма входа. Страница не создана/не опубликована.
- Merge, push, Draft PR, deploy, provider/database mutation отсутствуют.

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
