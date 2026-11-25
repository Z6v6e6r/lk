import { useEffect, useId, useState } from "react";
import { usePilotComparisonScope } from "./PilotSession";
import { money, type BookingOption } from "./bookingOptionPresentation";

export const comparisonCategories = ["game", "training", "tournament"] as const;
type ComparisonCategory = typeof comparisonCategories[number];

type ComparisonQuote = {
  title: string;
  amountMinor: number | null;
  options: BookingOption[];
  regularLabel?: string;
  regularDetail?: string;
  terms?: string;
  explanations?: string[];
  expiresAt: number;
  scope: string;
};

function comparisonKey(category: ComparisonCategory) {
  return `lk1-pilot-comparison:${category}`;
}

export function readComparisonQuote(category: ComparisonCategory, scope: string | null): ComparisonQuote | null {
  if (!scope) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(comparisonKey(category)) ?? "null") as ComparisonQuote | null;
    return value && value.scope === scope && value.expiresAt > Date.now() && Array.isArray(value.options) ? value : null;
  } catch {
    return null;
  }
}

function storeComparisonQuote(category: ComparisonCategory, snapshot: string, scope: string) {
  try {
    sessionStorage.setItem(comparisonKey(category), JSON.stringify({
      ...JSON.parse(snapshot), scope, expiresAt: Date.now() + 15_000,
    }));
  } catch {
    // Event prices remain available when browser storage is unavailable.
  }
}

export function BookingOptions({
  title, amountMinor, options = [], loading = false, category, regularLabel = "Полная цена",
  regularDetail, terms = "Можно выбрать один способ записи.", explanations = [], onRefresh,
}: {
  title: string;
  amountMinor: number | null;
  options?: BookingOption[];
  loading?: boolean;
  category?: ComparisonCategory;
  regularLabel?: string;
  regularDetail?: string;
  terms?: string;
  explanations?: string[];
  onRefresh?: () => void;
}) {
  const groupId = useId();
  const scope = usePilotComparisonScope();
  const [selection, setSelection] = useState("regular");
  const regular: BookingOption = { id: "regular", name: regularLabel, amountMinor, benefit: regularDetail };
  const choices = [regular, ...options]
    .filter((option) => Number.isSafeInteger(option.amountMinor) && Number(option.amountMinor) >= 0);
  const selected = choices.find((option) => option.id === selection) ?? choices[0];
  const hasValidOptions = choices.length > 0;
  const snapshot = JSON.stringify({
    title, amountMinor, regularLabel, regularDetail, terms, explanations,
    options: options.map((option, index) => ({ ...option, id: `option-${index}` })),
  });
  useEffect(() => {
    if (category && scope && !loading && hasValidOptions) storeComparisonQuote(category, snapshot, scope);
  }, [category, scope, loading, snapshot, hasValidOptions]);

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
            <span className="matrix-option-value">
              {option.basePriceMinor != null && option.basePriceMinor > option.amountMinor! && (
                <span className="matrix-base-price matrix-option-base-price">
                  <span>Полная цена</span><del>{money(option.basePriceMinor)}</del>
                </span>
              )}
              <strong>{option.amountMinor === 0 ? "Бесплатно" : money(option.amountMinor!)}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      {(loading || !choices.length) && (
        <p role="status">{loading ? "Проверяем стоимость…" : "Стоимость пока не подтверждена."}</p>
      )}
      {explanations.length > 0 && (
        <details className="matrix-unavailable" open={options.length === 0}>
          <summary>Применимость льгот</summary>
          <ul>{explanations.map((explanation) => <li key={explanation}>{explanation}</li>)}</ul>
        </details>
      )}
      {onRefresh && <button className="game-summary-edit-button" type="button" onClick={onRefresh}>
        Обновить стоимость по подпискам
      </button>}
      <footer className="matrix-booking-footer">
        <button className="matrix-confirm" type="button" disabled>
          {!selected ? "Записаться" : selected.amountMinor === 0 ? "Записаться бесплатно"
            : `Записаться за ${money(selected.amountMinor!)}`}
        </button>
        <details className="matrix-booking-terms"><summary>Условия записи <span aria-hidden="true">⌄</span></summary><p>{terms}</p></details>
        <p className="matrix-payment-footnote">Предпросмотр. Запись и оплата отключены.</p>
      </footer>
    </section>
  );
}
