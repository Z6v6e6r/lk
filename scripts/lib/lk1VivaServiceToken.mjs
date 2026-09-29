const TOKEN_URL = 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token';
const clean = value => typeof value === 'string' ? value.trim() : '';

// The service credentials are read again on refresh, so atomic file replacement
// rotates them without exposing a bearer token in the worker configuration.
export function createLk1VivaServiceToken({ readConfig, fetchImpl = fetch,
  now = Date.now, timeoutMs = 15000 }) {
  if (typeof readConfig !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('VIVA_TOKEN_CONFIG_INVALID');
  }
  let cached = '', expiresAt = 0, pending = null;
  const token = async () => {
    if (cached && now() < expiresAt - 30_000) return cached;
    if (!pending) pending = (async () => {
      const config = await readConfig();
      const tokenUrl = clean(config?.tokenUrl);
      const clientId = clean(config?.clientId);
      const username = clean(config?.username);
      const password = clean(config?.password);
      if (tokenUrl !== TOKEN_URL || !clientId || !username || !password
        || [clientId, username, password].some(value => /[\r\n]/.test(value))) {
        throw new Error('VIVA_TOKEN_CONFIG_INVALID');
      }
      const response = await fetchImpl(tokenUrl, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username, password }),
      });
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      const accessToken = clean(payload?.access_token);
      const lifetime = Number(payload?.expires_in);
      if (response.status !== 200 || !accessToken || /[\r\n]/.test(accessToken)
        || !Number.isFinite(lifetime) || lifetime < 60 || lifetime > 2_592_000) {
        throw new Error('VIVA_TOKEN_UNAVAILABLE');
      }
      cached = accessToken;
      // Viva currently reports a seven-day bearer lifetime. Keep a much
      // shorter local cache so rotated service credentials are picked up.
      expiresAt = now() + Math.min(lifetime, 900) * 1000;
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
  token.invalidate = () => { cached = ''; expiresAt = 0; };
  return token;
}
