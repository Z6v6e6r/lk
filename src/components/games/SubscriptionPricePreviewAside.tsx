import type { SubscriptionPricePreview } from "./subscriptionPricePreview";

export function SubscriptionPricePreviewAside({ ordinaryPrice, ordinaryPriceMinor, preview, showPreview, showInfoBadge }: {
  ordinaryPrice: string;
  ordinaryPriceMinor: number;
  preview: SubscriptionPricePreview;
  showPreview: boolean;
  showInfoBadge: boolean;
}) {
  const confirmed = showPreview && preview.state === "available";
  const discounted = confirmed && preview.amountMinor !== null
    && Number.isSafeInteger(ordinaryPriceMinor) && preview.amountMinor < ordinaryPriceMinor;
  return (
    <span className="game-payment-choice-aside game-payment-choice-aside--price-preview">
      <strong className={`game-payment-choice-price${discounted ? " game-payment-choice-price--discounted" : ""}`}>
        {ordinaryPrice}
      </strong>
      {showPreview && (
        <span className="game-subscription-price-preview" role="status" aria-live="polite" aria-atomic="true">
          <span className={confirmed ? "game-payment-choice-badge" : "game-subscription-price-preview-status"}>
            {preview.label}
          </span>
          {preview.detail && <span className="game-subscription-price-preview-detail">{preview.detail}</span>}
        </span>
      )}
      {showInfoBadge && (
        <span className="game-payment-choice-badge game-payment-choice-badge--outline" data-subscription-info-trigger="true">
          Подписка
        </span>
      )}
    </span>
  );
}
