import type { SubscriptionPricePreview } from "./subscriptionPricePreview";

export function SubscriptionOptionPrice({ preview, shareLabel }: {
  preview: SubscriptionPricePreview | undefined;
  shareLabel: string;
}) {
  const confirmed = preview?.state === "available" && preview.amountMinor !== null;
  const amount = confirmed ? new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 2})
    .format(preview.amountMinor! / 100) : null;
  return (
    <span role="status" aria-live="polite">
      {confirmed ? `Участие в ${shareLabel} игры · ${amount} ₽` : preview?.label || "Стоимость не подтверждена"}
      {confirmed && preview.detail && <><br />{preview.detail}</>}
    </span>
  );
}
