import { useEffect, useId, useState } from "react";
import type { SubscriptionPricePreview } from "../components/games/subscriptionPricePreview";

export type BookingOption = {
  id: string;
  name: string;
  amountMinor: number | null;
  benefit?: string | null;
};

export function minorFromRubles(value: number | null | undefined, shares = 1): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100 / shares)
    : null;
}

export function fromGamePriceQuotes(previews: Record<string, SubscriptionPricePreview>): BookingOption[] {
  return Object.entries(previews)
    .filter(([, quote]) => quote.state === "available" && quote.amountMinor !== null)
    .map(([id, quote]) => ({ id, name: "По подписке", amountMinor: quote.amountMinor, benefit: quote.detail }));
}

export function fromStandardProducts(products: { id: string; name: string; source: string; cost: number | null }[]): BookingOption[] {
  return products.filter((product) => product.source === "one-time" && product.cost !== null)
    .map((product) => ({ id: `tariff:${product.id}`, name: product.name, amountMinor: product.cost }));
}

export function fromEventPriceQuotes(quotes: {
  subscriptionId: string; subscriptionName: string; amountMinor: number | null; expiresAt: number; status: string;
}[]): BookingOption[] {
  return quotes
    .filter((quote) => quote.status === "AVAILABLE" && quote.amountMinor !== null && Number.isFinite(quote.expiresAt) && quote.expiresAt > Date.now())
    .map((quote) => ({
      id: quote.subscriptionId, name: quote.subscriptionName, amountMinor: quote.amountMinor,
    }));
}

const money = (minor: number) => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: "RUB", maximumFractionDigits: 2,
}).format(minor / 100);

export const comparisonCategories = ["game", "training", "tournament"] as const;
type ComparisonCategory = typeof comparisonCategories[number];

type ComparisonQuote = {
  title: string;
  amountMinor: number | null;
  options: BookingOption[];
  expiresAt: number;
};

function comparisonKey(category: ComparisonCategory) {
  return `lk1-pilot-comparison:${category}`;
}

export function readComparisonQuote(category: ComparisonCategory): ComparisonQuote | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(comparisonKey(category)) ?? "null") as ComparisonQuote | null;
    return value && value.expiresAt > Date.now() && Array.isArray(value.options) ? value : null;
  } catch {
    return null;
  }
}

function storeComparisonQuote(category: ComparisonCategory, snapshot: string) {
  try {
    sessionStorage.setItem(comparisonKey(category), JSON.stringify({
      ...JSON.parse(snapshot), expiresAt: Date.now() + 15_000,
    }));
  } catch {
    // Event prices remain available when browser storage is unavailable.
  }
}

export function BookingOptions({ title, amountMinor, options = [], loading = false, category }: {
  title: string;
  amountMinor: number | null;
  options?: BookingOption[];
  loading?: boolean;
  category?: ComparisonCategory;
}) {
  const groupId = useId();
  const [selection, setSelection] = useState("regular");
  const choices = [{ id: "regular", name: "Полная цена", amountMinor }, ...options]
    .filter((option) => Number.isSafeInteger(option.amountMinor) && Number(option.amountMinor) >= 0);
  const selected = choices.find((option) => option.id === selection) ?? choices[0];
  const hasValidOptions = choices.length > 0;
  const snapshot = JSON.stringify({
    title, amountMinor, options: options.map((option, index) => ({ ...option, id: `option-${index}` })),
  });
  useEffect(() => {
    if (category && !loading && hasValidOptions) storeComparisonQuote(category, snapshot);
  }, [category, loading, snapshot, hasValidOptions]);

  return (
    <section className="matrix-payment" aria-label={title} aria-busy={loading}>
      <header className="matrix-payment-heading"><h2>{title}</h2></header>
      <fieldset className="matrix-options">
        <legend>Выберите способ записи</legend>
        {choices.map((option) => (
          <label className={`matrix-option ${option.id === selected?.id ? "is-selected" : ""}`} key={option.id}>
            <input type="radio" name={groupId} checked={option.id === selected?.id}
              onChange={() => setSelection(option.id)} />
            <span className="matrix-option-copy"><strong>{option.name}</strong>{option.benefit && <span>{option.benefit}</span>}</span>
            <span className="matrix-option-value"><strong>{money(option.amountMinor!)}</strong></span>
          </label>
        ))}
      </fieldset>
      {!choices.length && <p role="status">{loading ? "Проверяем стоимость…" : "Стоимость пока не подтверждена."}</p>}
      <footer className="matrix-booking-footer">
        <button className="matrix-confirm" type="button" disabled>
          {selected ? `Записаться за ${money(selected.amountMinor!)}` : "Записаться"}
        </button>
        <p className="matrix-payment-footnote">Предпросмотр. Запись и оплата отключены.</p>
      </footer>
    </section>
  );
}
