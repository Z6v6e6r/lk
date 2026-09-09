import { useId } from "react";
import type { SubscriptionPricePreview } from "./subscriptionPricePreview";
import { SubscriptionOptionPrice } from "./SubscriptionOptionPrice";

export function JoinSubscriptionOptions({ options, preview, disabled, shareLabel, onJoin }: {
  options: { subscriptionId: string; name: string; balanceLabel: string }[];
  preview: SubscriptionPricePreview & { bySubscriptionId: Record<string, SubscriptionPricePreview>; refresh: () => void };
  disabled: boolean;
  shareLabel: string;
  onJoin: (subscriptionId: string) => void;
}) {
  const descriptionId = useId();
  return <div className="game-split-subscription-options">
    <div className="game-split-subscription-title">Выберите абонемент для участия</div>
    {options.map((option, index) => {
      const price = preview.bySubscriptionId[option.subscriptionId];
      return <button key={option.subscriptionId} className="game-split-subscription-option game-split-subscription-option--preview"
        type="button" aria-describedby={`${descriptionId}-${index}`} disabled={disabled || price?.state !== "available"}
        onClick={() => onJoin(option.subscriptionId)}>
        <span className="game-split-subscription-option-copy">
          <strong>{option.name}</strong>
          <span id={`${descriptionId}-${index}`}><SubscriptionOptionPrice preview={price} shareLabel={shareLabel} /></span>
        </span>
        <span className="game-split-subscription-option-validity">{option.balanceLabel}</span>
      </button>;
    })}
    <button type="button" className="game-summary-edit-button" onClick={preview.refresh}
      disabled={disabled || preview.state === "checking"}>Обновить стоимость по подпискам</button>
  </div>;
}
