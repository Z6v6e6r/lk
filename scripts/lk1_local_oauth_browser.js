/* global document, window, location, history */
// Runs only in the outer local shell or the static callback document, never in
// the app iframe. No provider credential, verifier or profile is persisted here.
(async function () {
  'use strict';
  const status = document.getElementById('lk1-oauth-status');
  const button = document.getElementById('lk1-yandex');
  const message = code => ({
    LK1_LOCAL_PHONE_REQUIRED: 'У аккаунта Яндекса не подтверждён телефон в Viva. Используйте SMS или сначала завершите привязку в боевом ЛК.',
    LK1_LOCAL_LOGOUT_OR_WAIT: 'Сначала выйдите из текущего локального аккаунта или дождитесь завершения входа.',
    LK1_LOCAL_RATE_LIMIT: 'Слишком много попыток. Повторите вход позже.',
    LK1_LOCAL_OAUTH_STATE: 'Сессия входа не совпала. Вернитесь в локальный ЛК и начните вход заново.',
    LK1_LOCAL_SESSION_REQUIRED: 'Сессия входа истекла или прокси был перезапущен. Начните вход заново.',
  }[code] || 'Не удалось завершить вход. Проверьте доступ к Viva после отключения VPN и начните вход заново.');
  const call = async (route, payload = {}) => {
    const response = await fetch('/__lk1_local/gateway', { method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-LK1-Preview': 'readonly-v1' }, body: JSON.stringify({ route, payload }) });
    const data = await response.json();
    if (!response.ok) throw new Error(message(data.code));
    return data;
  };
  if (button) {
    button.addEventListener('click', async () => {
      button.disabled = true; status.textContent = 'Открываем вход через Яндекс…';
      try {
        const data = await call('auth.oauth.start');
        const url = new URL(data.authorizeUrl);
        if (url.origin !== 'https://kc.vivacrm.ru' || url.pathname !== '/realms/clients/protocol/openid-connect/auth'
          || url.username || url.password || url.hash || url.searchParams.get('kc_idp_hint') !== 'yandex'
          || url.searchParams.get('redirect_uri') !== 'http://127.0.0.1:5180/lk_new?authMode=viva') throw new Error('Недопустимый адрес входа.');
        window.location.assign(url.href);
      } catch (error) { status.textContent = error.message; button.disabled = false; }
    });
    return;
  }
  if (!status || window.top !== window.self) return;
  const params = new URLSearchParams(location.search);
  // Remove code/state/error from the address bar before any request or message.
  history.replaceState({}, '', '/');
  try {
    const allowed = ['authMode', 'code', 'state', 'iss', 'session_state', 'error', 'error_description'];
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)
      || params.get('authMode') !== 'viva') throw new Error('Некорректный ответ входа. Начните вход заново.');
    const payload = { state: params.get('state') };
    if (params.has('iss')) payload.iss = params.get('iss');
    if (params.has('error')) payload.error = 'provider_error';
    else payload.code = params.get('code');
    const data = await call('auth.oauth.finish', payload);
    const parts = String(data.access_token || '').split('.');
    const decode = part => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    if (parts.length !== 3 || decode(parts[0]).alg !== 'LOCAL' || decode(parts[1]).iss !== location.origin
      || decode(parts[1]).phone_number !== 'local-preview' || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])
      || !/^lk1-local\.[A-Za-z0-9_-]{43}$/.test(data.refresh_token || '')
      || !Number.isFinite(data.expires_in) || data.expires_in <= 0
      || !Number.isFinite(data.refresh_expires_in) || data.refresh_expires_in <= 0) throw new Error('Некорректная локальная сессия.');
    // Same storage envelope as the existing LK1; these are opaque local display
    // handles. Never write host-wide cookies from this outer document.
    try {
      for (const [key, token, ttl] of [
        ['padlhub_auth_token_v1', data.access_token, data.expires_in],
        ['padlhub_refresh_token_v1', data.refresh_token, data.refresh_expires_in],
      ]) localStorage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + ttl * 1000 }));
    } catch {
      await call('auth.logout');
      throw new Error('Браузер запрещает локальное хранилище. Разрешите его для 127.0.0.1 и начните вход заново.');
    }
    window.location.replace('/');
  } catch (error) { status.textContent = error.message; }
})();
