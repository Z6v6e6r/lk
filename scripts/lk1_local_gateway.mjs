import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const LOCAL_ORIGIN = 'http://127.0.0.1:5180';
export const OAUTH_CALLBACK = `${LOCAL_ORIGIN}/lk_new?authMode=viva`;
const KC = 'https://kc.vivacrm.ru/realms/clients';
const API = 'https://api.vivacrm.ru/end-user/api';
const TENANT = 'iSkq6G';
const COOKIE = 'lk1_preview_session';
const id = () => randomBytes(32).toString('base64url');
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const phoneOk = value => typeof value === 'string' && /^7\d{10}$/.test(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const fail = (status, code = 'LK1_LOCAL_REQUEST_BLOCKED') => ({ status, data: { code, error: code, message: 'Локальный ЛК: запрос недоступен или сессия истекла.' } });

export const webHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([key]) => [
  'host', 'origin', 'accept', 'accept-encoding', 'content-type', 'user-agent',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
].includes(key)));

export function readPlan(route, payload = {}) {
  const query = new URLSearchParams();
  let path;
  if (route === 'profile' && own(payload, [])) path = `/v1/${TENANT}/profile`;
  if (['bookings', 'history', 'studios'].includes(route) && own(payload, ['size'])) {
    const size = payload.size ?? 1000;
    if (!integer(size, 1, 1000)) return null;
    path = route === 'studios' ? `/v1/${TENANT}/studios` : `/v2/${TENANT}/bookings${route === 'history' ? '/history' : ''}`;
    if (route === 'history') query.set('includeCanceled', 'true');
    query.set('size', String(size));
  }
  if (route === 'subscriptions' && own(payload, ['includeFinished', 'page', 'size', 'sort'])) {
    if (payload.includeFinished !== undefined && typeof payload.includeFinished !== 'boolean') return null;
    if (payload.page !== undefined && !integer(payload.page, 0, 100)) return null;
    if (payload.size !== undefined && !integer(payload.size, 1, 1000)) return null;
    if (payload.sort !== undefined && (!Array.isArray(payload.sort) || payload.sort.length > 3
      || payload.sort.some(item => typeof item !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.]{0,40},(?:asc|desc)$/.test(item)))) return null;
    path = `/v1/${TENANT}/subscriptions`;
    for (const key of ['includeFinished', 'page', 'size']) if (payload[key] !== undefined) query.set(key, String(payload[key]));
    for (const sort of payload.sort || []) query.append('sort', sort);
  }
  return path ? { url: `${API}${path}${query.size ? `?${query}` : ''}`, method: 'GET' } : null;
}

// Fixed templates are the only callers of this transport. Never forward upstream
// headers, redirects, cookies, errors, request URLs or credentials into logs.
export async function productionTransport(plan) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(plan.url, {
      method: plan.method, redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', 'X-Correlation-ID': `lk1-local-${id()}`, ...(plan.token ? { Authorization: `Bearer ${plan.token}` } : {}),
        ...(plan.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(plan.body ? { body: plan.body } : {}),
    });
    // SMS may have an empty/text success response. Do not return its body.
    if (plan.sms) { await response.body?.cancel(); return { status: response.status, data: {} }; }
    if (!response.ok) { await response.body?.cancel(); return { status: response.status, data: {} }; }
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) throw new Error('response type');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { controller.abort(); throw new Error('response size'); }
      chunks.push(Buffer.from(chunk));
    }
    return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } finally { clearTimeout(timeout); }
}

// Injectable transport/clock are for local tests only; no environment variable or
// HTTP request can select an upstream or change the production transport.
export function createGateway({ transport = productionTransport, now = Date.now } = {}) {
  // Fail startup if the read-only browser asset mount is missing.
  const oauthScript = readFileSync(new URL('./lk1_local_oauth_browser.js', import.meta.url), 'utf8');
  const sessions = new Map();
  const limits = new Map();
  const counters = { authRequests: 0, readRequests: 0, blockedRequests: 0, upstreamFailures: 0 };
  let circuitUntil = 0; let failures = 0; let inFlight = 0;
  const limit = (key, max, period) => {
    const entry = limits.get(key);
    if (!entry || entry.until <= now()) { limits.set(key, { count: 1, until: now() + period }); return true; }
    entry.count += 1; return entry.count <= max;
  };
  const cookie = value => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/__lk1_local; Max-Age=${value ? 28800 : 0}`;
  const cleanup = () => {
    for (const [key, session] of sessions) if (session.until <= now()) sessions.delete(key);
    for (const [key, entry] of limits) if (entry.until <= now()) limits.delete(key);
  };
  const remote = async plan => {
    if (circuitUntil > now()) throw new Error('circuit open');
    if (inFlight >= 8) throw new Error('too many requests');
    inFlight += 1;
    try {
      const result = await transport(plan);
      if (result.status >= 500) throw new Error('upstream unavailable');
      failures = 0; return result;
    } catch {
      counters.upstreamFailures += 1;
      if (++failures >= 3) circuitUntil = now() + 30000;
      throw new Error('upstream unavailable');
    } finally { inFlight -= 1; }
  };
  const reject = (status, code) => { counters.blockedRequests += 1; return fail(status, code); };
  const bindProfile = (profile, session) => {
    const profilePhone = String(profile?.phone || '').replace(/\D/g, '');
    if (!profile || Array.isArray(profile) || typeof profile.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(profile.id)
      || profilePhone !== session.phone || (session.profileId && session.profileId !== profile.id)) throw new Error('profile subject');
    session.profileId = profile.id; session.profilePhone = profilePhone;
  };
  const minted = (data, session, acceptPhone = false) => {
    if (typeof data?.access_token !== 'string' || typeof data?.refresh_token !== 'string'
      || data.access_token.length > 16000 || data.refresh_token.length > 16000) throw new Error('token shape');
    // This JWT came directly over TLS from the fixed IdP, never from the browser.
    const claims = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString('utf8'));
    const claimedPhone = String(claims.phone_number || claims.phoneNumber || claims.phone || '').replace(/\D/g, '');
    if (acceptPhone && !phoneOk(claimedPhone)) throw new Error('phone required');
    if (claims.iss !== KC || claims.azp !== 'widget' || typeof claims.sub !== 'string' || !claims.sub
      || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now() || (!acceptPhone && claimedPhone !== session.phone)
      || (session.subject && session.subject !== claims.sub)) throw new Error('token subject');
    if (acceptPhone) session.phone = claimedPhone;
    const expires = Math.min(claims.exp * 1000, session.until);
    const localClaims = { iss: LOCAL_ORIGIN, sub: session.displaySubject, phone_number: 'local-preview', exp: Math.floor(expires / 1000) };
    session.previousDisplay = session.displayAccess;
    session.previousUntil = Math.min(session.accessUntil || 0, now() + 30000);
    session.displayAccess = `${Buffer.from('{"alg":"LOCAL","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(localClaims)).toString('base64url')}.${id()}`;
    session.displayRefresh = `lk1-local.${id()}`;
    session.access = data.access_token; session.refresh = data.refresh_token;
    session.subject = claims.sub; session.accessUntil = expires;
    session.refreshUntil = Math.min(session.until, now() + Math.max(1, Math.min(Number(data.refresh_expires_in) || 3600, 28800)) * 1000);
    return { access_token: session.displayAccess, refresh_token: session.displayRefresh,
      expires_in: Math.max(1, Math.floor((expires - now()) / 1000)), refresh_expires_in: Math.floor((session.refreshUntil - now()) / 1000) };
  };

  async function dispatch(envelope, sessionId) {
    cleanup();
    if (!own(envelope, ['route', 'payload', 'token']) || typeof envelope.route !== 'string') return reject(403);
    const { route, payload = {}, token } = envelope;
    let session = sessions.get(sessionId);
    if (route === 'auth.logout' && own(payload, [])) {
      if (session) sessions.delete(sessionId);
      return { status: 200, data: { ok: true }, cookie: cookie('') };
    }
    if (route === 'auth.oauth.start') {
      if (!own(payload, [])) return reject(403);
      if (session?.subject || session?.busy) return reject(409, 'LK1_LOCAL_LOGOUT_OR_WAIT');
      if (!limit('oauth:global', 20, 3600000) || sessions.size >= 32) return reject(429, 'LK1_LOCAL_RATE_LIMIT');
      if (session) sessions.delete(sessionId);
      sessionId = id();
      const verifier = id();
      session = { until: now() + 600000, displaySubject: id(), oauth: { state: id(), verifier } };
      sessions.set(sessionId, session);
      const params = new URLSearchParams({ client_id: 'widget', redirect_uri: OAUTH_CALLBACK,
        response_type: 'code', scope: 'openid', prompt: 'login', kc_idp_hint: 'yandex', tenant_key: TENANT,
        state: session.oauth.state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return { status: 200, cookie: cookie(sessionId), data: { authorizeUrl: `${KC}/protocol/openid-connect/auth?${params}` } };
    }
    if (route === 'auth.oauth.finish') {
      if (!session?.oauth || session.busy || session.subject) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
      if (!own(payload, ['state', 'code', 'iss', 'error']) || payload.state !== session.oauth.state
        || (payload.iss !== undefined && payload.iss !== KC)) return reject(403, 'LK1_LOCAL_OAUTH_STATE');
      const { verifier } = session.oauth;
      delete session.oauth; // One attempt, including provider errors and ambiguous transport failures.
      if (payload.error || typeof payload.code !== 'string' || !/^[A-Za-z0-9._~-]{1,2048}$/.test(payload.code)) {
        sessions.delete(sessionId); return reject(401, 'LK1_LOCAL_OAUTH_FAILED');
      }
      session.busy = true;
      try {
        counters.authRequests += 1;
        const result = await remote({ url: `${KC}/protocol/openid-connect/token`, method: 'POST',
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'widget', code: payload.code,
            redirect_uri: OAUTH_CALLBACK, code_verifier: verifier }).toString() });
        if (result.status !== 200) throw new Error('exchange failed');
        session.until = now() + 28800000;
        const data = minted(result.data, session, true);
        counters.readRequests += 1;
        const profile = await remote({ ...readPlan('profile'), token: session.access });
        if (profile.status !== 200) throw new Error('profile unavailable');
        bindProfile(profile.data, session);
        if (sessions.get(sessionId) !== session) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
        sessions.delete(sessionId); sessionId = id(); sessions.set(sessionId, session);
        return { status: 200, data, cookie: cookie(sessionId) };
      } catch (error) {
        sessions.delete(sessionId);
        return reject(502, error.message === 'phone required' ? 'LK1_LOCAL_PHONE_REQUIRED' : 'LK1_LOCAL_AUTH_UNAVAILABLE');
      } finally { session.busy = false; }
    }
    if (route === 'auth.code') {
      if (!own(payload, ['phone', 'channel']) || !phoneOk(payload.phone) || payload.channel !== 'cascade') return reject(403);
      if (session?.subject || session?.busy) return reject(409, 'LK1_LOCAL_LOGOUT_OR_WAIT');
      if (!limit('sms:global', 10, 3600000) || !limit(`sms:${payload.phone}`, 1, 90000)) return reject(429, 'LK1_LOCAL_RATE_LIMIT');
      if (!session) {
        if (sessions.size >= 32) return reject(429, 'LK1_LOCAL_RATE_LIMIT');
        sessionId = id(); session = { until: now() + 600000, displaySubject: id() }; sessions.set(sessionId, session);
      }
      delete session.oauth;
      session.busy = true; session.phone = payload.phone; session.challengeUntil = 0; session.attempts = 0;
      const responseCookie = cookie(sessionId);
      try {
        counters.authRequests += 1;
        const query = new URLSearchParams({ phoneNumber: session.phone, channel: 'cascade', tenantKey: TENANT });
        const result = await remote({ url: `${KC}/sms/authentication-code?${query}`, method: 'GET', sms: true });
        if (sessions.get(sessionId) !== session) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
        if (result.status < 200 || result.status >= 300) return { ...reject(502, 'LK1_LOCAL_SMS_FAILED'), cookie: responseCookie };
        session.challengeUntil = now() + 600000;
        return { status: 200, data: { ok: true }, cookie: responseCookie };
      } finally { session.busy = false; }
    }
    if (route === 'auth.token' || route === 'auth.refresh') {
      if (!session || session.busy) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
      if (!limit(`auth:${sessionId}`, 10, 60000)) return reject(429, 'LK1_LOCAL_RATE_LIMIT');
      let body;
      if (route === 'auth.token') {
        if (!own(payload, ['phone', 'code']) || !phoneOk(payload.phone) || typeof payload.code !== 'string' || !/^\d{4}$/.test(payload.code)
          || session.subject || session.phone !== payload.phone || session.challengeUntil <= now() || ++session.attempts > 5) return reject(403);
        body = { grant_type: 'password', phone_number: session.phone, code: payload.code, client_id: 'widget', tenant_key: TENANT };
      } else {
        if (!own(payload, ['refreshHandle']) || !session.subject || payload.refreshHandle !== session.displayRefresh
          || session.refreshUntil <= now()) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
        body = { grant_type: 'refresh_token', client_id: 'widget', refresh_token: session.refresh };
      }
      session.busy = true;
      try {
        counters.authRequests += 1;
        const result = await remote({ url: `${KC}/protocol/openid-connect/token`, method: 'POST', body: new URLSearchParams(body).toString() });
        if (result.status !== 200) {
          if (route === 'auth.refresh') sessions.delete(sessionId);
          return reject(401, 'LK1_LOCAL_AUTH_FAILED');
        }
        if (route === 'auth.token') session.until = now() + 28800000;
        const data = minted(result.data, session);
        counters.readRequests += 1;
        const profile = await remote({ ...readPlan('profile'), token: session.access });
        if (profile.status !== 200) throw new Error('profile unavailable');
        bindProfile(profile.data, session);
        if (sessions.get(sessionId) !== session) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
        if (route === 'auth.token') {
          // Rotate the anonymous cookie; never expose real provider credentials.
          sessions.delete(sessionId); sessionId = id(); sessions.set(sessionId, session); session.challengeUntil = 0;
        }
        return { status: 200, data, cookie: cookie(sessionId) };
      } catch {
        sessions.delete(sessionId); return reject(502, 'LK1_LOCAL_AUTH_UNAVAILABLE');
      } finally { session.busy = false; }
    }
    const plan = readPlan(route, payload);
    if (!plan) return reject(403);
    if (!session?.subject || !session.profileId || session.accessUntil <= now() || (token !== session.displayAccess
      && !(token === session.previousDisplay && session.previousUntil > now()))) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
    if (!limit(`read:${sessionId}`, 240, 60000)) return reject(429, 'LK1_LOCAL_RATE_LIMIT');
    counters.readRequests += 1;
    const result = await remote({ ...plan, token: session.access });
    if (sessions.get(sessionId) !== session) return reject(401, 'LK1_LOCAL_SESSION_REQUIRED');
    if (result.status === 401 || result.status === 403) { sessions.delete(sessionId); return reject(401, 'LK1_LOCAL_SESSION_REQUIRED'); }
    if (result.status !== 200) return reject(502, 'LK1_LOCAL_READ_FAILED');
    if (route === 'profile') {
      try { bindProfile(result.data, session); }
      catch { sessions.delete(sessionId); return reject(401, 'LK1_LOCAL_PROFILE_MISMATCH'); }
    }
    return result;
  }

  async function handle(req, res) {
    const respond = result => {
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...(result.cookie ? { 'Set-Cookie': result.cookie } : {}) });
      res.end(JSON.stringify(result.data));
    };
    if (req.method !== 'POST' || req.headers.host !== '127.0.0.1:5180' || req.headers.origin !== LOCAL_ORIGIN
      || req.headers['x-lk1-preview'] !== 'readonly-v1' || req.headers['sec-fetch-site'] === 'cross-site'
      || req.headers['content-type'] !== 'application/json' || req.headers['transfer-encoding']
      || !/^\d+$/.test(req.headers['content-length'] || '') || Number(req.headers['content-length']) > 16384) return respond(reject(403));
    const controller = setTimeout(() => req.destroy(), 5000);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16384) return respond(reject(413)); chunks.push(chunk); }
      clearTimeout(controller);
      const match = String(req.headers.cookie || '').match(/(?:^|;\s*)lk1_preview_session=([A-Za-z0-9_-]{43})(?:;|$)/);
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')), match?.[1]);
      respond(result);
    } catch { if (!res.headersSent && !res.destroyed) respond(reject(502, 'LK1_LOCAL_UPSTREAM_UNAVAILABLE')); }
    finally { clearTimeout(controller); }
  }
  function serveOAuthPage(req, res) {
    if (req.method !== 'GET' || req.headers.host !== '127.0.0.1:5180') return false;
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return false;
    const url = new URL(req.url, LOCAL_ORIGIN);
    const asset = url.pathname === '/__lk1_local/oauth.js' && !url.search;
    // A cross-site GET may only receive this static callback document. It neither
    // reads a session nor exchanges a code. The clean document then makes a
    // same-origin guarded POST carrying the Strict cookie and verified state.
    const callback = url.pathname === '/lk_new' && url.searchParams.get('authMode') === 'viva'
      && req.headers['sec-fetch-dest'] === 'document' && req.headers['sec-fetch-mode'] === 'navigate'
      && (url.searchParams.has('code') !== url.searchParams.has('error')) && req.url.length <= 4096
      && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') || '')
      && [...url.searchParams.keys()].every(key => ['authMode', 'code', 'state', 'iss', 'session_state', 'error', 'error_description'].includes(key)
        && url.searchParams.getAll(key).length === 1);
    if (!asset && !callback) return false;
    if (asset && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== LOCAL_ORIGIN))) return false;
    res.writeHead(200, { 'Content-Type': asset ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(asset ? oauthScript
      : '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Вход в локальный LK1</title><body><p id="lk1-oauth-status" role="status">Завершаем вход через Яндекс…</p><a href="/">Вернуться в локальный ЛК</a><script src="/__lk1_local/oauth.js"></script></body></html>');
    return true;
  }
  return { handle, dispatch, serveOAuthPage, status: () => ({ mode: 'production-readonly', ...counters }) };
}
