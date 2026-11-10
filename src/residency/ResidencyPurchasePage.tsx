import { useState } from 'react';
import { CheckoutAuthProvider } from '../components/subscription-storefront/CheckoutAuthProvider';
import { ZeroCheckoutDialog } from '../components/subscription-storefront/ZeroCheckoutDialog';
import { RESIDENCY_OFFER_KEY } from './residencyPurchase';
import './residency-purchase.css';

/** Opening or returning to this route only opens UI; payment needs confirmation. */
export function ResidencyPurchasePage() {
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('phCheckoutReturn') === RESIDENCY_OFFER_KEY);
  return <main className="ph-residency-purchase">
    <article className="ph-residency-card" aria-labelledby="ph-residency-title">
      <h1 id="ph-residency-title" className="ph-residency-badge">
        <span className="ph-residency-plus" aria-hidden="true">+</span>
        <span>Резидент</span>
      </h1>
      <p className="ph-residency-price"><strong>790 ₽</strong><span>/ 30 дней</span></p>
      <hr className="ph-residency-divider" />
      <ul className="ph-residency-benefits">
        <li><strong>30%</strong><span>Скидка на создание / участие в игре</span></li>
        <li><strong>50%</strong><span>Скидка на форматы: игра + тренер, групповые тренировки, лига «Время на друзей», турниры ПадлхАБ</span></li>
      </ul>
      <section className="ph-residency-equipment" aria-labelledby="ph-residency-equipment-title">
        <h2 id="ph-residency-equipment-title">На время игры:</h2>
        <ul>
          <li><span>Ракетка</span><span className="ph-residency-included"><span className="ph-residency-sr-only">Включено</span></span></li>
          <li><span>Полотенце</span><span className="ph-residency-included"><span className="ph-residency-sr-only">Включено</span></span></li>
        </ul>
      </section>
      <button className="ph-residency-cta" type="button" onClick={() => setOpen(true)}>Стать резидентом</button>
    </article>
    {open && <CheckoutAuthProvider><ZeroCheckoutDialog offerKey={RESIDENCY_OFFER_KEY}
      onClose={() => setOpen(false)} onBusy={() => {}} /></CheckoutAuthProvider>}
  </main>;
}
