# Деплой — автоподгрузка скрипта в Tilda

## Стандартный frontend-путь

Выключенная по умолчанию автоматизация и единый activation checklist:
[FRONTEND_DELIVERY.md](FRONTEND_DELIVERY.md). После однократного включения владельцем
готовая допустимая frontend-фича проходит protected merge, CI интегрированного source,
существующие build/upload, static publication, smoke и guarded recovery без отдельных
подтверждений каждого шага. Изменение самого release-механизма требует профильного review.
Этот инфраструктурный PR не включает путь и не может выпустить себя.

## 0. Обязательный clean-release preflight

Деплой и сборка upload-пакета разрешены только из чистого Git checkout.
`release.json` и `release-dev.json` содержат полный SHA исходного коммита и
признак dirty-состояния. Команды `deploy:*` и `package:upload:*` автоматически
проверяют, что:

- в рабочем дереве нет tracked и untracked изменений;
- манифест собран из текущего `HEAD`;
- манифест не был создан из dirty checkout.

Ручная проверка:

```bash
npm run release:preflight
```

Исторический порядок стабилизации в `docs/MAIN_STABILIZATION.md` не является
обязательным интеграционным пакетом для независимой фичи.

## 1. Установить зависимости и собрать
```bash
npm install
npm run build
```

Если релиз затрагивает Node-RED для LK Games / referral flow, сначала создать новый
приватный workspace вне репозитория и read-only получить live состояние `147`:

```bash
npm run nodered:modular:pull-147 -- /absolute/new/private/workspace
npm run nodered:modular:verify -- --workspace /absolute/new/private/workspace
```

После этого используется только focused patcher конкретного контура с exact preimage,
новыми output/report paths и отдельным reviewed deploy contract. Старые wide
`sync-games-source`, `prepare-147` и `exports` находятся в карантине: они не должны
применяться к свежему live pull, потому что способны затронуть параллельные изменения.
Полный актуальный порядок зафиксирован в `docs/NODERED_MODULAR_WORKFLOW.md`.

Guarded reviewed-flow deploy дополнительно использует общий server-side `flock`
и оставляет 15-минутный post-apply lease. Пока lease активен, следующий
reviewed-flow preflight завершается fail-closed, а точный rollback владельца
lease остаётся разрешён. Это предотвращает второй PM2 restart во время soak
предыдущего rollout. Если source уже восстановлен, но PM2 restart завершился
ошибкой, тот же rollback повторно запускает только restart под атомарно
обновлённым matching lease; без matching lease такой resume запрещён. Если
`applying` оборвался до publication, exact backup/source и PM2-online read-back
освобождают lease без рестарта. Оба backup fsync-ятся до atomic no-clobber
publication lease; legacy v1 lease не auto-expire и проходит только exact
guarded rollback/migration. Lease и atomic flow publication подтверждаются
file+directory `fsync`, а lease снимается только после соответствующего
source/PM2 read-back. Lease нельзя удалять вручную ради обхода очереди.

Managed subscription policy graph имеет отдельный exact-graph entrypoint
`npm run nodered:managed-subscription-rules:deploy-147` с обязательным
`NODE_RED_MANAGED_SUBSCRIPTION_RULES_DEPLOY=CONFIRM_147`. Он разрешает только
закреплённые три изменения существующих узлов и два добавляемых policy-узла;
общий function-only deploy для subscription binding остаётся отдельным gate.

Полный unified LK1 subscription-enforcement graph пока имеет только offline
packet entrypoint `npm run nodered:lk1-subscription-enforcement:packet`. Он создаёт
private candidate/contract/plan вне Git и всегда фиксирует
`liveMutationAuthorized=false`; import/restart/Deploy не выполняются. Текущие
identity, allowlist, blockers и будущий rollback boundary описаны в
`docs/LK1_SUBSCRIPTION_R4_ACTIVATION_PACKET_20260827.md`. Partial subscription
wrappers нельзя применять последовательно вместо unified graph.

Для `POST /lk/subscription-bookings` production nginx должен содержать точный
proxy-location из `scripts/nginx/lk-subscription-booking-location.conf`.
Кандидат строится и применяется только через guarded
`scripts/nginx/patch_subscription_booking_proxy.mjs` с SHA текущего live-конфига,
backup, последующими `nginx -t` и `systemctl reload nginx`.

Legacy-маршруты roster и подтверждения оплаты требуют публичного CORS preflight
с `Idempotency-Key` и `X-Correlation-ID`. Nginx-кандидат для вложенного
`/lk/games/` строится только guarded-скриптом
`scripts/nginx/patch_lk_games_cors.mjs`. Staged rollout, rollback и обратимый
вынос backup-vhost из `sites-enabled` описаны в
`docs/NGINX_LK_GAMES_CORS.md`. До успешного публичного preflight включать
roster bridge нельзя.

### Защита Node-RED MongoDB URI в логах

Установленный `@pafum/node-red-node-mongodb` по умолчанию печатает полный URI
при старте. На `147` защита устанавливается отдельным staged workflow и не
является частью flow import:

```bash
npm run nodered:runtime-hardening:test
npm run nodered:runtime-hardening:install-147
```

Installer работает только с `lk-primary-147` и точным userdir
`/root/.node-red`. Он:

- сохраняет приватные backup `package.json` и MongoDB-модуля;
- устанавливает guard вне `node_modules`;
- добавляет guard первым шагом `postinstall`, сохраняя существующий hook;
- сразу применяет и проверяет точные два URI logging call;
- сохраняет PM2 node arg `--disable-warning=DEP0170`;
- проверяет, что `flows.json` не изменился, Node-RED `online`, а в текущих и
  ротированных Node-RED логах нет MongoDB URI;
- проверяет публичный games API после рестарта.

Guard идемпотентен. Неизвестный формат новой версии MongoDB-модуля завершает
`npm install` ошибкой до рестарта, чтобы изменение logging contract прошло
отдельный review. Скрипт не меняет и не ротирует credentials и не удаляет
исторические логи: если post-check находит старый URI, installer останавливается
и требует отдельной подтверждённой редакции логов.

После сборки в `dist/` лежат два комплекта скриптов:

- боевой комплект для пользователей: `bundle.js`, `games.js`, `tournaments.js`, `onboarding.js`, `levels-info.js`, `communities.js`
- публичная запись на турниры: `tournament-signup.js`
- публичное расписание групповых тренировок: `group-schedule.js`
- однодневное расписание Padel Day: `padel-day-schedule.js`
- закрытый турнирный абонемент: `tournament-subscription.js`
- реферальная покупка турнирного абонемента: `tournament-subscription-referral.js`
- dev-комплект для тестов и новых фич: `bundle-dev.js`, `games-dev.js`, `tournaments-dev.js`, `onboarding-dev.js`, `levels-info-dev.js`, `communities-dev.js`
- dev-запись на турниры: `tournament-signup-dev.js`
- dev-расписание групповых тренировок: `group-schedule-dev.js`
- dev-расписание Padel Day на тестовую дату: `padel-day-schedule-dev.js`
- dev-закрытый турнирный абонемент: `tournament-subscription-dev.js`
- dev-реферальная покупка турнирного абонемента: `tournament-subscription-referral-dev.js`
- манифесты релиза для пробития кэша Safari: `release.json`, `release-dev.json`

Шрифты поставляются отдельно как статические файлы из `src/fonts/*.woff2` и должны лежать на сервере в `/lk/fonts/`.

Правило использования:

- `bundle.js` и связанные с ним файлы без суффикса `-dev` — боевые, их получают пользователи
- `bundle-dev.js` и файлы с суффиксом `-dev` — для тестирования, проверки новых фич и dev-сценариев

## 2. Разместить артефакты на серверах
Рекомендуемая split-топология:

- `lk-primary-147:/var/www/html/lk` держит только `prod`-артефакты
- `lk-reserve-89:/var/www/html/lk` держит только `dev`-артефакты
- зеркальная выкладка на оба host-а больше не является default и должна использоваться только осознанно как исключение

На `lk-primary-147` скопировать боевые файлы из `dist/`:
```
/var/www/html/lk/bundle.js
/var/www/html/lk/games.js
/var/www/html/lk/tournaments.js
/var/www/html/lk/tournament-signup.js
/var/www/html/lk/group-schedule.js
/var/www/html/lk/padel-day-schedule.js
/var/www/html/lk/tournament-subscription.js
/var/www/html/lk/tournament-subscription-referral.js
/var/www/html/lk/onboarding.js
/var/www/html/lk/levels-info.js
/var/www/html/lk/communities.js
/var/www/html/lk/release.json
/var/www/html/lk/fonts/rf-dewi-ultrabold.woff2
/var/www/html/lk/fonts/rf-dewi-expanded-ultrabold-italic.woff2
/var/www/html/lk/fonts/SourceCodePro-Medium.woff2
/var/www/html/lk/fonts/SourceCodePro-Regular.woff2
```

На `lk-reserve-89` должны лежать только dev-файлы:
```
/var/www/html/lk/bundle-dev.js
/var/www/html/lk/games-dev.js
/var/www/html/lk/tournaments-dev.js
/var/www/html/lk/tournament-signup-dev.js
/var/www/html/lk/group-schedule-dev.js
/var/www/html/lk/padel-day-schedule-dev.js
/var/www/html/lk/tournament-subscription-dev.js
/var/www/html/lk/tournament-subscription-referral-dev.js
/var/www/html/lk/onboarding-dev.js
/var/www/html/lk/levels-info-dev.js
/var/www/html/lk/communities-dev.js
/var/www/html/lk/release-dev.json
/var/www/html/lk/fonts/rf-dewi-ultrabold.woff2
/var/www/html/lk/fonts/rf-dewi-expanded-ultrabold-italic.woff2
/var/www/html/lk/fonts/SourceCodePro-Medium.woff2
/var/www/html/lk/fonts/SourceCodePro-Regular.woff2
```
Чтобы файл был доступен по URL: `https://ваш-сервер/lk/bundle.js` для prod или `https://ваш-сервер/lk/bundle-dev.js` для dev.

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

location ~* ^/lk/(bundle|games|tournaments|tournament-signup|group-schedule|padel-day-schedule|tournament-subscription-referral|tournament-subscription|onboarding|levels-info|communities|ffc-academy)(-dev)?\.js$ {
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

location = /finde_game {
    try_files $uri /lk/index.html;
}

location = /community_join {
    try_files $uri /lk/index.html;
}
```

## 3. Вставить в Tilda (блок T123 — HTML)

Bootstrap ЛК не подключает legacy Viva-виджет `#9Rzqf`. Групповые тренировки
открываются на `https://padlhub.ru/group`, а подписочная запись проходит через
серверный `/lk/subscription-bookings`.

```html
<meta charset="utf-8">
<div id="root"></div>
<script>
  (function () {
    var primaryBaseUrl = "https://ваш-сервер/lk";
    var fallbackBaseUrls = ["https://lk-reserve.89-108-64-209.sslip.io/lk"];
    var analyticsUrl = "https://ваш-сервер/lk/analytics/events";
    var requestTimeoutMs = 8000;
    var scriptLoadTimeoutMs = 12000;

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

    function resolveChannel() {
      var explicitChannel = String(new URLSearchParams(window.location.search).get("channel") || "").trim().toLowerCase();
      if (explicitChannel === "dev" || explicitChannel === "prod") return explicitChannel;
      if (location.pathname.indexOf("/lk_dev") !== -1) return "dev";
      return "prod";
    }

    function resolveBaseUrls(channel) {
      var configured = normalizeBaseUrl(primaryBaseUrl);
      var fallbacks = Array.isArray(fallbackBaseUrls)
        ? fallbackBaseUrls.map(normalizeBaseUrl).filter(Boolean)
        : [];
      var ordered = channel === "dev" && fallbacks.length > 0
        ? fallbacks
        : (configured ? [configured] : fallbacks);

      return dedupeStrings(ordered.filter(Boolean));
    }

    var channel = resolveChannel();
    var baseUrls = resolveBaseUrls(channel);
    window.__LK_BASE_URLS__ = baseUrls.slice();

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
      return baseUrl + "/" + getBundleFileName() +
        (normalizedVersion ? ("?v=" + encodeURIComponent(normalizedVersion) + "&charset=utf-8") : "?charset=utf-8");
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
        window.__LK_ACTIVE_BASE_URL__ = candidates[index];

        var script = document.createElement("script");
        script.charset = "utf-8";
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
Для PadlHub держите в `fallbackBaseUrls` рабочий reserve-origin, сейчас это `https://lk-reserve.89-108-64-209.sslip.io/lk`.
Bootstrap сохраняет итоговый channel-scoped список в `window.__LK_BASE_URLS__`: для `prod` это обычно только `https://padlhub.su/lk`, для `dev` только `https://lk-reserve.89-108-64-209.sslip.io/lk`.
Внутренние remote-widget loaders и release checks используют именно этот список и больше не должны молча добавлять cross-channel asset origins поверх него.
Когда bundle реально загружается с reserve-origin, bootstrap также пишет `window.__LK_ACTIVE_BASE_URL__`; runtime использует этот origin как preferred gateway для LK/SERV2 запросов. Это правило относится и к standalone Tilda entrypoints (`docs/tilda-game-create.html`, `docs/tilda-finde-game.html`, `docs/tilda-game-join.html`, `docs/tilda-tournaments.html`, `docs/tilda-tournament-signup.html`, `docs/tilda-group-schedule.html`, `docs/tilda-padel-day-schedule.html`, `docs/tilda-tournament-subscription*.html`): если public-страница загрузила bundle с reserve-origin, она тоже должна сохранить `__LK_BASE_URLS__` и `__LK_ACTIVE_BASE_URL__`, иначе create/join/payment POST-ы могут уйти обратно в `padlhub.su`.
Fallback по static-asset origin теперь допустим только внутри своего канала: `prod -> primary`, `dev -> reserve`, если вы явно не переопределили список origin-ов вручную.
Текущий шаблон также игнорирует шумные ошибки от браузерных расширений вроде `content.js: safari is not defined`, чтобы не засорять bootstrap-логи.
Для dev-страницы шаблон выше сам переключит origin на `89`, если URL содержит `/lk_dev` или query `channel=dev`.
Тот же шаблон лежит отдельным файлом в [tilda-loader.html](/Users/zver/Desktop/project-fixed 6/docs/tilda-loader.html).

## Обновление
При изменениях в коде достаточно:
```bash
npm run build
scp dist/bundle.js dist/games.js dist/tournaments.js dist/tournament-signup.js dist/group-schedule.js dist/padel-day-schedule.js dist/tournament-subscription.js dist/tournament-subscription-referral.js dist/onboarding.js dist/levels-info.js dist/communities.js dist/release.json lk-primary-147:/var/www/html/lk/
```
Для ручного split-обновления выкладывайте prod-комплект только на `lk-primary-147`, а dev-комплект только на `lk-reserve-89`.
Для стандартной выкладки используйте готовую команду:
```bash
npm run deploy:all
```
Она отправит `prod`-артефакты в `lk-primary-147:/var/www/html/lk`, а `dev`-артефакты в `lk-reserve-89:/var/www/html/lk`.
Одновременно wrapper удалит на каждом target остатки противоположного канала, чтобы после старых mirror-rollout'ов на `147` не оставался `release-dev.json`, а на `89` — `release.json` и соответствующие bundle'ы.
Если нужен только один канал, есть `npm run deploy:prod` и `npm run deploy:dev`.
Если временно нужен legacy mirror rollout на оба host-а, используйте только явные команды `npm run deploy:mirror:prod`, `npm run deploy:mirror:dev` или `npm run deploy:mirror:all`.
Под капотом split-wrapper понимает `DEPLOY_TARGETS_PROD` и `DEPLOY_TARGETS_DEV`, а low-level deploy script по-прежнему поддерживает `DEPLOY_TARGETS`.
На боевой Tilda-странице оставляйте `channel = "prod"`, а для тестовой страницы переключайте `channel = "dev"`.

После однократного обновления Tilda-шаблона выше дальнейшие релизы начнут автоматически пробивать кэш Safari через `release.json` или `release-dev.json` и параметр `?v=...` у всех дочерних бандлов.

## Резервный nginx API gateway

Если `bundle.js` загружается с reserve-origin, frontend может отправлять `/lk/*` чтение на этот же origin. Чтобы такие запросы не упирались в отсутствие backend на 89, настройте nginx на reserve как API gateway по шаблону [lk-reserve.conf](/Users/zver/Desktop/project-fixed 6/scripts/nginx/lk-reserve.conf).

Схема:
- `/lk/*.js`, `/lk/release*.json`, `/lk/fonts/*`, `/lk/assets/*` отдаются локально с 89;
- backend-маршруты `/lk/games`, `/lk/chats`, `/lk/communities`, `/lk/support`, `/lk/tournaments`, `/lk/onboarding`, `/lk/push`, `/lk/analytics`, `/lk/advertising`, `/lk/media`, `/seliger`, `/api/*` проксируются на `https://padlhub.su`;
- `POST/PATCH/DELETE` не дублируются, а идут в один upstream, чтобы не создать повторные оплаты, игры или сообщения.

Ограничение: такой gateway спасает только сценарий, где браузер клиента не видит 147/`padlhub.su`, но сам 89 видит primary backend. Если primary backend полностью лежит, нужен второй Node-RED/backend на 89 с доступом к тем же Mongo/Viva/Keycloak.

## Страница приглашения в игру (`/game_join`)

Тот же `bundle.js` теперь поддерживает режим приглашения в игру.
Для Tilda-страницы `/game_join` используйте HTML из `docs/tilda-game-join.html`: он грузит `games.js` сразу на этой странице и не делает промежуточный редирект на `/lk_new`.

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

## Публичная запись на турниры (`/tournaments`)

Для новой Tilda-страницы публичной записи используйте HTML-вставку из:
```text
docs/tilda-tournaments.html
```

Она читает `https://padlhub.su/lk/release.json`, подставляет версию к `tournament-signup.js`, пробивает кэш и монтирует `LKWidgetTournamentSignup` в `#root`.

Формат ссылки:
```text
https://padlhub.ru/tournaments
```

Legacy-алиас `/tournament_signup` можно оставить на том же signup bundle через отдельную HTML-вставку:
```text
docs/tilda-tournament-signup.html
```

С открытием конкретного турнира:
```text
https://padlhub.ru/tournaments?tournamentId=<TOURNAMENT_ID>
```

Также поддерживаются алиасы идентификатора:
- `id`
- `exerciseId`

Новый формат для ссылок из скина турнира:
```text
https://padlhub.ru/tournaments?slug=<TOURNAMENT_SLUG>
```

Также поддерживается алиас:
- `tournamentSlug`

С открытием даты:
```text
https://padlhub.ru/tournaments?date=2026-05-05
```

Логика:
- если пользователь не авторизован, сначала показывается общая форма входа ЛК;
- после входа бандл отправляет ph-ab API `Authorization: Bearer <LK Keycloak token>` и заголовки `X-PadlHub-Auth-Source: lk-keycloak`, `X-PadlHub-Tenant-Key`;
- пользователь видит список турниров, карточку турнира, свой статус записи, может записаться или отменить запись.

API по умолчанию берется из `VITE_PHAB_API_BASE`, fallback: `https://padlhub.su/api`.

## Публичное расписание групповых тренировок (`/group`)

Для новой Tilda-страницы групповых тренировок используйте отдельную HTML-вставку из:
```text
docs/tilda-group-schedule.html
```

Она читает `https://padlhub.su/lk/release.json`, подставляет версию к `group-schedule.js`, пробивает кэш и монтирует `LKWidgetGroupSchedule` в `#root`. Страница сохраняет совместимость со старым параметром даты `4lGIgL_date`, но список и запись строятся уже из прямых Viva-запросов.

Форматы ссылок:
```text
https://padlhub.ru/group
https://padlhub.ru/group?date=2026-06-27
https://padlhub.ru/group?4lGIgL_date=2026-06-27
```

## Padel Day (`/padel_day_shedule`)

Используйте отдельную вставку `docs/tilda-padel-day-schedule.html`. Prod-бандл `padel-day-schedule.js` жёстко показывает `2026-07-29`; dev-бандл `padel-day-schedule-dev.js` использует тестовое расписание `2026-07-26`. URL-параметры не меняют дату.

Для guard и листа ожидания Padel Day nginx должен проксировать `^~ /lk/padel-day/` на `http://127.0.0.1:1880` до общего статического `^~ /lk/` location. Idempotent patch: `node scripts/nginx/patch_padel_day_proxy.mjs /etc/nginx/sites-enabled/padlhub.su`, затем `nginx -t && systemctl reload nginx`.

Перед Viva-транзакцией frontend получает lock через `POST /lk/padel-day/guard`. Gate повторно читает активные Viva bookings и отклоняет любую активную запись с `direction.id=5245`, независимо от станции и даты. Параллельные попытки блокируются атомарной Mongo-записью в `lk_padel_day_transactions`; confirm/release идут через `POST /lk/padel-day/guard/:guardId/:action`.

Wide-сборка Padel Day через `prepare-147` находится в карантине.
Не пересобирайте и не импортируйте checked-in
`node-red/modular/imports/lk_padel_day*.json` как production candidate. До
восстановления Padel Day-specific patcher с exact live preimage поддерживаемого
source-driven release path для этих артефактов нет.

## Закрытый турнирный абонемент (`/tournament_subscription`)

Для Tilda-страницы покупки абонемента используйте отдельную HTML-вставку из:
```text
docs/tilda-tournament-subscription.html
```

Она читает `https://padlhub.su/lk/release.json` для `prod` или `https://lk-reserve.89-108-64-209.sslip.io/lk/release-dev.json` для `dev`, подставляет версию к `tournament-subscription.js` / `tournament-subscription-dev.js` и монтирует `LKWidgetTournamentSubscription` в `#root`.

Формат ссылки:
```text
https://padlhub.ru/tournament_subscription
```

Опционально:
- `cabinetUrl` или `returnUrl` — URL возврата по кнопке `Назад`;
- `channel=dev` — принудительно включить dev-бандл (`tournament-subscription-dev.js`).
- `variant=single_artwork` — отрендерить одну карточку по готовому изображению вместо стандартных 2 планов.
- `artworkKey` — выбрать один из 5 артов: `friendship`, `sport`, `ra`, `academy`, `energy5`.
- `planKey`, `campaignKey`, `priceLabel`, `totalLimit` — привязать single-artwork страницу к нужному purchase/status flow и подписи цены/лимита.
  Для `friendship`, `sport` и `energy5` `planKey` можно не указывать. Для `ra` и `academy` `planKey` тоже больше не нужен: эти карточки покупаются как обычные Viva SUBSCRIPTION products по прямому `productId`, а не через summer campaign flow.

По умолчанию standalone summer subscription page рендерит две группы карточек:
- `Подписки на 30 дней`: `academy`, `ra`, `friendship`, `energy5`;
- `Годовые подписки`: только `network_friendship` (ХАБ). Отдельные страницы Питера и
  Котельников сохранены, но их карточки не входят в `ab_leto`.

У ХАБ на `ab_leto` нет чекбокса согласия и подписи о статусе авторизации; вход,
проверка телефона, server-owned остатка и purchase binding остаются обязательными.
Подпись о дате вступления правил в силу также скрыта на общей витрине; отдельные
региональные страницы продолжают показывать её по своим контрактам.
Новые WebP-карточки закреплены точными SHA-256 в `lk1-subscription-enforcement`;
PNG-дубликаты в кандидат не входят.
Согласовательный макет ХАБ показывает `Доступно — 10 из 10`. Server candidate считает
это окно по календарному дню `Europe/Moscow`, но не сбрасывает общий inventory:
пять прежних продаж остаются учтены, общий остаток перед активацией равен 95.
Frontend по-прежнему читает фактические числа из API. После публикации candidate
остаётся инертным до отдельной server-owned активации exact boolean global flag
`summer_subscription_ab_leto_20260903_release_enabled=true`.
Воспроизводимый локальный fixture: `scripts/fixtures/ab-leto-preview.html`. После сборки
`vite build --config vite.config.tournament-subscription.ts --mode dev` скопировать его
в `dist/preview.html` и обслуживать только на loopback; fixture блокирует внешний fetch
и не входит в release entrypoints.

Карточки с правилами переворачиваются по нажатию на саму карточку или кнопку
`Узнать условия подписки`; клавиатурный фокус и `prefers-reduced-motion` поддерживаются.
Годовые карточки используют server-owned counters и fail-closed purchase bindings.
HAB получает дневное окно 10 поверх существующего общего inventory 100; authoritative
sale-to-instance binding всё ещё не доказан, поэтому purchase остаётся fail closed.
`sport` по-прежнему не входит в основную витрину.

Активация 150/HAB-10 и deploy — разные gates. До активации readback должен подтверждать
старые inventory. После первого PAID/PAYMENT_PENDING в `ab_leto_2026_150_v2_*`
откат на flow, который не знает новый inventory, запрещён: допускается только
forward-fix, а reconciliation обязан продолжать читать оба staged inventory.

Обязательный порядок публикации этой витрины:

1. Опубликовать default-off Node-RED candidate и подтвердить read-only status:
   `managedSaleReady=false`, `canPurchase=false`, прежний staged inventory активен.
2. Только после этого опубликовать frontend; обратный порядок запрещён, потому что
   старый live status ХАБ мог вернуть `canPurchase=true`.
3. Отдельным live gate выставить exact boolean activation flag и подтвердить
   RA/Дружба `150/150`, HAB `10/10`, а также неизменный общий HAB inventory.
`academy` и `ra` используют отдельный CTA-flow покупки обычной Viva-подписки по прямым product id:
- `academy` -> `9eb8a7a4-c195-492a-95e4-3fb82899ac10`
- `ra` -> `b91e14d1-fe6e-4d0b-be39-3e45ad86b759`
У `academy` блок лимита скрыт. `ra` не подменяет server-owned остаток статическим
значением: витрина показывает live status/daily-drop state, когда backend его возвращает.
Для `energy5` витрина использует отдельный CTA-flow покупки обычной Viva-подписки по прямому product id:
- `energy5` -> `dfa72adf-233b-4285-8d69-e5eab4234fbe`
У `energy5` блок лимита на карточке и single-artwork странице не показывается вообще: под изображением остается только кнопка покупки.

Пример:
```text
https://padlhub.ru/tournament_subscription?cabinetUrl=https%3A%2F%2Fpadlhub.ru%2Flk_new
```

Пример single-artwork страницы:
```text
https://padlhub.ru/tournament_subscription?variant=single_artwork&artworkKey=academy&priceLabel=23%20800%20%E2%82%BD
```

### Прямые ссылки на акционные абонементы

Для четырёх allowlist-предложений используйте `/ab_leto` с публичным ключом `offer`:

```text
https://padlhub.ru/ab_leto?offer=academy-promo
https://padlhub.ru/ab_leto?offer=friendship-promo
https://padlhub.ru/ab_leto?offer=sport-promo
https://padlhub.ru/ab_leto?offer=ra-promo
```

По такой ссылке `autoPurchase` по умолчанию включён: авторизованный клиент сразу переходит к созданию оплаты, неавторизованный сначала видит форму входа, а после успешной авторизации покупка продолжается автоматически. При возврате из банка виджет добавляет `autoPurchase=0`, чтобы не создать повторную транзакцию.

URL принимает только allowlist-ключ предложения; произвольный `productId` из query string не читается. Для просмотра карточки без автоматического старта оплаты можно явно добавить `autoPurchase=0`.

### Подписка «Падел.Дружба.Питер»

Для отдельной Tilda-страницы используйте вставку:

```text
docs/tilda-piter-subscription.html
```

Она монтирует тот же `tournament-subscription` bundle с вариантом
`piter_friendship`. Страница имеет отдельный счётчик, четыре серверные ценовые
партии по 100 подписок, чекбокс согласия, штатную авторизацию и переворачиваемую
карточку условий. Для первой ценовой партии storefront использует утверждённый
front-art, а обратная сторона показывает отдельный арт новых правил. В интерфейсе
явно указано, что эти правила относятся к подпискам, проданным с `01.09.2026`
по московскому времени; более старые/недатированные подписки сохраняют
compatibility-путь. Настройка Node-RED, fail-closed границы и приёмочная матрица
описаны в `docs/PITER_SUBSCRIPTION_CONTRACT.md`.

На 2026-08-20 sales binding Питера уже использует подтверждённый годовой Viva
product и серверную скидку текущей ценовой партии. Это не включает применение
подписки: до отдельной публикации policy, verified provider mapping,
SubscriptionInstance read-back и runtime activation использование в ЛК остаётся
fail closed.

Для Питера и ХАБ требуемая активация экземпляра: первая подтверждённая запись
по подписке, а при её отсутствии — автоматическая активация 1 октября 2026 года
в `Europe/Moscow`; 365 дней отсчитываются от фактической активации. Изолированный
кандидат ЦУП выражает правило режимом `FIRST_USE_OR_FIXED_DATE` с
`fixedActivationAt=2026-09-30T21:00:00.000Z`. Кандидат LK вызывает отдельную
активацию только после точного Viva booking read-back и безопасно повторяет её
без второй записи Viva; выключенный по умолчанию воркер ЦУП обрабатывает
дедлайн. Код ещё не выпущен, policy/instances не опубликованы, secrets/flags не
включены, поэтому текущий production-контур остаётся fail closed.

### Подписки «Котельники» и «Вся сеть»

Обе региональные страницы используют тот же общий IIFE-бандл
`tournament-subscription.js` (`tournament-subscription-dev.js` для
`channel=dev`). Новая Vite-конфигурация и отдельные JS-бандлы не нужны.

Для Tilda-блоков T123 используйте готовые вставки:

```text
docs/tilda-kotelniki-subscription.html
docs/tilda-network-subscription.html
```

Страница Котельников монтирует вариант и отдельный counter key
`kotelniki_friendship`: четыре ценовые партии по 50 подписок, суммарный
fallback-лимит 200. Цены на изображениях партий: 19 800 / 23 800 / 36 800 /
56 800 ₽.

Пока backend-счётчик региональной страницы не подключён, fallback-индикатор
показывает размер текущей партии: `100 из 100` для Питера и `50 из 50` для
Котельников. Покупка при этом остаётся fail-closed.

Страница всей сети монтирует вариант и отдельный counter key
`network_friendship`: существующий общий inventory из 100 подписок и дневное окно
10 продаж по календарному дню Москвы. На карточке показана новая цена 56 800 ₽
вместо зачёркнутой 98 800 ₽.

Sales binding ХАБ также подтверждён 2026-08-20; Котельники остаются fail closed
до отдельной привязки Viva product. Ни один из этих sales binding сам не создаёт
тип или policy version в ЦУП.

Обе страницы наследуют условия, переворот карточки, чекбокс согласия и
авторизацию страницы Питера. Пока backend не вернул соответствующий счётчик с
`bindingReady=true`, кнопка покупки остаётся fail-closed. Viva product ID и
station ID в Tilda-вставках и frontend не задаются. Проверенные station ID,
server counter keys, обязательные globals и fail-closed DRAFT правил собраны в
`docs/REGIONAL_SUBSCRIPTION_RUNTIME_BINDINGS.md`. Этот DRAFT не публикует policy
и не включает продажи или использование подписок.

## Реферальный турнирный абонемент (`/ab_leto_referral`)

Для Tilda-страницы реферальной покупки используйте отдельную HTML-вставку из:
```text
docs/tilda-tournament-subscription-referral.html
```

Она читает `https://padlhub.su/lk/release.json` для `prod` или `https://lk-reserve.89-108-64-209.sslip.io/lk/release-dev.json` для `dev`, подставляет версию к `tournament-subscription-referral.js` / `tournament-subscription-referral-dev.js` и монтирует `LKWidgetTournamentSubscriptionReferral` в `#root`.

Обязательные query-параметры:
- `inviteId`

Legacy fallback пока ещё поддерживается, но не должен использоваться в новых ссылках:
- `ownerPhone`
- `ownerSubscriptionId`

Опционально:
- `cabinetUrl` или `returnUrl` — URL возврата по кнопке `Назад`
- `channel=dev` — принудительно включить dev-бандл

Пример:
```text
https://padlhub.ru/ab_leto_referral?inviteId=<REFERRAL_INVITE_ID>
```

Runtime ожидает опубликованные backend routes на `/lk/tournaments/referral-subscription/status`, `/lk/tournaments/referral-subscription/purchase` и `/lk/tournaments/referral-subscription/confirm`.

## Bundle проведения турнира (`tournaments.js`)

`tournaments.js` и глобал `LKWidgetTournaments` остаются organizer bundle для проведения турнира. Он должен открываться из ЛК/overlay и не должен монтироваться на публичный Tilda-маршрут `/tournaments`, потому что этот маршрут теперь является public signup page на `tournament-signup.js`.

Legacy-ссылки публичной страницы турнира лучше оставлять рабочими через 301 на публичный домен LK:
```nginx
location ~ ^/api/tournaments/public/([^/?#]+)$ {
    return 301 https://padlhub.ru/tournaments?slug=$1;
}
```

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

Если приглашения уже были разосланы на техническом домене `padlhub.su`, добавьте редирект на публичный домен. Иначе nginx на `.su` вернет 404 до загрузки React:
```nginx
location = /community_join {
    return 301 https://padlhub.ru$request_uri;
}
```

Логика:
- если пользователь не авторизован, сначала показывается форма входа;
- после входа ЛК автоматически отправляет запрос на вступление в сообщество;
- затем открывается нужное сообщество или показывается ошибка/статус модерации.

## iOS / TestFlight

Платформа iOS генерируется через Capacitor и живёт в `ios/`. Текущий bundle id — `com.cabinet.app`; перед публикацией проверьте, что он зарегистрирован в Apple Developer / App Store Connect и совпадает с provisioning profile.

Разовая настройка для свежего клона:
```bash
npm install
npx cap add ios
```

Обычная подготовка перед тестовой сборкой:
```bash
npm run build:prod
npm run cap:sync:ios
```

Открыть нативный проект в Xcode:
```bash
npm run ios:open
```

Если удобнее собирать из CLI на Mac с полным Xcode:
```bash
npm run ios:build:debug
npm run ios:archive
```

Путь деплоя в TestFlight:
1. Откройте `ios/App/App.xcodeproj` в Xcode.
2. Выберите Apple Developer Team и проверьте automatic signing.
3. Проверьте bundle identifier, version и build number.
4. Перед загрузкой замените placeholder app icon на брендированный комплект.
5. Создайте Archive и загрузите его в App Store Connect.
6. Включите TestFlight и сначала добавьте internal testers; external testers требуют Beta App Review.
# Tournament results broadcast (Node-RED)

Перед включением кнопки трансляции в runtime Node-RED должны быть заданы server-only переменные:

```env
TOURNAMENT_BROADCAST_API_BASE_URL=https://integration-api.example
TOURNAMENT_BROADCAST_BEARER_TOKEN=<server-only token>
CUP_STATION_SETTINGS_JSON={"<station-id>":{"tournamentBroadcastBoxId":"<box-id>"}}
```

`CUP_STATION_SETTINGS_JSON` — runtime-проекция настроек станций ЦУП, а не второй источник истины. ЦУП хранит поле `tournamentBroadcastBoxId`, а deployment/runtime sync публикует актуальный snapshot для Node-RED.

Для Сколково (`0d5504f6-ea6f-44bb-a9e4-947faf0273ab`) и Нагатинской (`6b2d7e60-caff-4b22-89f6-6f19d7d311ab`) проекция должна содержать по две разные server-only привязки. Реальные UUID приставок подставляются в PM2/runtime env и не коммитятся:

```json
{
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab": {
    "tournamentBroadcastTargets": {
      "right_arena": "<right-arena-box-id>",
      "left_arena": "<left-arena-box-id>"
    }
  },
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab": {
    "tournamentBroadcastTargets": {
      "right_arena": "<court-1-screen-box-id>",
      "left_arena": "<court-7-screen-box-id>"
    }
  }
}
```

Frontend отправляет только `target=right_arena|left_arena|both`. Node-RED повторно проверяет station ID сохранённого турнира, не принимает `boxId` из запроса и для `both` выполняет два upstream-вызова. Перед вызовами должен быть подтверждён атомарный `starting` claim; каждая device-команда должна нести `msg.requestTimeout=20000`, recovery lease — 60 секунд, finalize/cleanup — только по CAS.

Для ограниченного теста одной связки допустимы server-only overrides:

```env
TOURNAMENT_BROADCAST_TEST_TOURNAMENT_ID=<test-tournament-id>
TOURNAMENT_BROADCAST_TEST_BOX_ID=<test-box-id>
```

После обновления env перезапустить Node-RED штатным способом, импортировать `node-red/modular/imports/lk_tournament_broadcast.nodes.import.json` в enabled tab `LK Tournaments` и проверить status → start → status → stop → status. Status должен вызывать box-control `GET /integrations/v1/devices/{box_id}/status` и учитывать только точное совпадение `tournament_id`. Для Сколково и Нагатинской отдельно проверить каждый экран и `both`, конкурентный start, fresh/stale `starting`, повторное открытие manager/status, подтверждённую Mongo-запись и остановку всех сохранённых `activeTargets`. Терехово остаётся single-screen. Bearer и реальные UUID приставок нельзя добавлять в `.env` Vite, Tilda HTML, frontend source или flow JSON.

## Viva User-Agent

Server-side обращения к Viva используют стабильный
`User-Agent: PadlHub-LK/1.0`. Node-RED candidate формируется только отдельным
guarded-патчером из свежего live-147 workspace; обычная frontend-сборка и её
деплой этот заголовок не активируют. Полный порядок подготовки, review и
provider postcheck: `docs/VIVA_USER_AGENT.md`.

## Partner Game Membership API v0.2

Этот endpoint нельзя выкладывать обычным frontend deploy. Сначала нужен свежий private
Node-RED workspace с `lk-primary-147`, затем
создать canonical user-owned parent с mode `0700` и выполнить
`npm run nodered:partner-game-membership:v02-packet -- --workspace <workspace> --out <private-parent/new-child>`.
`<new-child>` не должен существовать; world-writable `/private/tmp` не подходит как
непосредственный parent.
Packet всегда содержит `liveMutationAuthorized=false`, `deploymentPerformed=false` и
`activationPerformed=false`. Его наличие не разрешает install/import/restart, создание
Mongo indexes, provisioning secrets/ACL, ingress change или Viva mutation. Полный
порядок, обязательные external ответы и rollback gates описаны в
`docs/PARTNER_GAME_MEMBERSHIP_API.md`.

Перед генерацией и перед любым production-side переходом отдельно выполнить
`npm run validate:partner-game-membership-production-controls` и
`npm run validate:partner-game-membership-runtime`. Packet обязан содержать
`production-controls.contract.json` с тем же SHA-256, что `deployment-plan.json`, exact
runtime lock/`npm ls`/audit/functional manifest, dedicated-sidecar `source.flow.json` и финальный
`packet.manifest.json`, а также девять exact sidecar artifacts: baseline settings,
`settings-runtime.cjs`, factory/guard/startup/audit/policy, default-off hardened
systemd unit и новый guarded no-network readback. См.
`docs/PARTNER_GAME_MEMBERSHIP_GUARDED_RELEASE.md`. Functional rehearsal доказывает только exact custom-node
load/default-off/removal compatibility, но не deploy-stage service/ingress read-back. Packet собирается
в sibling temp-directory и становится видимым только atomic rename после fsync.
Текущее состояние — `runtime=SECURITY_AUDIT_PASS`, `ingress=UNBOUND`,
`custody=UNBOUND`, `activation=BLOCKED`: exact minimal Node-RED `5.0.6` sidecar closure
имеет `0 critical / 0 high / 7 moderate / 0 low`. Bounded local production-palette
observation имеет `5 critical / 12 high / 23 moderate`, но не является immutable
deploy evidence без raw lock/audit и независимого refresh. Поэтому Partner package нельзя ставить в
общий Node-RED `4.0.9` на `127.0.0.1:1880`. Отдельный sidecar должен слушать только
`127.0.0.1:18894`, а shared flow и palette остаются неизменными. Exact
ingress/custody contract, limits и rehearsal evidence описаны в
`docs/PARTNER_GAME_MEMBERSHIP_PRODUCTION_CONTROLS.md`. Private binding проверяется
`npm run validate:partner-game-membership-production-binding -- --binding <absolute-json> --packet-root <absolute-bound-packet> --expected-approved-commit <40hex> --expected-approved-tree <40hex>`:
обязательны exclusive Host/SNI, mTLS, audience, socket-peer identity, отрицательный
readback, out-of-band approved commit/tree, exact packet path/owner/hash/modes/semantics, custody owners и разные
test/production fingerprints; production certificate fingerprint обязан совпадать с
декларируемым в overlay ingress mTLS certificate fingerprint. Production CLI выполняется на target Linux host
от UID `0` и связывает `targetHostname` и SHA-256 `/etc/machine-id`. Даже PASS validator не
пройдёт при target platform/architecture, отличных от rehearsed `linux/x64`, и не
разрешает менять ingress, секреты, packet custody или production runtime. Его успешный
результат — только `DECLARED_EVIDENCE_UNVERIFIED_NOT_AUTHORIZED`: ingress
config/readback/certificate/CA и negative probes должен проверить отдельный live
verifier до deploy. Активация также требует отдельного sidecar-compatible Viva token
acquisition/refresh/revocation contract; shared Node-RED global context не используется.
