/* global window, document */
/* PadlHub Zero Block adapter v2.0 — designer bindings + embedded authenticated checkout. */
(function (window, document) {
  'use strict';
  if (window.PadlHubZeroBlock) return;

  var STATUS_URL = 'https://padlhub.su/lk/tournaments/summer-subscription/status';
  var runtimePromise = null;
  var runtimeChannel = null;
  function loadCheckout(channel) {
    if (runtimeChannel && runtimeChannel !== channel) return Promise.reject(new Error('Нельзя смешивать PROD и DEV на одной странице'));
    runtimeChannel = channel;
    var widget = window.LKWidgetSubscriptionStorefront;
    if (widget) return widget.checkoutVersion === 1 && widget.checkoutChannel === channel
      ? Promise.resolve(widget) : Promise.reject(new Error('Уже подключён несовместимый модуль оформления или другой канал. Уберите старую вставку и обновите страницу.'));
    if (runtimePromise) return runtimePromise;
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
      } finally { window.clearTimeout(timeout); }
      return new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        var deadline = window.setTimeout(function () { reject(new Error('Не удалось загрузить оформление. Обновите страницу.')); }, 20000);
        script.src = base + 'subscription-storefront' + suffix + '.js?v=' + encodeURIComponent(release.version);
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.onload = function () {
          window.clearTimeout(deadline);
          var api = window.LKWidgetSubscriptionStorefront;
          if (!api || api.checkoutVersion !== 1 || api.checkoutChannel !== channel || typeof api.openCheckout !== 'function') {
            reject(new Error('Нужна опубликованная версия модуля с поддержкой Zero Block'));
          } else resolve(api);
        };
        script.onerror = function () { window.clearTimeout(deadline); reject(new Error('Не удалось загрузить оформление')); };
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
    var refreshMs = Math.max(30000, Number(options.refreshMs) || 30000);
    var states = {}, lastGood = {}, active = true, pending = null, timer = null;
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
      text('price', key, data ? money.format(data.priceMinor / 100) + ' ₽' : '—');
      text('remaining', key, data && data.remaining !== null ? String(data.remaining) : '—');
      text('total', key, data && data.total !== null ? String(data.total) : '—');
      var message = promo ? 'Акция · условия проверяются при оформлении'
        : state.status === 'loading' ? 'Проверяем доступность…'
        : state.status === 'error' ? 'Не удалось обновить данные. Попробуйте позже.'
        : usable ? '' : 'Сейчас недоступно';
      if (!checkout) message = checkoutError || 'Загружаем оформление…';
      text('status', key, message);
      elements('counter', key).forEach(function (element) {
        attribute(element, 'data-ph-hidden', data && data.remaining !== null ? null : 'true');
      });
      elements('status', key).forEach(function (element) { attribute(element, 'role', 'status'); });
      elements('card', key).forEach(function (element) { attribute(element, 'data-ph-state', state.status); });
      elements('buy', key).forEach(function (wrapper) {
        var element = wrapper.matches('a,button') ? wrapper : wrapper.querySelector('a,button,.tn-atom') || wrapper;
        attribute(wrapper, 'data-ph-state', state.status);
        attribute(element, 'aria-disabled', usable ? 'false' : 'true');
        attribute(element, 'tabindex', usable ? '0' : '-1');
        if (element.tagName === 'A') {
          attribute(element, 'href', usable ? '#ph-checkout' : null);
          attribute(element, 'target', '_self');
          attribute(element, 'role', 'button');
        } else {
          attribute(element, 'role', 'button');
          if (element.tagName === 'BUTTON') attribute(element, 'disabled', usable ? null : '');
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
      if (active && liveKeys.length && !document.hidden) timer = window.setTimeout(refresh, refreshMs);
    }
    function refresh() {
      if (!active) return Promise.resolve();
      if (pending) return pending;
      window.clearTimeout(timer);
      pending = Promise.all(liveKeys.map(async function (key) {
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
          window.clearTimeout(timeout); controllers.delete(controller);
        }
        if (active) render(key);
      })).finally(function () { pending = null; schedule(); });
      return pending;
    }
    function onVisibility() {
      window.clearTimeout(timer);
      if (!document.hidden) void refresh();
    }
    document.addEventListener('visibilitychange', onVisibility);
    var api = {
      refresh: refresh,
      getState: function (key) {
        if (!states[key]) return null;
        return { status: states[key].status, data: states[key].data ? Object.assign({}, states[key].data) : null, checkoutReady: Boolean(checkout), checkoutError: checkoutError };
      },
      destroy: function () {
        if (!active) return true;
        if (checkout && !checkout.closeCheckout()) return false;
        active = false; window.clearTimeout(timer);
        controllers.forEach(function (controller) { controller.abort(); });
        root.removeEventListener('click', onClick, true);
        root.removeEventListener('keydown', onKey, true);
        document.removeEventListener('visibilitychange', onVisibility);
        restorers.reverse().forEach(function (restore) { restore(); });
        instances.delete(root);
        return true;
      }
    };
    instances.set(root, api);
    void loadCheckout(channel).then(function (value) {
      if (!active) return;
      checkout = value;
      keys.forEach(render);
      checkout.resumeCheckout();
    }).catch(function (error) {
      if (!active) return;
      checkoutError = error.message || 'Оформление недоступно';
      keys.forEach(render);
    });
    void refresh();
    return api;
  }
  window.PadlHubZeroBlock = Object.freeze({ version: '2.0.0', init: init });
})(window, document);
