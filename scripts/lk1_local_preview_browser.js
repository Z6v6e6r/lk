/* global window, location, XMLHttpRequest, document, Document, Element, MutationObserver */
(function () {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  const blocked = () => nativeFetch('/__lk1_local/blocked', { method: 'GET', credentials: 'omit', cache: 'no-store' });
  const authBase = 'https://kc.vivacrm.ru/realms/clients';
  const apiBase = 'https://api.vivacrm.ru/end-user/api';
  const tenant = 'iSkq6G';
  const localAccess = value => {
    try {
      const parts = value.split('.');
      const decode = part => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
      return parts.length === 3 && decode(parts[0]).alg === 'LOCAL'
        && decode(parts[1]).iss === location.origin && decode(parts[1]).phone_number === 'local-preview'
        && Number.isFinite(decode(parts[1]).exp) && decode(parts[1]).exp > 0 && value.length < 2048
        && /^[A-Za-z0-9_-]{43}$/.test(parts[2]);
    } catch { return false; }
  };
  const localRefresh = value => /^lk1-local\.[A-Za-z0-9_-]{43}$/.test(value);
  const authCookie = name => /(?:AuthToken|RefreshToken)$/.test(name);
  // Cookies are shared across localhost ports. Do not read, overwrite or delete
  // another local task's real credentials; this preview virtualizes auth cookies.
  if (typeof Document !== 'undefined') {
    const nativeCookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    const localCookies = new Map();
    if (nativeCookie?.get && nativeCookie?.set) Object.defineProperty(document, 'cookie', {
      configurable: true,
      get() {
        const publicCookies = nativeCookie.get.call(document).split(';').map(item => item.trim()).filter(item => item && !authCookie(item.split('=')[0]));
        return [...publicCookies, ...[...localCookies].map(([key, value]) => `${key}=${value}`)].join('; ');
      },
      set(value) {
        const [pair] = String(value).split(';');
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator).trim();
        if (!authCookie(name)) { nativeCookie.set.call(document, value); return; }
        let token;
        try { token = decodeURIComponent(pair.slice(separator + 1)); } catch { return; }
        if (!token || /max-age=0/i.test(value)) { localCookies.delete(name); return; }
        if (name.endsWith('RefreshToken') ? localRefresh(token) : localAccess(token)) localCookies.set(name, encodeURIComponent(token));
      },
    });
  }
  const allowedKeys = (params, keys, repeated = []) => [...params.keys()].every(key => keys.includes(key)
    && (repeated.includes(key) || params.getAll(key).length === 1));
  const translate = async (request) => {
    const url = new URL(request.url);
    if (url.username || url.password || url.hash) return null;
    if (`${url.origin}${url.pathname}` === `${authBase}/sms/authentication-code` && request.method === 'GET'
      && allowedKeys(url.searchParams, ['phoneNumber', 'channel', 'tenantKey']) && url.searchParams.get('tenantKey') === tenant) {
      return { route: 'auth.code', payload: { phone: url.searchParams.get('phoneNumber'), channel: url.searchParams.get('channel') } };
    }
    if (`${url.origin}${url.pathname}` === `${authBase}/protocol/openid-connect/token` && request.method === 'POST' && !url.search) {
      if (request.headers.get('content-type') !== 'application/x-www-form-urlencoded') return null;
      const form = new URLSearchParams(await request.text());
      if (form.get('client_id') !== 'widget') return null;
      if (form.get('grant_type') === 'password' && form.get('tenant_key') === tenant
        && allowedKeys(form, ['grant_type', 'phone_number', 'code', 'client_id', 'tenant_key'])) {
        return { route: 'auth.token', payload: { phone: form.get('phone_number'), code: form.get('code') } };
      }
      if (form.get('grant_type') === 'refresh_token' && allowedKeys(form, ['grant_type', 'client_id', 'refresh_token'])) {
        return { route: 'auth.refresh', payload: { refreshHandle: form.get('refresh_token') } };
      }
      return null;
    }
    if (`${url.origin}${url.pathname}` === `${authBase}/protocol/openid-connect/logout` && request.method === 'POST' && !url.search) {
      return { route: 'auth.logout' };
    }
    if (request.method !== 'GET') return null;
    const paths = {
      [`${apiBase}/v1/${tenant}/profile`]: 'profile',
      [`${apiBase}/v2/${tenant}/bookings`]: 'bookings',
      [`${apiBase}/v2/${tenant}/bookings/history`]: 'history',
      [`${apiBase}/v1/${tenant}/subscriptions`]: 'subscriptions',
      [`${apiBase}/v1/${tenant}/studios`]: 'studios',
    };
    const route = paths[`${url.origin}${url.pathname}`];
    if (!route) return null;
    const keys = route === 'profile' ? [] : route === 'subscriptions' ? ['includeFinished', 'page', 'size', 'sort'] : route === 'history' ? ['includeCanceled', 'size'] : ['size'];
    if (!allowedKeys(url.searchParams, keys, ['sort'])) return null;
    if (route === 'history' && url.searchParams.get('includeCanceled') !== 'true') return null;
    const payload = {};
    for (const key of ['page', 'size']) if (url.searchParams.has(key)) payload[key] = Number(url.searchParams.get(key));
    if (url.searchParams.has('includeFinished')) {
      if (!['true', 'false'].includes(url.searchParams.get('includeFinished'))) return null;
      payload.includeFinished = url.searchParams.get('includeFinished') === 'true';
    }
    if (url.searchParams.has('sort')) payload.sort = url.searchParams.getAll('sort');
    return { route, payload, token: (request.headers.get('authorization') || '').replace(/^Bearer /, '') };
  };
  // The existing app may store local display handles, never production tokens.
  // Analytics must not durably duplicate the user's profile at the local origin.
  const privateStorage = key => /^iSkq6G_lk_analytics_(?:user|visits|pending)_v1$/.test(String(key))
    || /^iSkq6G_pending_auth_consent_v1:/.test(String(key))
    || /^padlhub\.referral-window\.v1\./.test(String(key))
    || /^padlhub\.communities\.(?:order|last-seen|chat-last-read)\.v1:/.test(String(key));
  if (typeof Storage !== 'undefined') {
    const originalSet = Storage.prototype.setItem;
    const originalGet = Storage.prototype.getItem;
    for (const [key, valid] of [['padlhub_auth_token_v1', localAccess], ['padlhub_refresh_token_v1', localRefresh]]) {
      const raw = originalGet.call(window.localStorage, key);
      if (raw) {
        let token = raw;
        try { token = JSON.parse(raw).token || raw; } catch { /* legacy string */ }
        if (!valid(token)) window.localStorage.removeItem(key);
      }
    }
    Storage.prototype.setItem = function (key, value) { if (!privateStorage(key)) originalSet.call(this, key, value); };
    Storage.prototype.getItem = function (key) { return privateStorage(key) ? null : originalGet.call(this, key); };
    for (const storage of [window.localStorage, window.sessionStorage].filter(Boolean)) {
      for (let index = storage.length - 1; index >= 0; index--) {
        const key = storage.key(index);
        if (privateStorage(key)) storage.removeItem(key);
      }
    }
    for (const suffix of ['user', 'visits', 'pending']) window.localStorage.removeItem(`${tenant}_lk_analytics_${suffix}_v1`);
  }
  window.fetch = function (input, init) {
    const request = new Request(input instanceof Request ? input : new URL(String(input), location.href), init);
    if (new URL(request.url).origin === new URL(authBase).origin || new URL(request.url).origin === new URL(apiBase).origin) {
      return translate(request).then(envelope => envelope ? nativeFetch('/__lk1_local/gateway', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-LK1-Preview': 'readonly-v1' },
        body: JSON.stringify(envelope), signal: request.signal,
      }) : blocked());
    }
    if (new URL(request.url).origin !== location.origin || !['GET', 'HEAD'].includes(request.method)) return blocked();
    return nativeFetch(request);
  };
  navigator.sendBeacon = () => false;
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (new URL(String(url), location.href).origin !== location.origin || !['GET', 'HEAD'].includes(String(method).toUpperCase())) {
      throw new Error('LK1_LOCAL_EXTERNAL_ACCESS_DISABLED');
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
  window.open = () => null;
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (link && new URL(link.href, location.href).origin !== location.origin) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  // OAuth would leave the guarded origin. Only the approved SMS flow is offered.
  if (typeof MutationObserver !== 'undefined') {
    const disableOAuth = () => {
      for (const button of document.querySelectorAll('.auth-oauth-btn')) {
        if (!button.disabled) button.disabled = true;
        if (button.title !== 'В локальной версии используйте вход через SMS') button.title = 'В локальной версии используйте вход через SMS';
      }
    };
    new MutationObserver(disableOAuth).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    disableOAuth();
  }
})();
