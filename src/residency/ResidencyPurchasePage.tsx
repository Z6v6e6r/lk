import { useState } from 'react';
import { CheckoutAuthProvider } from '../components/subscription-storefront/CheckoutAuthProvider';
import { ZeroCheckoutDialog } from '../components/subscription-storefront/ZeroCheckoutDialog';
import { RESIDENCY_OFFER_KEY } from './residencyPurchase';
import './residency-purchase.css';

/** Opening or returning to this route only opens UI; payment needs confirmation. */
export function ResidencyPurchasePage() {
  const [open, setOpen] = useState(true);
  return <main className="ph-residency-purchase">
    <h1>Резидентство ПадлхАБ</h1>
    <p>Проверьте условия и войдите, чтобы продолжить оформление.</p>
    <button type="button" onClick={() => setOpen(true)}>Оформить резидентство</button>
    {open && <CheckoutAuthProvider><ZeroCheckoutDialog offerKey={RESIDENCY_OFFER_KEY}
      onClose={() => setOpen(false)} onBusy={() => {}} /></CheckoutAuthProvider>}
  </main>;
}
