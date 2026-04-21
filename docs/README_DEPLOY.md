# Деплой — автоподгрузка скрипта в Tilda

## 1. Установить зависимости и собрать
```bash
npm install
npm run build
```

После сборки в `dist/` лежат два комплекта скриптов:

- боевой комплект для пользователей: `bundle.js`, `games.js`, `tournaments.js`, `onboarding.js`, `communities.js`
- dev-комплект для тестов и новых фич: `bundle-dev.js`, `games-dev.js`, `tournaments-dev.js`, `onboarding-dev.js`, `communities-dev.js`
- манифесты релиза для пробития кэша Safari: `release.json`, `release-dev.json`

Правило использования:

- `bundle.js` и связанные с ним файлы без суффикса `-dev` — боевые, их получают пользователи
- `bundle-dev.js` и файлы с суффиксом `-dev` — для тестирования, проверки новых фич и dev-сценариев

## 2. Разместить bundle.js на сервере
Скопировать боевые файлы из `dist/` в публичную папку nginx, например:
```
/var/www/html/lk/bundle.js
/var/www/html/lk/games.js
/var/www/html/lk/tournaments.js
/var/www/html/lk/onboarding.js
/var/www/html/lk/communities.js
/var/www/html/lk/release.json
```

Для dev-проверок рядом должны лежать и dev-файлы:
```
/var/www/html/lk/bundle-dev.js
/var/www/html/lk/games-dev.js
/var/www/html/lk/tournaments-dev.js
/var/www/html/lk/onboarding-dev.js
/var/www/html/lk/communities-dev.js
/var/www/html/lk/release-dev.json
```
Чтобы файл был доступен по URL: `https://ваш-сервер/lk/bundle.js`

Убедиться что nginx отдаёт файл с правильным CORS-заголовком:
```nginx
add_header Access-Control-Allow-Origin *;
```

Для Safari на iPhone лучше отдельно запретить кэшировать оба манифеста релиза:
```nginx
location = /lk/release.json {
    add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;
}

location = /lk/release-dev.json {
    add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;
}
```

Для самих bundle-файлов и шрифтов логика должна быть обратной: включить сжатие и долгий cache, потому что версия уже пробивается через `release.json`/`release-dev.json` и параметр `?v=...`.
```nginx
gzip on;
gzip_types application/javascript text/css application/json font/woff2;

location ~* ^/lk/(bundle|games|tournaments|onboarding|communities|ffc-academy)(-dev)?\.js$ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}

location ~* \.(woff2|woff|css)$ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
}
```

Для dev-канала применяйте те же правила и к файлам с суффиксом `-dev`, чтобы проверка новых фич шла на тех же условиях по сжатию и кешированию, что и будущий прод.

Для публичных точек входа ЛК лучше сразу отдать один и тот же `index.html`/страницу виджета на отдельные маршруты:
```nginx
location = /game_join {
    try_files $uri /lk/index.html;
}

location = /game_create {
    try_files $uri /lk/index.html;
}

location = /community_join {
    try_files $uri /lk/index.html;
}
```

## 3. Вставить в Tilda (блок T123 — HTML)
```html
<div id="root"></div>
<script>
  (function () {
    var primaryBaseUrl = "https://ваш-сервер/lk";
    var fallbackBaseUrls = [];
    var analyticsUrl = "https://ваш-сервер/lk/analytics/events";
    var channel = "prod"; // "prod" or "dev"
    var requestTimeoutMs = 8000;

    function normalizeBaseUrl(value) {
      return String(value || "").trim().replace(/\/+$/, "");
    }

    function dedupeStrings(values) {
      var seen = {};
      return values.filter(function (value) {
        if (!value || seen[value]) return false;
        seen[value] = true;
        return true;
      });
    }

    function resolveBaseUrls() {
      var configured = normalizeBaseUrl(primaryBaseUrl);
      var fallbacks = Array.isArray(fallbackBaseUrls)
        ? fallbackBaseUrls.map(normalizeBaseUrl).filter(Boolean)
        : [];
      var currentOriginBase = normalizeBaseUrl(location.origin + "/lk");

      if (configured && currentOriginBase && configured !== currentOriginBase) {
        fallbacks.push(currentOriginBase);
      }

      return dedupeStrings([configured].concat(fallbacks).filter(Boolean));
    }

    var baseUrls = resolveBaseUrls();

    function sendBootstrapError(kind, payload) {
      try {
        var body = JSON.stringify({
          event: "tilda_bootstrap_error",
          timestamp: new Date().toISOString(),
          source: "tilda-loader",
          channel: channel,
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

    function isLikelyExtensionError(event) {
      var filename = String(event && event.filename || "");
      var message = String(event && event.message || "");
      return /(^|\/)content\.js(\?|$)/i.test(filename)
        || /^chrome-extension:/i.test(filename)
        || /^moz-extension:/i.test(filename)
        || /^safari-web-extension:/i.test(filename)
        || /safari is not defined/i.test(message);
    }

    window.addEventListener("error", function (event) {
      if (isLikelyExtensionError(event)) return;
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

    function getReleaseFileName() {
      return channel === "dev" ? "release-dev.json" : "release.json";
    }

    function getBundleFileName() {
      return channel === "dev" ? "bundle-dev.js" : "bundle.js";
    }

    function showLoadError(payload) {
      sendBootstrapError("bundle.load_failed", payload || {});
      var root = document.getElementById("root");
      if (root) {
        root.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#333'>Не удалось загрузить кабинет. Проверьте интернет или попробуйте позже.</div>";
      }
    }

    function buildBundleUrl(baseUrl, version) {
      var normalizedVersion = (version || "").trim();
      return baseUrl + "/" + getBundleFileName() + (normalizedVersion ? ("?v=" + encodeURIComponent(normalizedVersion)) : "");
    }

    function rotateBaseUrls(startIndex) {
      return baseUrls.slice(startIndex).concat(baseUrls.slice(0, startIndex));
    }

    function appendBundleScript(version, candidateBaseUrls, releaseUrl, errors) {
      var candidates = candidateBaseUrls && candidateBaseUrls.length ? candidateBaseUrls : baseUrls;
      var normalizedVersion = (version || "").trim();
      if (normalizedVersion) {
        window.__LK_RELEASE_VERSION__ = normalizedVersion;
      }

      var failedUrls = Array.isArray(errors) ? errors.slice() : [];

      function tryNext(index) {
        if (index >= candidates.length) {
          showLoadError({
            releaseUrl: releaseUrl || null,
            attemptedBundleUrls: failedUrls,
            baseUrls: candidates
          });
          return;
        }

        var bundleUrl = buildBundleUrl(candidates[index], version);
        failedUrls.push(bundleUrl);

        var script = document.createElement("script");
        script.src = bundleUrl;
        script.async = true;
        script.crossOrigin = "anonymous";
        script.onerror = function () {
          if (script.parentNode) {
            script.parentNode.removeChild(script);
          }
          sendBootstrapError("bundle.load_retry", {
            bundleUrl: bundleUrl,
            nextBaseUrl: candidates[index + 1] || null
          });
          tryNext(index + 1);
        };
        document.head.appendChild(script);
      }

      tryNext(0);
    }

    function fetchJsonWithTimeout(url) {
      if (typeof AbortController === "undefined") {
        return fetch(url, { cache: "no-store" });
      }

      var controller = new AbortController();
      var timeoutId = setTimeout(function () {
        controller.abort();
      }, requestTimeoutMs);

      return fetch(url, {
        cache: "no-store",
        signal: controller.signal
      }).finally(function () {
        clearTimeout(timeoutId);
      });
    }

    function fetchReleaseVersion(index, manifestErrors) {
      if (index >= baseUrls.length) {
        appendBundleScript(String(Date.now()), baseUrls, null, manifestErrors);
        return;
      }

      var releaseUrl = baseUrls[index] + "/" + getReleaseFileName() + "?ts=" + Date.now();
      var nextErrors = Array.isArray(manifestErrors) ? manifestErrors.slice() : [];
      nextErrors.push(releaseUrl);

      fetchJsonWithTimeout(releaseUrl)
        .then(function (response) {
          if (!response.ok) throw new Error("Release manifest request failed");
          return response.json();
        })
        .then(function (payload) {
          var version = payload && payload.version ? String(payload.version) : "";
          appendBundleScript(version, rotateBaseUrls(index), releaseUrl, nextErrors);
        })
        .catch(function (error) {
          sendBootstrapError("release.fetch_failed", {
            releaseUrl: releaseUrl,
            nextBaseUrl: baseUrls[index + 1] || null,
            reason: error && error.message ? error.message : String(error || "unknown")
          });
          fetchReleaseVersion(index + 1, nextErrors);
        });
    }

    if (baseUrls.length === 0) {
      showLoadError({ reason: "No base URLs configured" });
      return;
    }

    fetchReleaseVersion(0, []);
  })();
</script>
```

Важно: `analyticsUrl` должен указывать на ваш backend-эндпоинт, который пишет события в базу.
Если у вас прод-страница открывается на `padlhub.ru`, а dev/резервные файлы лежат еще и на `padlhub.su`, перечислите их в `fallbackBaseUrls` в порядке приоритета.
Fallback сработает только если на каждом указанном origin действительно лежат `release.json`/`release-dev.json` и соответствующие bundle-файлы.
Текущий шаблон также игнорирует шумные ошибки от браузерных расширений вроде `content.js: safari is not defined`, чтобы не засорять bootstrap-логи.
Для dev-страницы достаточно заменить `var channel = "prod";` на `var channel = "dev";`.
Тот же шаблон лежит отдельным файлом в [tilda-loader.html](/Users/zver/Desktop/project-fixed 6/docs/tilda-loader.html).

## Обновление
При изменениях в коде достаточно:
```bash
npm run build
cp dist/bundle.js /var/www/html/lk/bundle.js
```
Если обновляете сервер вручную, не забывайте копировать оба комплекта файлов: боевой без суффикса и dev с суффиксом `-dev`, а также `release.json` и `release-dev.json`.
На боевой Tilda-странице оставляйте `channel = "prod"`, а для тестовой страницы переключайте `channel = "dev"`.

После однократного обновления Tilda-шаблона выше дальнейшие релизы начнут автоматически пробивать кэш Safari через `release.json` или `release-dev.json` и параметр `?v=...` у всех дочерних бандлов.

## Страница приглашения в игру (`/game_join`)

Тот же `bundle.js` теперь поддерживает режим приглашения в игру.

Invite-ссылки настраиваются через:
- `VITE_PUBLIC_INVITE_ORIGIN` (домен, например `https://padlhub.ru`)
- `VITE_PUBLIC_INVITE_PATH` (путь, например `/game_join`)

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

## Страница быстрого создания игры (`/game_create`)

Тот же `bundle.js` теперь поддерживает короткий сценарий создания игры.

Ссылка настраивается через:
- `VITE_PUBLIC_GAME_CREATE_PATH` (путь, например `/game_create`)

Формат ссылки:
```text
https://padlhub.ru/game_create
```

С предвыбранной станцией:
```text
https://padlhub.ru/game_create?stationId=<STATION_ID>
```

Также поддерживаются алиасы параметров станции:
- `studioId`
- `station`
- `stationName`
- `studio`
- `studioName`

Опционально можно передать адрес возврата:
```text
https://padlhub.ru/game_create?stationId=<STATION_ID>&cabinetUrl=https%3A%2F%2Fpadlhub.ru%2Flk%2F
```

Логика:
- если пользователь не авторизован, сначала показывается форма входа;
- после входа открывается экран создания игры;
- если в ссылке передана станция, она подставляется автоматически и пользователь сразу попадает на выбор времени.

## Страница вступления в сообщество (`/community_join`)

Тот же `bundle.js` теперь поддерживает внешний сценарий вступления в сообщество по ссылке.

Ссылка настраивается через:
- `VITE_PUBLIC_COMMUNITY_JOIN_PATH` (путь, например `/community_join`)

Основной формат ссылки:
```text
https://padlhub.ru/community_join?invite=<INVITE_CODE>
```

Дополнительно можно поддержать legacy-редирект со старого формата:
```nginx
location ^~ /community/invite/ {
    rewrite ^/community/invite/(.+)$ /community_join?invite=$1 last;
}
```

Логика:
- если пользователь не авторизован, сначала показывается форма входа;
- после входа ЛК автоматически отправляет запрос на вступление в сообщество;
- затем открывается нужное сообщество или показывается ошибка/статус модерации.
