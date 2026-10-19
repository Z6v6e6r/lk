/* global window, document */
/* PadlHub Zero Block adapter v2.1.0 — scoped bindings + optional lazy checkout/fallback. */
(function (window, document) {
  'use strict';
  if (window.PadlHubZeroBlock) return;

  var STATUS_URL = 'https://padlhub.su/lk/tournaments/summer-subscription/status';
  var runtimePromise = null;
  var runtimeChannel = null;
  var runtimeIsolationRequired = false, runtimeScriptStarted = false, runtimeIntegrityProtected = false;
  function compatible(api, channel, isolated) {
    return api && api.checkoutVersion === 1 && api.checkoutChannel === channel && (!isolated || (api.checkoutIsolationVersion === 1 && typeof api.isCheckoutOpen === 'function'))
      && ['openCheckout', 'closeCheckout', 'resumeCheckout'].every(function (key) { return typeof api[key] === 'function'; });
  }
  function loadCheckout(channel, isolated) {
    if (runtimeChannel && runtimeChannel !== channel) return Promise.reject(new Error('Нельзя смешивать PROD и DEV на одной странице'));
    runtimeChannel = channel;
    var widget = window.LKWidgetSubscriptionStorefront;
    if (widget) return compatible(widget, channel, isolated)
      ? Promise.resolve(widget) : Promise.reject(new Error('Уже подключён несовместимый модуль оформления или другой канал. Уберите старую вставку и обновите страницу.'));
    if (isolated) {
      if (runtimeScriptStarted && !runtimeIntegrityProtected) return Promise.reject(new Error('Неизолированный модуль уже загружается. Уберите вторую вставку.'));
      runtimeIsolationRequired = true;
    }
    if (runtimePromise) return runtimePromise.then(function (api) {
      if (!compatible(api, channel, isolated)) throw new Error('Нужна изолированная версия оформления');
      return api;
    });
    runtimePromise = (async function () {
      var origin = channel === 'dev' ? 'https://lk-reserve.89-108-64-209.sslip.io' : 'https://padlhub.su';
      var base = origin + '/lk/subscription-storefront/';
      var suffix = channel === 'dev' ? '-dev' : '';
      window.__LK_BASE_URLS__ = [origin + '/lk'];
      window.__LK_API_BASE_URLS__ = [origin];
      window.__LK_ACTIVE_BASE_URL__ = origin + '/lk';
      var controller = new AbortController();
      var timeout = window.setTimeout(function () { controller.abort(); }, 8000);
      var release;
      try {
        var response = await window.fetch(base + 'release' + suffix + '.json?ts=' + Date.now(), { credentials: 'omit', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Не удалось загрузить версию оформления');
        release = await response.json();
        if (!release || typeof release.version !== 'string' || !release.version) throw new Error('Неизвестная версия оформления');
        // Check before execution: an old bundle can inject global CSS during evaluation.
        if (runtimeIsolationRequired && (release.checkoutVersion !== 1 || release.checkoutIsolationVersion !== 1 || release.checkoutChannel !== channel
            || !release.script || release.script.fileName !== 'subscription-storefront' + suffix + '.js'
            || typeof release.script.integrity !== 'string' || !/^sha384-[A-Za-z0-9+/]{64}$/.test(release.script.integrity))) {
          throw new Error('Нужен опубликованный манифест изолированной версии оформления');
        }
      } finally { window.clearTimeout(timeout); }
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        var settled = false;
        function fail(message) {
          if (settled) return;
          settled = true; window.clearTimeout(deadline);
          script.onload = null; script.onerror = null;
          if (script.parentNode) script.parentNode.removeChild(script);
          reject(new Error(message));
        }
        var deadline = window.setTimeout(function () { fail('Не удалось загрузить оформление. Обновите страницу.'); }, 12000);
        script.src = base + 'subscription-storefront' + suffix + '.js?v=' + encodeURIComponent(release.version);
        script.async = true;
        script.crossOrigin = 'anonymous';
        if (runtimeIsolationRequired) script.integrity = release.script.integrity;
        script.onload = function () {
          if (settled) return;
          window.clearTimeout(deadline);
          var api = window.LKWidgetSubscriptionStorefront;
          if (!compatible(api, channel, isolated)) fail('Нужна опубликованная изолированная версия оформления');
          else { settled = true; resolve(api); }
        };
        script.onerror = function () { fail('Не удалось загрузить оформление'); };
        runtimeScriptStarted = true; runtimeIntegrityProtected = runtimeIsolationRequired;
        document.head.appendChild(script);
      });
    })();
    return runtimePromise;
  }
  var definitions = {
    friendship: { counterKey: 'friendship', label: 'Дружба' },
    'friendship-year': { counterKey: 'network_friendship', label: 'Дружба — год' },
    academy: { counterKey: 'academy', label: 'Академия' },
    ra: { counterKey: 'ra', label: 'РА' },
    energy5: { counterKey: 'energy5', label: 'Энергия 5' },
    'friendship-promo': { promo: true, label: 'Дружба — Питер', priceMinor: 490000 },
    'academy-promo': { promo: true, label: 'Академия — Питер', priceMinor: 1190000 },
    'ra-promo': { promo: true, label: 'РА — Питер', priceMinor: 1190000 }
  };
  var instances = new Map();
  var money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  function known(key) { return Object.prototype.hasOwnProperty.call(definitions, key); }
  function integer(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  function rows(payload) {
    if (!payload || typeof payload !== 'object' || payload.ok === false) return [];
    if (Array.isArray(payload)) return payload;
    var data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (data.ok === false) return [];
    if (Array.isArray(data.plans)) return data.plans;
    if (Array.isArray(data.statuses)) return data.statuses;
    return [data];
  }
  function normalize(payload, key) {
    var matches = rows(payload).filter(function (row) { return row && row.counterKey === key; });
    if (matches.length !== 1) throw new Error('Нет однозначного ответа по счётчику ' + key);
    var row = matches[0];
    var price = integer(row.priceMinor);
    var unlimited = row.unlimited === true;
    var remaining = integer(row.remainingCount), total = integer(row.totalLimit);
    if (price === null || price <= 0 || typeof row.unlimited !== 'boolean' ||
        typeof row.canPurchase !== 'boolean' || typeof row.bindingReady !== 'boolean' ||
        (!unlimited && (remaining === null || total === null || remaining > total))) {
      throw new Error('Неполные данные счётчика ' + key);
    }
    return {
      source: 'live', priceMinor: price, unlimited: unlimited,
      remaining: unlimited ? null : remaining, total: unlimited ? null : total,
      canPurchase: row.canPurchase && row.bindingReady && (unlimited || remaining > 0),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null
    };
  }
  async function fetchStatus(key, signal, channel) {
    var url = new URL(channel === 'dev' ? 'https://lk-reserve.89-108-64-209.sslip.io/lk/tournaments/summer-subscription/status' : STATUS_URL);
    url.searchParams.set('counterKey', key);
    var response = await window.fetch(url.toString(), {
      method: 'GET', credentials: 'omit', cache: 'no-store', signal: signal
    });
    if (!response.ok) throw new Error('Статус временно недоступен (HTTP ' + response.status + ')');
    return normalize(await response.json(), key);
  }
  function selector(type, key) {
    return '.ph-' + type + '-' + key + ',[data-ph-' + type + '="' + key + '"]';
  }
  function init(options) {
    options = options || {};
    var root = typeof options.root === 'string' ? document.querySelector(options.root) : options.root || document;
    if (!root || !root.querySelectorAll) throw new Error('Контейнер Zero Block не найден');
    if (instances.has(root)) throw new Error('Этот контейнер уже подключён; сначала вызовите destroy()');
    var keys = Array.from(new Set(options.offerKeys || ['friendship', 'academy', 'ra']));
    if (!keys.length || keys.some(function (key) { return !known(key); })) throw new Error('Проверьте offerKeys');
    var channel = options.channel || 'prod';
    if (channel !== 'prod' && channel !== 'dev') throw new Error('channel: prod или dev');
    var checkout = null, checkoutError = null;
    var lazy = options.lazyCheckout === true;
    var fallback = options.fallbackToCatalog === true && channel === 'prod' ? 'https://padlhub.ru/sub_hab' : null;
    var opening = null, intent = 0, intentTimer = null;
    var sectionVisible = options.observeVisibility !== true;
    var observer = null, failures = 0;
    var refreshMs = Math.max(30000, Number(options.refreshMs) || 30000);
    var states = {}, lastGood = {}, active = true, pending = null, timer = null, pendingByKey = {};
    var controllers = new Set(), restorers = [], remembered = new WeakMap();
    var liveKeys = keys.filter(function (key) { return !definitions[key].promo; });
    function remember(element, name, restore) {
      var names = remembered.get(element);
      if (!names) { names = new Set(); remembered.set(element, names); }
      if (!names.has(name)) { names.add(name); restorers.push(restore); }
    }
    function attribute(element, name, value) {
      var previous = element.getAttribute(name);
      remember(element, name, function () {
        if (previous === null) element.removeAttribute(name); else element.setAttribute(name, previous);
      });
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    }
    function elements(type, key) { return Array.from(root.querySelectorAll(selector(type, key))); }
    function text(type, key, value) {
      elements(type, key).forEach(function (wrapper) {
        var element = wrapper.matches('.tn-atom') ? wrapper : wrapper.querySelector('.tn-atom') || wrapper;
        var previous = element.innerHTML;
        remember(element, 'text', function () { element.innerHTML = previous; });
        element.textContent = value;
      });
    }
    function emit(key) {
      // Event contains only catalog information, never a session or user profile.
      root.dispatchEvent(new CustomEvent('padlhub:subscription', { detail: { key: key, state: { status: states[key].status, data: states[key].data ? Object.assign({}, states[key].data) : null } } }));
    }
    function render(key) {
      var state = states[key], data = state.data || lastGood[key];
      var promo = definitions[key].promo === true;
      var usable = checkout && (promo || (state.status === 'ready' && data && data.canPurchase));
      var unavailable = !promo && state.status === 'ready' && data && !data.canPurchase;
      var recovery = lazy && hasAttempt(key);
      var interactive = usable || recovery || (fallback && !unavailable);
      text('price', key, data ? money.format(data.priceMinor / 100) + ' ₽' : '—');
      text('remaining', key, data && data.remaining !== null ? String(data.remaining) : '—');
      text('total', key, data && data.total !== null ? String(data.total) : '—');
      var message = promo ? 'Акция · условия проверяются при оформлении'
        : state.status === 'loading' ? 'Проверяем доступность…'
        : state.status === 'error' ? 'Не удалось обновить данные. Попробуйте позже.'
        : interactive ? '' : 'Сейчас недоступно';
      if (!checkout && !lazy) message = checkoutError || 'Загружаем оформление…';
      if (recovery) message = 'Откройте оформление для проверки предыдущей попытки.';
      if (opening && opening.key === key) message = 'Открываем оформление…';
      else if (checkoutError) message = checkoutError;
      text('status', key, message);
      elements('counter', key).forEach(function (element) {
        attribute(element, 'data-ph-hidden', data && data.remaining !== null ? null : 'true');
      });
      elements('status', key).forEach(function (element) { attribute(element, 'role', 'status'); });
      elements('card', key).forEach(function (element) { attribute(element, 'data-ph-state', state.status); });
      elements('buy', key).forEach(function (wrapper) {
        var element = wrapper.matches('a,button') ? wrapper : wrapper.querySelector('a,button,.tn-atom') || wrapper;
        attribute(wrapper, 'data-ph-state', state.status);
        attribute(element, 'aria-disabled', interactive ? 'false' : 'true');
        attribute(element, 'aria-busy', opening && opening.key === key ? 'true' : null);
        attribute(element, 'tabindex', interactive ? '0' : '-1');
        if (element.tagName === 'A') {
          attribute(element, 'href', fallback || (usable ? '#ph-checkout=' + key : null));
          attribute(element, 'target', '_self');
          attribute(element, 'role', 'button');
        } else {
          attribute(element, 'role', 'button');
          if (element.tagName === 'BUTTON') attribute(element, 'disabled', interactive ? null : '');
        }
      });
      emit(key);
    }
    keys.forEach(function (key) {
      var def = definitions[key];
      states[key] = def.promo ? {
        status: 'static', data: { source: 'static', priceMinor: def.priceMinor,
          remaining: null, total: null, canPurchase: null, unlimited: null, updatedAt: null }
      } : { status: 'loading', data: null };
      render(key);
    });
    function matchTarget(event) {
      if (!(event.target instanceof window.Element)) return null;
      return keys.find(function (key) {
        var match = event.target.closest(selector('buy', key));
        return match && (root === document || root.contains(match));
      }) || null;
    }
    function onClick(event) {
      var key = matchTarget(event);
      if (!key) return;
      // Preserve open-in-new-tab/window and middle-click semantics of the real fallback link.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button !== undefined && event.button !== 0)) return;
      if (lazy) {
        event.preventDefault(); event.stopImmediatePropagation();
        void open(key, event.target.closest('a,button') || event.target.closest(selector('buy', key)));
        return;
      }
      var state = states[key];
      if (!checkout || (!definitions[key].promo && (state.status !== 'ready' || !state.data.canPurchase))) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      event.preventDefault(); event.stopImmediatePropagation();
      try {
        var trigger = event.target.closest('a,button') || event.target.closest(selector('buy', key));
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
        checkout.openCheckout(key);
      } catch (error) { text('status', key, error.message || 'Не удалось открыть оформление'); }
    }
    function onKey(event) {
      var key = matchTarget(event);
      if (!key || event.target.closest('button') || (event.target.closest('a') && event.key === 'Enter') || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      event.target.click();
    }
    root.addEventListener('click', onClick, true);
    root.addEventListener('keydown', onKey, true);
    function schedule() {
      if (active && sectionVisible && liveKeys.length && !document.hidden) timer = window.setTimeout(refresh, Math.min(300000, refreshMs * Math.pow(2, failures)));
    }
    function refreshKey(key) {
      if (!active || definitions[key].promo) return Promise.resolve();
      if (pendingByKey[key]) return pendingByKey[key];
      pendingByKey[key] = (async function () {
        var controller = new AbortController(); controllers.add(controller);
        var timeout = window.setTimeout(function () { controller.abort(); }, 12000);
        try {
          var data = await fetchStatus(definitions[key].counterKey, controller.signal, channel);
          if (!active) return;
          lastGood[key] = data;
          states[key] = { status: 'ready', data: data };
        } catch {
          if (!active) return;
          states[key] = { status: 'error', data: null };
        } finally {
          window.clearTimeout(timeout); controllers.delete(controller); delete pendingByKey[key];
        }
        if (active) render(key);
      })();
      return pendingByKey[key];
    }
    function refresh() {
      if (!active) return Promise.resolve();
      if (pending) return pending;
      window.clearTimeout(timer);
      pending = Promise.all(liveKeys.map(refreshKey)).finally(function () {
        failures = liveKeys.some(function (key) { return states[key].status === 'error'; }) ? Math.min(failures + 1, 4) : 0;
        pending = null; schedule();
      });
      return pending;
    }
    function onVisibility() {
      window.clearTimeout(timer);
      if (document.hidden) cancelOpening();
      else if (sectionVisible) void refresh();
    }
    document.addEventListener('visibilitychange', onVisibility);
    function cancelOpening() {
      intent++; window.clearTimeout(intentTimer); opening = null;
      if (active) keys.forEach(render);
    }
    function onEscape(event) { if (event.key === 'Escape' && opening) cancelOpening(); }
    document.addEventListener('keydown', onEscape, true);
    function hasAttempt(key) {
      try { return window.localStorage.getItem('padlhub_zero_checkout_attempt_v1:' + key) !== null; }
      catch { return true; } // Unknown custody must never cause an automatic alternative purchase path.
    }
    function open(key, trigger, resume) {
      if (!active || keys.indexOf(key) < 0 || opening) return Promise.resolve();
      if (checkout && typeof checkout.isCheckoutOpen === 'function' && checkout.isCheckoutOpen()) {
        checkout.openCheckout(key); return Promise.resolve();
      }
      var state = states[key];
      var recovery = resume || hasAttempt(key);
      if (!recovery && !definitions[key].promo && state.status === 'ready' && !state.data.canPurchase) return Promise.resolve();
      var generation = ++intent;
      opening = { key: key };
      checkoutError = null;
      root.dispatchEvent(new CustomEvent('padlhub:checkout-intent', { detail: { key: key } }));
      keys.forEach(render);
      function current() { return active && generation === intent && !document.hidden; }
      function failed(error) {
        if (!current()) return;
        cancelOpening();
        checkoutError = error.message || 'Оформление недоступно';
        keys.forEach(render);
        // This only covers loading/opening UI. Payment/auth errors remain inside checkout.
        var runtime = window.LKWidgetSubscriptionStorefront;
        var openAlready = runtime && typeof runtime.isCheckoutOpen === 'function' && runtime.isCheckoutOpen();
        if (fallback && !recovery && !openAlready && !hasAttempt(key)) window.location.assign(fallback);
      }
      var deadline = new Promise(function (_resolve, reject) {
        intentTimer = window.setTimeout(function () { reject(new Error('Оформление загружается слишком долго')); }, 12000);
      });
      return Promise.race([Promise.all([recovery ? Promise.resolve() : refreshKey(key), loadCheckout(channel, options.requireIsolation === true)]), deadline]).then(function (result) {
        if (!current()) { if (active && generation === intent) cancelOpening(); return; }
        checkout = result[1];
        var currentState = states[key];
        if (!recovery && !definitions[key].promo && (currentState.status !== 'ready' || !currentState.data)) throw new Error('Не удалось проверить доступность');
        if (!recovery && !definitions[key].promo && !currentState.data.canPurchase) { cancelOpening(); return; }
        window.clearTimeout(intentTimer); opening = null;
        keys.forEach(render);
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
        if (resume) checkout.resumeCheckout(key); else checkout.openCheckout(key);
      }).catch(failed);
    }
    function hashKey() {
      if (new URLSearchParams(window.location.search || '').has('phCheckoutReturn')) return null;
      var match = /^#ph-checkout=([a-z0-9-]+)$/.exec(window.location.hash || '');
      return match && keys.indexOf(match[1]) >= 0 ? match[1] : null;
    }
    function onHash() {
      var key = hashKey();
      if (opening && opening.key !== key) cancelOpening();
      if (key) void open(key);
    }
    if (lazy) window.addEventListener('hashchange', onHash);
    var api = {
      refresh: refresh,
      openCheckout: function (key) { return open(key); },
      refreshBindings: function () { if (active) keys.forEach(render); },
      getState: function (key) {
        if (!states[key]) return null;
        return { status: states[key].status, data: states[key].data ? Object.assign({}, states[key].data) : null, checkoutReady: Boolean(checkout), checkoutError: checkoutError };
      },
      destroy: function () {
        if (!active) return true;
        if (checkout && !checkout.closeCheckout()) return false;
        active = false; window.clearTimeout(timer);
        cancelOpening();
        if (observer) observer.disconnect();
        controllers.forEach(function (controller) { controller.abort(); });
        root.removeEventListener('click', onClick, true);
        root.removeEventListener('keydown', onKey, true);
        document.removeEventListener('keydown', onEscape, true);
        if (lazy) window.removeEventListener('hashchange', onHash);
        document.removeEventListener('visibilitychange', onVisibility);
        restorers.reverse().forEach(function (restore) { restore(); });
        instances.delete(root);
        return true;
      }
    };
    instances.set(root, api);
    var marker = root === document ? document.documentElement : root;
    if (marker && marker.setAttribute) attribute(marker, 'data-ph-zero-root', '');
    if (!lazy) void loadCheckout(channel, options.requireIsolation === true).then(function (value) {
      if (!active) return;
      checkout = value;
      keys.forEach(render);
      checkout.resumeCheckout();
    }).catch(function (error) {
      if (!active) return;
      checkoutError = error.message || 'Оформление недоступно';
      keys.forEach(render);
    });
    if (options.observeVisibility === true && root !== document && typeof window.IntersectionObserver === 'function') {
      observer = new window.IntersectionObserver(function (entries) {
        sectionVisible = entries.some(function (entry) { return entry.isIntersecting; });
        window.clearTimeout(timer);
        if (sectionVisible && !document.hidden) void refresh();
      });
      observer.observe(root);
    } else if (sectionVisible) void refresh();
    if (lazy) {
      var selected = null, resume = false;
      var returns = new URLSearchParams(window.location.search || '').getAll('phCheckoutReturn');
      if (returns.length === 1 && keys.indexOf(returns[0]) >= 0) { selected = returns[0]; resume = true; }
      else if (!returns.length) {
        selected = hashKey();
        try {
          var saved = JSON.parse(window.sessionStorage.getItem('padlhub_zero_checkout_selection_v1') || 'null');
          var age = saved && Date.now() - saved.at;
          if (saved && (!selected || selected === saved.key) && keys.indexOf(saved.key) >= 0 && typeof saved.at === 'number' && age >= 0 && age < 1800000) { selected = saved.key; resume = true; }
        } catch { /* A malformed selection must not load checkout. */ }
      }
      if (selected) void open(selected, null, resume);
    }
    return api;
  }
  window.PadlHubZeroBlock = Object.freeze({ version: '2.1.0', init: init });
})(window, document);
