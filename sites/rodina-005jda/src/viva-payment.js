/* global document */
import { assertTenant, assertBinding, TARGET_TENANT } from './tenant-config.js';
import { now, selectionValid, quoteFor } from './viva-booking.js';
const API = 'https://api.vivacrm.ru';
const AUTH = 'https://kc.vivacrm.ru/realms/clients';
const OAUTH_KEY = 'rodina-005JDA-oauth-pkce-v1';
const OAUTH_PROVIDERS = { vkid: 'VK', yandex: 'Яндекс' };
const memory = new Map();
const attempts = new Map();
let refreshing = null;
const cooldown = new Map();
const deliveryChannels = new Map();
const channelNames = { SMS_VIVA: 'SMS Viva', SMS: 'SMS', EMAIL: 'Email', WEBHOOK: 'резервный канал', TELEGRAM: 'Telegram', TELEGRAM_GATEWAY: 'Telegram', WHATS_APP: 'WhatsApp', PUSH: 'push', FLASHCALL: 'входящий звонок' };

function storedToken(name) {
  // Browser same-origin rules apply: cookies from ffc.team are never accessible here.
  const cookie = typeof document === 'undefined' ? null : document.cookie.split('; ').find(row => row.startsWith(name + '='));
  if (cookie) { try { return decodeURIComponent(cookie.slice(name.length + 1)); } catch { /* Optional browser storage may be unavailable or contain invalid data. */ } }
  for (const storeName of ['sessionStorage', 'localStorage']) {
    try {
      const store = globalThis[storeName];
      const raw = store?.getItem(name);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw);
        if (typeof record === 'string') return record;
        if (typeof record?.value === 'string' && (!record.expiresAt || record.expiresAt > now())) return record.value;
      } catch { return raw; }
    } catch { /* Optional browser storage may be unavailable or contain invalid data. */ }
  }
  const record = memory.get(name);
  return record && record.expiresAt > now() ? record.value : null;
}
function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return Number(JSON.parse(atob(payload)).exp) * 1000;
  } catch { return 0; }
}
function saveTokens(tenant, response) {
  assertTenant(tenant);
  if (typeof response?.access_token !== 'string' || !response.access_token) throw new Error('Viva не вернула токен входа.');
  for (const [suffix, value, seconds] of [['AuthToken', response.access_token, response.expires_in], ['RefreshToken', response.refresh_token, response.refresh_expires_in]]) {
    if (typeof value !== 'string' || !value) continue;
    const record = { value, expiresAt: now() + (Number(seconds) || 300) * 1000 };
    memory.set(tenant + suffix, record);
    if (typeof document !== 'undefined') document.cookie = `${tenant + suffix}=${encodeURIComponent(value)};Path=/;Max-Age=${Math.max(1, Math.floor(Number(seconds) || 300))};SameSite=Lax${globalThis.location?.protocol === 'https:' ? ';Secure' : ''}`;
    try { globalThis.sessionStorage?.setItem(tenant + suffix, JSON.stringify(record)); } catch { /* Optional browser storage may be unavailable or contain invalid data. */ }
  }
}
function randomBase64Url() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export async function startOAuthLogin(tenant, provider, arenaId, selection) {
  assertTenant(tenant);
  if (!Object.hasOwn(OAUTH_PROVIDERS, provider)) throw new Error('Неизвестный способ входа.');
  if (!globalThis.crypto?.subtle || !globalThis.sessionStorage || !globalThis.location?.origin) throw new Error('В этом браузере вход через VK и Яндекс недоступен. Войдите по телефону.');
  const state = randomBase64Url(), verifier = randomBase64Url();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const redirectUri = globalThis.location.origin + globalThis.location.pathname;
  try {
    globalThis.sessionStorage.setItem(OAUTH_KEY, JSON.stringify({ state, verifier, tenant, arenaId, selection, redirectUri, createdAt: Date.now() }));
  } catch { throw new Error('Браузер не сохранил начало входа. Разрешите хранение данных сайта или войдите по телефону.'); }
  const url = new URL(AUTH + '/protocol/openid-connect/auth');
  for (const [key, value] of Object.entries({ client_id: 'widget', redirect_uri: redirectUri, response_type: 'code', scope: 'openid', kc_idp_hint: provider, tenant_key: tenant, state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
  globalThis.location.assign(url.href);
}
export async function finishOAuthRedirect() {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return null;
  const code = url.searchParams.get('code'), state = url.searchParams.get('state'), error = url.searchParams.get('error');
  for (const key of ['code', 'state', 'session_state', 'error', 'error_description', 'iss']) url.searchParams.delete(key);
  globalThis.history.replaceState(globalThis.history.state, '', url.pathname + url.search + url.hash);
  let pending;
  try { pending = JSON.parse(globalThis.sessionStorage?.getItem(OAUTH_KEY) || 'null'); } catch { /* Optional browser storage may be unavailable or contain invalid data. */ }
  if (!pending || pending.tenant !== TARGET_TENANT || !state || state !== pending.state) return { error: 'Не удалось подтвердить вход. Выберите площадку и попробуйте ещё раз в той же вкладке.' };
  globalThis.sessionStorage.removeItem(OAUTH_KEY);
  const result = { arenaId: pending.arenaId, ...(pending.selection ? { selection: pending.selection } : {}) };
  if (!Number.isFinite(pending.createdAt) || pending.redirectUri !== globalThis.location.origin + globalThis.location.pathname || Date.now() - pending.createdAt > 10 * 60 * 1000 || pending.createdAt > Date.now() + 60 * 1000) return { ...result, error: 'Время входа истекло. Попробуйте ещё раз.' };
  if (error) return { ...result, error: error === 'access_denied' ? 'Вход отменён. Выберите способ входа ещё раз.' : 'Viva не завершила вход. Попробуйте ещё раз.' };
  if (!code) return { ...result, error: 'Viva не вернула код входа. Попробуйте ещё раз.' };
  try {
    const response = await tokenRequest(pending.tenant, { grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
    saveTokens(pending.tenant, response);
    return result;
  } catch (issue) {
    return { ...result, error: issue.status === 400 || issue.status === 401 ? 'Не удалось подтвердить вход. Попробуйте войти ещё раз.' : issue.message || 'Не удалось связаться с Viva.' };
  }
}
export class VivaHttpError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}
async function fetchJson(url, options = {}, signal, metadata = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 20000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    metadata.status = response.status;
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 2000) }; }
    if (!response.ok) throw new VivaHttpError(response.status === 401 ? 'Войдите в Viva заново.' : response.status === 429 ? 'Слишком много запросов. Попробуйте позже.' : 'Viva отклонила запрос.', response.status, body);
    return body;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('Viva отвечает слишком долго.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function tokenRequest(tenant, fields, signal) {
  assertTenant(tenant);
  return fetchJson(AUTH + '/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tenant_key: tenant, client_id: 'widget', ...fields }).toString()
  }, signal);
}
export async function accessToken(tenant, signal) {
  assertTenant(tenant);
  const token = storedToken(tenant + 'AuthToken');
  if (token && tokenExpiry(token) > now() + 30000) return token;
  const refresh = storedToken(tenant + 'RefreshToken');
  if (refresh) {
    if (!refreshing) refreshing = tokenRequest(tenant, { grant_type: 'refresh_token', refresh_token: refresh }, signal)
      .then(response => { saveTokens(tenant, response); return response.access_token; }).finally(() => { refreshing = null; });
    try { return await refreshing; } catch (error) { if (error.status !== 400 && error.status !== 401) throw error; }
  }
  const error = new Error('Для получения ссылки на оплату войдите в Viva по телефону.');
  error.code = 'AUTH_REQUIRED'; throw error;
}
export function normalizePhone(value) {
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 10) digits = '7' + digits;
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
  if (!/^7\d{10}$/.test(digits)) throw new Error('Введите российский номер телефона полностью.');
  return '+' + digits;
}
export async function loginDeliveryChannels(tenant, signal) {
  assertTenant(tenant);
  if (deliveryChannels.has(tenant)) return deliveryChannels.get(tenant);
  const response = await fetchJson(`${API}/end-user/api/v1/${encodeURIComponent(tenant)}/notifications/cascades/otp`, {}, signal);
  const channels = Object.values(response || {}).filter(value => Object.hasOwn(channelNames, value));
  if (channels.length) deliveryChannels.set(tenant, channels);
  return channels;
}
export function loginChannelLabel(channel) { return channelNames[channel] || 'канал Viva'; }
export async function requestLoginCode(tenant, phoneValue, signal, channel = 'cascade') {
  assertTenant(tenant);
  if (!['cascade', 'sms'].includes(channel)) throw new Error('Недоступный канал отправки кода.');
  const phone = normalizePhone(phoneValue), key = tenant + phone;
  if ((cooldown.get(key) || 0) > now()) throw new Error(`Повторный код можно запросить через ${Math.ceil((cooldown.get(key) - now()) / 1000)} сек.`);
  let channels = channel === 'sms' ? ['SMS'] : [];
  if (channel === 'cascade') {
    try { channels = await loginDeliveryChannels(tenant, signal); }
    catch (error) { if (signal?.aborted) throw error; }
  }
  // react-phone-input-2 in the original widget sends digits, without a leading +.
  const query = new URLSearchParams({ phoneNumber: phone.slice(1), channel, tenantKey: tenant });
  const metadata = {};
  const response = await fetchJson(AUTH + '/sms/authentication-code?' + query, { headers: { Accept: 'application/json' } }, signal, metadata);
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error || response.success === false) throw new VivaHttpError('Viva не подтвердила отправку кода.', metadata.status, response);
  const sentAt = now(), retryAt = sentAt + 60000 * Math.max(1, channels.length);
  cooldown.set(key, retryAt);
  return { phone, channel, channels, httpStatus: metadata.status, sentAt, retryAt };
}
export async function verifyLoginCode(tenant, phone, code, signal) {
  assertTenant(tenant);
  if (!/^\d{4,8}$/.test(String(code).trim())) throw new Error('Введите код из сообщения.');
  const response = await tokenRequest(tenant, { grant_type: 'password', phone_number: normalizePhone(phone).slice(1), code: String(code).trim() }, signal);
  saveTokens(tenant, response);
}
export function paymentPayload(binding, interval, preview = false) {
  assertBinding(binding);
  return {
    subServiceIds: [binding.subServiceId], studioId: binding.studioId, roomId: binding.roomId,
    ...(preview ? { promoCode: null } : {}),
    trainers: { type: 'NO_TRAINER' }, paymentMethod: 'WIDGET', baseRedirectUrl: '', comment: null,
    marketingAttribution: preview ? {} : { utmSource: 'site_station', utmMedium: 'site' },
    deposit: 0, bonus: '0.00', timeFrom: interval.timeFrom, timeTo: interval.timeTo
  };
}
export function attemptKey(binding, interval) {
  assertBinding(binding);
  return ['viva-pay-v1', binding.tenantKey, binding.masterServiceId, binding.studioId, binding.roomId, binding.subServiceId, interval.timeFrom, interval.timeTo].join('|');
}
function remember(key, attempt) {
  attempts.set(key, attempt);
  // Persist the request ID/uncertain outcome across reloads, never the auth header.
  try { globalThis.sessionStorage?.setItem(key, JSON.stringify(attempt)); } catch { /* Optional browser storage may be unavailable or contain invalid data. */ }
}
export function previousAttempt(binding, interval) {
  const key = attemptKey(binding, interval);
  if (attempts.has(key)) return attempts.get(key);
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (raw) { const record = JSON.parse(raw); attempts.set(key, record); return record; }
  } catch { /* Optional browser storage may be unavailable or contain invalid data. */ }
  return null;
}
function forget(key) { attempts.delete(key); try { globalThis.sessionStorage?.removeItem(key); } catch { /* Optional browser storage may be unavailable or contain invalid data. */ } }
export function paymentLink(body) {
  const value = body?.paymentUrl || body?.result?.paymentUrl || body?.events?.find(event => event.action === 'TRANSACTION_CREATED' && event.data?.paymentUrl)?.data?.paymentUrl;
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
export async function createPayment(binding, interval, minutes, signal, onProgress = () => {}) {
  assertBinding(binding);
  const key = attemptKey(binding, interval), previous = previousAttempt(binding, interval);
  if (previous) return previous; // Never replay a non-idempotent POST after an uncertain result.
  if (!selectionValid(interval, minutes, binding)) throw new Error('Выбранное время устарело или выходит за пределы двух недель.');
  const attempt = { phase: 'checking', response: null, preview: null, operation: null, id: null };
  remember(key, attempt);
  let paySent = false;
  try {
    const token = await accessToken(binding.tenantKey, signal);
    const checked = await quoteFor(binding, interval, minutes, signal);
    if (typeof interval.amount === 'number' && Math.abs(checked.amount - interval.amount) > .005) throw new Error('Стоимость изменилась. Закройте окно и обновите расчёт перед оплатой.');
    const base = `${API}/end-user/api/v2/${encodeURIComponent(binding.tenantKey)}/products/master-services/${encodeURIComponent(binding.masterServiceId)}/pay`;
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    attempt.preview = await fetchJson(base + '/preview', { method: 'POST', headers, body: JSON.stringify(paymentPayload(binding, interval, true)) }, signal);
    if (!selectionValid(interval, minutes, binding)) throw new Error('Выбранное время уже недоступно по дате.');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress({ phase: 'sending' });
    attempt.phase = 'sending'; remember(key, attempt); paySent = true;
    attempt.response = await fetchJson(base, { method: 'POST', headers, body: JSON.stringify(paymentPayload(binding, interval)) }, signal);
    attempt.id = attempt.response?.id || attempt.response?.correlationId || null;
    attempt.phase = 'received'; remember(key, attempt);
    return attempt;
  } catch (error) {
    if (!paySent || (error instanceof VivaHttpError && error.status >= 400 && error.status < 500 && error.status !== 408)) { forget(key); throw error; }
    attempt.phase = 'unknown';
    if (error instanceof VivaHttpError) attempt.response = { httpStatus: error.status, error: error.body };
    remember(key, attempt);
    error.code = 'PAYMENT_UNKNOWN'; throw error;
  }
}
export async function operationStatus(binding, interval, signal) {
  assertBinding(binding);
  const key = attemptKey(binding, interval), attempt = previousAttempt(binding, interval);
  if (!attempt?.id) throw new Error('Viva не вернула ID операции. Повторный платёж автоматически не создаётся.');
  const token = await accessToken(binding.tenantKey, signal);
  attempt.operation = await fetchJson(`${API}/end-user/api/v2/${encodeURIComponent(binding.tenantKey)}/operations/${encodeURIComponent(attempt.id)}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }
  }, signal);
  remember(key, attempt);
  return attempt;
}
export function safeResponse(value) {
  return JSON.stringify(value, (key, item) => /^(authorization|token|(?:access|refresh|id)[_-]?token|password|code)$/i.test(key) ? '[скрыто]' : item, 2);
}
