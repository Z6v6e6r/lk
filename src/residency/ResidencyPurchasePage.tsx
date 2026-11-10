import { useEffect, useState } from 'react';
import { resumeCheckout, startCheckout } from '../components/subscription-storefront/zeroCheckoutMount';
import { RESIDENCY_OFFER_KEY } from './residencyPurchase';
import '../components/subscription-storefront/storefront-auth-overlay.css';
import './residency-purchase.css';

/** The card click is the confirmation; page loads and bank returns only resume recovery. */
export function ResidencyPurchasePage() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { resumeCheckout(RESIDENCY_OFFER_KEY); }, []);
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
      <button className="ph-residency-cta" type="button" data-ph-buy={RESIDENCY_OFFER_KEY} onClick={event => {
        setError(null);
        try { startCheckout(RESIDENCY_OFFER_KEY, 79000, event.nativeEvent); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось открыть оформление.'); }
      }}>Стать резидентом</button>
    </article>
    {error && <p role="alert">{error}</p>}
  </main>;
}
