# Витрина расписания «Время Атланты» (`atlanty-schedule.js`)

Виджет для блока Tilda T123: подтягивает события VivaCRM по выбранным категориям
и показывает их карточками турнира с горизонтальным слайдером. Клик по карточке
открывает карточку события с кнопкой «Записаться» (попап записи Viva).

## Где что лежит

| Что | Где |
| --- | --- |
| Бандл витрины | `https://padlhub.su/lk/atlanty-schedule.js` |
| Фото для шапок карточек (30 шт.) | `https://padlhub.su/lk/atlanty-cards/<name>` |
| Вставка для Tilda | `docs/tilda-atlanty-schedule.html` |
| Точка входа | `src/atlanty-schedule.tsx` |
| Сборка | `vite.config.atlanty-schedule.ts` |
| Модель данных | `src/utils/atlantyScheduleModel.ts` |
| Загрузка из Viva | `src/utils/atlantyScheduleApi.ts` |
| Категории/тема | `src/utils/atlantyScheduleTheme.ts`, `src/utils/atlantyScheduleImages.ts` |
| Тесты | `scripts/tests/atlantySchedule.test.ts` (`npm run test:atlanty-schedule`) |

## Установка в Tilda

Рекомендуемый способ — **четыре отдельных блока T123** (`docs/tilda-atlanty/`):
настройки, витрина, попап записи и (по желанию) оформление. Порядок и правила —
в `docs/tilda-atlanty/README.md`; там же вариант «служебные блоки один раз на весь
сайт, витрина — на конкретной странице».

Быстрый способ — **один монолитный блок**: вставить целиком содержимое
`docs/tilda-atlanty-schedule.html`.

В обоих вариантах: конфиг категорий, загрузчик бандла (версия из
`/lk/release.json` для cache-bust, старт после `DOMContentLoaded`) и инициализация
попапа записи Viva отдельным инстансом `atlanty`. Если на странице уже есть виджет
Viva с другим инстансом — конфликта нет.

## Конфиг

```js
var ATLANTY_CATEGORIES = [
  { directionId: 6152, typeId: 2349, label: "Клубное мероприятие", badge: "Бесплатно по подписке" },
  { directionId: 5278, typeId: 839,  label: "Время на друзей",     badge: "50% скидка по подписке" }
];

window.LK_ATLANTY_SCHEDULE_CONFIG = {
  categories: ATLANTY_CATEGORIES,
  title: "",            // необязательный заголовок над слайдером
  maxEvents: 24,        // сколько ближайших событий показывать всего
  maxPerCategory: 6,    // сколько брать из каждой категории (0 — без квоты)
  daysAhead: 120,       // горизонт расписания
  vivaInstance: "atlanty"
};
```

### Категории

| Поле | Значение |
| --- | --- |
| `directionId` | `direction.id` из Viva — попадает в серверный фильтр `directions` |
| `typeId` | `type.id` из Viva — нужен попапу записи, чтобы он видел событие |
| `label` | текст пилюли на карточке (по умолчанию — название направления) |
| `badge` | текст бейджа на шапке (пусто — бейджа нет) |
| `enabled` | `false` временно выключает категорию |

Пресеты для короткой записи: `"atlanty"`, `"friends"`, `"friends-special"` —
`categories: ["atlanty", "friends"]`.

**Как добавить категорию** (например «Патриоты», когда направление появится в Viva):
дописать одну строку в `ATLANTY_CATEGORIES` с её `directionId`/`typeId`. Пересборка
бандла не нужна — конфиг читается на странице.

### Внешний вид и поведение

| Опция | Значения |
| --- | --- |
| `cardsPerView` | число карточек в ряд (0 — фиксированная ширина; максимум 6) |
| `pillIcon` | `infinity` \| `users` \| `none` |
| `avatarMode` | `photo` \| `none` |
| `seatsStyle` | `segmented` («1/8 \| (+7 МЕСТ)») \| `plain` («1/8 (+7 мест)») |
| `levelStyle` | `meta` (строкой с иконкой) \| `chip` (отдельной плашкой) |
| `detailModal` | `true`/`false` — открывать карточку события по клику (по умолчанию да) |
| `images` | свой пул фото шапки (массив URL) |
| `imagePick` | `shuffle` (перемешать при загрузке) \| `hash` (стабильно по id, как в LK2) |

### Темизация

Цвета, шрифты, размеры и отступы — CSS-переменные; пример полного набора есть в
шапке `docs/tilda-atlanty-schedule.html`. Переопределять нужно **на
`.atlanty-schedule`** (или на более специфичном селекторе): у элемента объявлены
свои значения, поэтому правило на `:root` не сработает — унаследованное значение
проигрывает собственному.

Основные: `--atlanty-accent`, `--atlanty-accent-soft`, `--atlanty-text`,
`--atlanty-muted`, `--atlanty-border`, `--atlanty-radius`, `--atlanty-gap`,
`--atlanty-card-width`, `--atlanty-track-padding`, `--atlanty-title-size`,
`--atlanty-title-transform`, `--atlanty-pill-*`, `--atlanty-meta-*`,
`--atlanty-date-*`, `--atlanty-seats-*`, `--atlanty-font-display`,
`--atlanty-font-body`.

## Данные из Viva

Один запрос на все категории:

```
GET https://api.vivacrm.ru/end-user/api/v1/iSkq6G/exercises/period
    ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&size=500&page=0&directions=6152,5278
```

Важно: серверный фильтр — только `directions` (остальные, например
`exerciseTypeIds`, API молча игнорирует), поэтому в URL подставляется список
направлений. Если набор категорий не сводится к направлениям, параметр не
отправляется и отбор идёт на клиенте. Ответ кешируется в `sessionStorage` на 5
минут; ключ кеша включает набор категорий, поэтому смена конфига не отдаёт старые
данные. Таймаут запроса 12 с, при обрыве — одна повторная попытка (20 с).

## Фото на шапке

Пул — 30 клубных фото, те же, что LK2 раскладывает по карточкам рекомендаций
(`lk2.padlhub.su`). У LK2 в именах файлов хэш сборки, который меняется при каждом
деплое, поэтому файлы перезалиты на наш CDN со стабильными именами
(`skolkovo-*`, `premium-*`, `hero-*`, `card-art-*`, `promo*`, `nagatinskaya-*`).

- `imagePick: "shuffle"` (по умолчанию) — пул перемешивается при загрузке и
  раскладывается по позициям карточек: при листании фото не «прыгают».
- `imagePick: "hash"` — фото выбирается по `id` события (`s = s * 31 + код
  символа`, индекс = `hash % длина пула`) — как в LK2, стабильно между загрузками.
- Свои фото: положить файлы в `https://padlhub.su/lk/atlanty-cards/` и/или передать
  список в `images`.

## Сборка и публикация

```bash
npx vite build --config vite.config.atlanty-schedule.ts          # prod
npx vite build --config vite.config.atlanty-schedule.ts --mode dev
```

Бандл входит в `npm run build:prod` / `build:dev:bundles`, но **не входит в
закреплённый standard frontend-комплект** (16 файлов + bootstrap-схема + 16
nginx-путей), поэтому `deploy:prod` его не публикует. Публикация адресная:

```bash
scp dist/atlanty-schedule.js lk-primary-147:/var/www/html/lk/atlanty-schedule.js
scp <фото>                   lk-primary-147:/var/www/html/lk/atlanty-cards/
```

После публикации: `https://padlhub.su/lk/atlanty-schedule.js` должен отдавать 200
и совпадать по sha256 с локальным `dist/atlanty-schedule.js`. `release.json` при
этом не меняется — остальные виджеты не инвалидируются.

Онбординг бандла и фото в standard-комплект (схема артефактов, nginx-пути,
счётчики, тесты) — отдельная CRITICAL-задача: попытка просто дописать файл в
`deploy-lk.sh` и `PROD_RELEASE_ARTIFACTS` ломает закреплённый контракт
(`17 !== 16` и `Frontend bootstrap installed hashes schema mismatch`).

## Проверки

```bash
npm run test:atlanty-schedule    # модель, категории, бейджи, пул фото, диплинк
npm run test:delivery            # контракт релизного маршрута
npx tsc -b && npx eslint src/components/atlanty-schedule src/utils/atlantySchedule*.ts
```

Проверка «в браузере» — открыть собранный бандл на тестовой странице (см.
`docs/tilda-atlanty-schedule.html`) или лендинг с этим блоком.

## Известные ограничения

- Названия событий в Viva нет: заголовок карточки — название направления.
- У направлений нет фото (`direction.photo` пусто), поэтому используются фото пула.
- Клик по карточке открывает модалку; попап записи Viva вызывается кнопкой
  «Записаться». Кнопка нажимает постоянный скрытый якорь карточки
  (`a[data-atlanty-exercise]`, `href="#atlanty&exerciseId=…"`) — на такие ссылки
  виджет Viva навешивает свой обработчик, который выставляет выбранное событие.
  Если обработчика ещё нет, попап всё равно откроется (по hashchange или вызовом
  `event: open`), но без фокуса на событии.
- Направление «Патриоты» в Viva пока не создано — категория добавляется одной
  строкой, когда появится.
