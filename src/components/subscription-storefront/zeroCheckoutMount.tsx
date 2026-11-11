import { isCheckoutReturn } from './zeroCheckoutOffers';
import { createRoot, type Root } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { CheckoutAuthProvider } from './CheckoutAuthProvider';
import { ZeroCheckoutDialog } from './ZeroCheckoutDialog';
import { checkoutSessionIdentity, type FastCheckoutSession } from './zeroCheckoutSession';
import { cancelFastIntent, createFastIntent, takeFastOAuthIntent } from './zeroCheckoutIntent';
import { hasZeroAttempt, hasRecordedZeroAttempt, resolveZeroOffer, ZERO_CHECKOUT_RETURN } from './zeroCheckoutPayment';

const SELECTION_KEY = 'padlhub_zero_checkout_selection_v1';
let checkoutRoot: Root | null = null;
let host: HTMLDivElement | null = null;
let busy = false;
let activeFastIntent: string | undefined;

class CheckoutBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="ph-zero-fatal" role="alert">
    Не удалось открыть оформление. Обновите страницу. Если покупка уже отправлена, проверьте личный кабинет перед новой попыткой.
    <button type="button" onClick={() => { closeCheckout(); }}>Закрыть</button>
  </div> : this.props.children; }
}

function setBusy(value: boolean) { busy = value; }
export function isCheckoutOpen(): boolean { return checkoutRoot !== null; }

/** Refuse teardown during a payment call; it cannot be safely cancelled/repeated. */
export function closeCheckout(): boolean {
  if (busy) return false;
  cancelFastIntent(activeFastIntent); activeFastIntent = undefined;
  checkoutRoot?.unmount(); checkoutRoot = null;
  host?.remove(); host = null;
  try { window.sessionStorage.removeItem(SELECTION_KEY); } catch { /* UI resume only. */ }
  return true;
}

/** Opens a single checkout, never creates a payment, and never selects from arbitrary product IDs. */
function mountCheckout(offerKey: string, fast?: FastCheckoutSession, resumeExisting = false): boolean {
  if (!resolveZeroOffer(offerKey)) throw new Error('Неизвестное предложение PadlHub');
  if (checkoutRoot) { host?.querySelector<HTMLDialogElement>('dialog')?.focus(); return false; }
  if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) throw new Error('Для оформления нужен актуальный Safari или Chrome');
  // Preserve only the selected public offer across an optional OAuth round trip.
  try { window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ key: offerKey, at: Date.now() })); } catch { /* SMS can still work. */ }
  activeFastIntent = fast?.id;
  host = document.createElement('div');
  host.className = 'ph-zero-checkout-host';
  document.body.appendChild(host);
  checkoutRoot = createRoot(host);
  checkoutRoot.render(<CheckoutBoundary><CheckoutAuthProvider intentId={fast?.id} initialIdentity={fast?.initialIdentity}><ZeroCheckoutDialog resumeExisting={resumeExisting} fast={fast} offerKey={offerKey} onClose={closeCheckout} onBusy={setBusy} /></CheckoutAuthProvider></CheckoutBoundary>);
  return true;
}

/** Legacy programmatic open/UI selection remains confirmation-only. */
export function openCheckout(offerKey: string): boolean { return mountCheckout(offerKey); }

/** A live trusted card gesture is the explicit purchase confirmation. */
export function startCheckout(offerKey: string, expectedPrice: number, event: Event): boolean {
  if (checkoutRoot) { host?.querySelector<HTMLDialogElement>('dialog')?.focus(); return false; }
  const offer = resolveZeroOffer(offerKey);
  if (!offer || !(offer.target || offer.promo || offer.liveProductId)) throw new Error('Предложение недоступно.');
  const intent = createFastIntent(offerKey, expectedPrice, event, hasZeroAttempt(offerKey));
  try { return mountCheckout(offerKey, { id: intent.id, initialIdentity: checkoutSessionIdentity(), resume: intent.resume }); }
  catch (error) { cancelFastIntent(intent.id); throw error; }
}

/** Only a matching one-time verified OAuth receipt can resume automatic payment. */
export function resumeCheckout(expectedOfferKey?: string): boolean {
  const keys = new URLSearchParams(window.location.search).getAll(ZERO_CHECKOUT_RETURN);
  if (keys.length) {
    cancelFastIntent();
    const key = keys[0];
    return keys.length === 1 && (!expectedOfferKey || key === expectedOfferKey)
      && Boolean(resolveZeroOffer(key)) && hasRecordedZeroAttempt(key) ? openCheckout(key) : false;
  }
  if (isCheckoutReturn()) { cancelFastIntent(); return false; }
  try {
    const selected = JSON.parse(window.sessionStorage.getItem(SELECTION_KEY) || 'null');
    if (selected && typeof selected.key === 'string' && (!expectedOfferKey || selected.key === expectedOfferKey)
      && resolveZeroOffer(selected.key)
      && typeof selected.at === 'number' && Date.now() - selected.at >= 0 && Date.now() - selected.at < 30 * 60_000) {
      const intent = takeFastOAuthIntent(selected.key);
      return intent
        ? mountCheckout(selected.key, { id: intent.id, initialIdentity: null, sessionBinding: intent.sessionBinding, resume: intent.resume }) : mountCheckout(selected.key, undefined, hasZeroAttempt(selected.key));
    }
  } catch { /* Invalid UI state does not start checkout. */ }
  return false;
}
