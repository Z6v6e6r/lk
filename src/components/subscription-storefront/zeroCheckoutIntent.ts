import { isFastOffer, isCheckoutReturn } from './zeroCheckoutOffers.ts';
export { isFastOffer } from './zeroCheckoutOffers.ts';
import { armOAuthContinuation, clearOAuthContinuation, continuationIdValid, continuationPath, takeOAuthContinuation } from '../../utils/oauthContinuation.ts';
import type { ZeroOfferQuote } from './zeroCheckoutPayment';

const KEY = 'padlhub_zero_checkout_intent_v1';
const TTL = 10 * 60_000;
export type FastIntent = { id: string; key: string; priceMinor: number; activationDays?: number | null; createdAt: number; expiresAt: number; returnPath: string; phase: 'created' | 'armed' | 'claimed' };
function write(value: FastIntent) {
  const raw = JSON.stringify(value); window.sessionStorage.setItem(KEY, raw);
  if (window.sessionStorage.getItem(KEY) !== raw) throw new Error('Для оформления разрешите хранение данных сайта.');
}
export function readFastIntent(id?: string): FastIntent | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(KEY) || 'null') as FastIntent | null;
    if (!v || !continuationIdValid(v.id) || id && v.id !== id || !isFastOffer(v.key)
      || !Number.isSafeInteger(v.priceMinor) || v.priceMinor <= 0 || !Number.isSafeInteger(v.createdAt)
      || v.expiresAt !== v.createdAt + TTL || Date.now() < v.createdAt || Date.now() >= v.expiresAt
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
export function createFastIntent(key: string, priceMinor: number, event: Event): FastIntent {
  const age = (event.timeStamp > 1e12 ? Date.now() : performance.now()) - event.timeStamp;
  if (!isFastOffer(key) || !Number.isSafeInteger(priceMinor) || priceMinor <= 0 || !(event instanceof window.Event)
    || !event.isTrusted || !['click', 'keydown'].includes(event.type) || age < 0 || age > 15_000
    || event.type === 'keydown' && !['Enter', ' '].includes((event as KeyboardEvent).key)
    || !(event.target instanceof window.Element) || !event.target.isConnected
    || !event.target.closest('.ph-buy-' + key + ',[data-ph-buy="' + key + '"]')
    || isCheckoutReturn()) throw new Error('Нажмите кнопку выбранной подписки ещё раз.');
  cancelFastIntent();
  const now = Date.now();
  const value: FastIntent = { id: window.crypto.randomUUID(), key, priceMinor, createdAt: now, expiresAt: now + TTL, returnPath: continuationPath(), phase: 'created' };
  write(value); return value;
}
export function bindFastQuote(id: string, quote: ZeroOfferQuote): FastIntent {
  const value = readFastIntent(id);
  if (!value || value.phase === 'claimed') throw new Error('Время оформления истекло. Нажмите кнопку покупки заново.');
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
  if (!value || value.phase !== 'armed' || value.priceMinor !== quote.priceMinor || value.activationDays !== (quote.activationDays ?? null)
    || isCheckoutReturn()) return false;
  write({ ...value, phase: 'claimed' }); clearOAuthContinuation(id); return true;
}
export function takeFastOAuthIntent(key: string): (FastIntent & { sessionBinding: string }) | null {
  const value = readFastIntent();
  if (!value || value.key !== key || value.phase !== 'armed' || isCheckoutReturn()) return null;
  const sessionBinding = takeOAuthContinuation(value.id);
  return sessionBinding ? { ...value, sessionBinding } : null;
}
