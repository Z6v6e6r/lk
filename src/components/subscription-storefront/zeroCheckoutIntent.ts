import { isFastOffer, isCheckoutReturn } from './zeroCheckoutOffers.ts';
export { isFastOffer } from './zeroCheckoutOffers.ts';
import { armOAuthContinuation, clearOAuthContinuation, continuationIdValid, continuationPath, takeOAuthContinuation } from '../../utils/oauthContinuation.ts';
import type { ZeroOfferQuote } from './zeroCheckoutPayment';

const KEY = 'padlhub_zero_checkout_intent_v1';
const TTL = 10 * 60_000;
export type FastIntent = { id: string; key: string; priceMinor: number; activationDays?: number | null; createdAt: number; expiresAt: number; returnPath: string; phase: 'created' | 'armed' | 'claimed'; resume?: boolean };
function write(value: FastIntent) {
  const raw = JSON.stringify(value); window.sessionStorage.setItem(KEY, raw);
  if (window.sessionStorage.getItem(KEY) !== raw) throw new Error('Для оформления разрешите хранение данных сайта.');
}
export function readFastIntent(id?: string): FastIntent | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) || 'null') as FastIntent | null;
    if (!v || !continuationIdValid(v.id) || id && v.id !== id || !isFastOffer(v.key)
      || !Number.isSafeInteger(v.priceMinor) || v.priceMinor < (v.resume ? 0 : 1) || !Number.isSafeInteger(v.createdAt)
      || v.expiresAt !== v.createdAt + TTL || Date.now() < v.createdAt || Date.now() >= v.expiresAt
      || v.resume !== undefined && typeof v.resume !== 'boolean'
      || v.returnPath !== continuationPath() || !['created', 'armed', 'claimed'].includes(v.phase)
      || v.phase !== 'created' && (v.activationDays !== null && (!Number.isSafeInteger(v.activationDays) || Number(v.activationDays) < 0))) return null;
    return v;
  } catch { return null; }
}
export function cancelFastIntent(id?: string) {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) || 'null');
    if (v && (!id || v.id === id)) { clearOAuthContinuation(v.id); window.sessionStorage.removeItem(KEY); }
  } catch { /* Unknown state never authorizes a purchase. */ }
}
/** URL/hash/UI resume cannot manufacture a trusted buy gesture. */
export function createFastIntent(key: string, priceMinor: number, event: Event, resume = false): FastIntent {
  const age = (event.timeStamp > 1e12 ? Date.now() : performance.now()) - event.timeStamp;
  if (!isFastOffer(key) || !Number.isSafeInteger(priceMinor) || priceMinor < (resume ? 0 : 1) || !(event instanceof window.Event)
    || !event.isTrusted || !['click', 'keydown'].includes(event.type) || age < 0 || age > 15_000
    || event.type === 'keydown' && !['Enter', ' '].includes((event as KeyboardEvent).key)
    || !(event.target instanceof window.Element) || !event.target.isConnected
    || !event.target.closest('.ph-buy-' + key + ',[data-ph-buy="' + key + '"]')
    || isCheckoutReturn()) throw new Error('Нажмите кнопку выбранной подписки ещё раз.');
  cancelFastIntent();
  const now = Date.now();
  const value: FastIntent = { id: window.crypto.randomUUID(), key, priceMinor, createdAt: now, expiresAt: now + TTL, returnPath: continuationPath(), phase: 'created', ...(resume ? { resume: true } : {}) };
  write(value); return value;
}
export function bindFastQuote(id: string, quote: ZeroOfferQuote): FastIntent {
  const value = readFastIntent(id);
  if (!value || value.resume || value.phase === 'claimed') throw new Error('Время оформления истекло. Нажмите кнопку покупки заново.');
  if (value.priceMinor !== quote.priceMinor || value.phase === 'armed' && value.activationDays !== (quote.activationDays ?? null)) {
    throw new Error('Цена или условия изменились. Подтвердите обновлённое предложение.');
  }
  if ((value.key === 'residency' || value.key === 'friendship-two-hours' || quote.activationDays !== undefined) && !Number.isSafeInteger(quote.activationDays)) throw new Error('Условия подписки не подтверждены.');
  if (value.phase === 'created') {
    const armed: FastIntent = { ...value, activationDays: quote.activationDays ?? null, phase: 'armed' };
    write(armed); armOAuthContinuation({ kind: 'zero-checkout', id, createdAt: armed.createdAt, expiresAt: armed.expiresAt, returnPath: armed.returnPath });
    return armed;
  }
  return value;
}
export function claimFastIntent(id: string, quote: ZeroOfferQuote): boolean {
  const value = readFastIntent(id);
  if (!value || value.resume || value.phase !== 'armed' || value.priceMinor !== quote.priceMinor || value.activationDays !== (quote.activationDays ?? null)
    || isCheckoutReturn()) return false;
  write({ ...value, phase: 'claimed' }); clearOAuthContinuation(id); return true;
}
export function takeFastOAuthIntent(key: string): (FastIntent & { sessionBinding: string }) | null {
  const value = readFastIntent();
  if (!value || value.key !== key || value.phase !== 'armed' || isCheckoutReturn()) return null;
  const sessionBinding = takeOAuthContinuation(value.id);
  return sessionBinding ? { ...value, sessionBinding } : null;
}

/** Arm/claim an existing purchase continuation without a new inventory/price quote. */
export function armFastResume(id: string): boolean {
  const value = readFastIntent(id);
  if (!value?.resume || value.phase === 'claimed' || isCheckoutReturn()) return false;
  if (value.phase === 'created') {
    write({ ...value, phase: 'armed', activationDays: null });
    armOAuthContinuation({ kind: 'zero-checkout', id, createdAt: value.createdAt, expiresAt: value.expiresAt, returnPath: value.returnPath });
  }
  return true;
}
export function claimFastResume(id: string): boolean {
  const value = readFastIntent(id);
  if (!value?.resume || value.phase !== 'armed' || isCheckoutReturn()) return false;
  write({ ...value, phase: 'claimed' }); clearOAuthContinuation(id); return true;
}

/** Same trusted card click can replace a server-closed checkout at the exact displayed price. */
export function claimFastRestart(id: string, quote: ZeroOfferQuote): boolean {
  const value = readFastIntent(id);
  if (!value?.resume || !['friendship', 'friendship-two-hours'].includes(value.key) || value.phase !== 'claimed'
    || value.key === 'friendship-two-hours' && quote.activationDays !== 1
    || value.priceMinor <= 0 || quote.priceMinor !== value.priceMinor || isCheckoutReturn()) return false;
  write({ ...value, resume: false, activationDays: quote.activationDays ?? null });
  return true;
}
