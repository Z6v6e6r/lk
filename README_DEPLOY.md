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
<script>
  (function () {
    var bundleUrl = "https://ваш-сервер/lk/bundle.js";
    var analyticsUrl = "https://ваш-сервер/lk/analytics/events";

    function sendBootstrapError(kind, payload) {
      try {
        var body = JSON.stringify({
          event: "tilda_bootstrap_error",
          timestamp: new Date().toISOString(),
          source: "tilda-loader",
          kind: kind,
          payload: payload || {},
          page: {
            href: location.href,
            referrer: document.referrer || null
          },
          userAgent: navigator.userAgent || null
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(analyticsUrl, new Blob([body], { type: "application/json" }));
          return;
        }
        fetch(analyticsUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true
        });
      } catch (_) {}
    }

    window.addEventListener("error", function (event) {
      sendBootstrapError("window.error", {
        message: event.message || "Runtime error before widget init",
        filename: event.filename || null,
        lineno: event.lineno || null,
        colno: event.colno || null
      });
    }, true);

    window.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason ? String(event.reason) : "Unhandled promise rejection";
      sendBootstrapError("window.unhandledrejection", { reason: reason });
    });

    var script = document.createElement("script");
    script.src = bundleUrl;
    script.async = true;
    script.onerror = function () {
      sendBootstrapError("bundle.load_failed", { bundleUrl: bundleUrl });
      var root = document.getElementById("root");
      if (root) {
        root.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#333'>Не удалось загрузить кабинет. Проверьте интернет или попробуйте позже.</div>";
      }
    };
    document.head.appendChild(script);
  })();
</script>
```

Важно: `analyticsUrl` должен указывать на ваш backend-эндпоинт, который пишет события в базу.

## Обновление
При изменениях в коде достаточно:
```bash
npm run build
cp dist/bundle.js /var/www/html/lk/bundle.js
```
Tilda подтянет новую версию автоматически.

## Страница приглашения в игру (`/game_join`)

Тот же `bundle.js` теперь поддерживает режим приглашения в игру.

Формат ссылки:
```
https://padlhub.ru/game_join?joinGame=<GAME_ID>
```

Опционально:
```
https://padlhub.ru/game_join?joinGame=<GAME_ID>&cabinetUrl=https%3A%2F%2Fpadlhub.ru%2Flk%2F
```

Логика:
- если пользователь не авторизован, показывается форма входа;
- после входа показывается карточка игры + комментарий + кнопки `Присоединиться` / `Отказаться от игры`;
- после действия доступны `Перейти в личный кабинет` и `Выйти`.
