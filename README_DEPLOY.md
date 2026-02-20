# Деплой — автоподгрузка скрипта в Tilda

## 1. Установить зависимости и собрать
```bash
npm install
npm run build
```

После сборки появится файл `dist/bundle.js`

## 2. Разместить bundle.js на сервере
Скопировать `dist/bundle.js` в публичную папку nginx, например:
```
/var/www/html/lk/bundle.js
```
Чтобы файл был доступен по URL: `https://ваш-сервер/lk/bundle.js`

Убедиться что nginx отдаёт файл с правильным CORS-заголовком:
```nginx
add_header Access-Control-Allow-Origin *;
```

## 3. Вставить в Tilda (блок T123 — HTML)
```html
<div id="root"></div>
<script src="https://ваш-сервер/lk/bundle.js"></script>
```

## Обновление
При изменениях в коде достаточно:
```bash
npm run build
cp dist/bundle.js /var/www/html/lk/bundle.js
```
Tilda подтянет новую версию автоматически.
