import { createRoot, type Root } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { AuthProvider } from '../../context/AuthContext';
import { ZeroCheckoutDialog } from './ZeroCheckoutDialog';
import { hasZeroAttempt, resolveZeroOffer, ZERO_CHECKOUT_RETURN } from './zeroCheckoutPayment';

const SELECTION_KEY = 'padlhub_zero_checkout_selection_v1';
let checkoutRoot: Root | null = null;
let host: HTMLDivElement | null = null;
let busy = false;

class CheckoutBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="ph-zero-fatal" role="alert">
    Не удалось открыть оформление. Обновите страницу. Если покупка уже отправлена, проверьте личный кабинет перед новой попыткой.
    <button type="button" onClick={() => { closeCheckout(); }}>Закрыть</button>
  </div> : this.props.children; }
}

function setBusy(value: boolean) { busy = value; }

/** Refuse teardown during a payment call; it cannot be safely cancelled/repeated. */
export function closeCheckout(): boolean {
  if (busy) return false;
  checkoutRoot?.unmount(); checkoutRoot = null;
  host?.remove(); host = null;
  try { window.sessionStorage.removeItem(SELECTION_KEY); } catch { /* UI resume only. */ }
  return true;
}

/** Opens a single checkout, never creates a payment, and never selects from arbitrary product IDs. */
export function openCheckout(offerKey: string): boolean {
  if (!resolveZeroOffer(offerKey)) throw new Error('Неизвестное предложение PadlHub');
  if (checkoutRoot) { host?.querySelector<HTMLDialogElement>('dialog')?.focus(); return false; }
  if (typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype.showModal) throw new Error('Для оформления нужен актуальный Safari или Chrome');
  // Preserve only the selected public offer across an optional OAuth round trip.
  try { window.sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ key: offerKey, at: Date.now() })); } catch { /* SMS can still work. */ }
  host = document.createElement('div');
  host.className = 'ph-zero-checkout-host';
  document.body.appendChild(host);
  checkoutRoot = createRoot(host);
  checkoutRoot.render(<CheckoutBoundary><AuthProvider><ZeroCheckoutDialog offerKey={offerKey} onClose={closeCheckout} onBusy={setBusy} /></AuthProvider></CheckoutBoundary>);
  return true;
}

/** Bank/OAuth return may reopen UI; it must never call a purchase API. */
export function resumeCheckout(): boolean {
  const keys = new URLSearchParams(window.location.search).getAll(ZERO_CHECKOUT_RETURN);
  if (keys.length) {
    const key = keys[0];
    return keys.length === 1 && Boolean(resolveZeroOffer(key)) && hasZeroAttempt(key) ? openCheckout(key) : false;
  }
  try {
    const selected = JSON.parse(window.sessionStorage.getItem(SELECTION_KEY) || 'null');
    if (selected && typeof selected.key === 'string' && resolveZeroOffer(selected.key)
      && typeof selected.at === 'number' && Date.now() - selected.at >= 0 && Date.now() - selected.at < 30 * 60_000) return openCheckout(selected.key);
  } catch { /* Invalid UI state does not start checkout. */ }
  return false;
}
