import { useEffect, useId, useState } from "react";
import { usePilotComparisonScope } from "./PilotSession";
import { money, type BookingOption } from "./bookingOptionPresentation";
import { useRaBoostPreview, useUnexpiredRaBoost } from "./useRaBoostPreview";
import type { PilotOfferTarget, RaBoostPreview } from "./raBoostPreview";

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
  boost?: RaBoostPreview | null;
  expiresAt: number;
  scope: string;
};

function comparisonKey(category: ComparisonCategory) {
  return `lk1-pilot-comparison-v2:${category}`;
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
  regularDetail, terms = "Можно выбрать один способ записи.", explanations = [], onRefresh, offerTarget = null, comparisonBoost,
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
  offerTarget?: PilotOfferTarget | null;
  comparisonBoost?: RaBoostPreview | null;
}) {
  const groupId = useId();
  const scope = usePilotComparisonScope();
  const [selection, setSelection] = useState<string | null>(null);
  const freshBoost = useRaBoostPreview(offerTarget, scope);
  const regular: BookingOption = { id: "regular", name: regularLabel, amountMinor, benefit: regularDetail };
  const choices = [regular, ...options]
    .filter((option) => Number.isSafeInteger(option.amountMinor) && Number(option.amountMinor) >= 0);
  const basePriceConfirmed = (price: number) => choices.some((option) => option.amountMinor === price);
  const cheapest = choices.filter(option => option.visitsLeft === undefined).reduce<BookingOption | undefined>((best, option) =>
    !best || option.amountMinor! < best.amountMinor! ? option : best, undefined);
  const candidateBoost = useUnexpiredRaBoost(freshBoost ?? comparisonBoost);
  const boost = candidateBoost && basePriceConfirmed(candidateBoost.basePriceMinor) && cheapest
    && candidateBoost.participationAmountMinor < cheapest.amountMinor! ? candidateBoost : null;
  const included = boost?.mode === "included";
  const boostOption: BookingOption | null = boost && {
    id: "ra-boost",
    name: included ? (boost.basePlan === "residency" ? "С Резидентством и РАбуста" : "С подпиской и РАбуста")
      : `Запись с подпиской от ${boost.participationAmountMinor === 0 ? "0 ₽" : money(boost.participationAmountMinor)}`,
    benefit: included ? undefined : "РАбуста",
    amountMinor: boost.participationAmountMinor,
    basePriceMinor: included ? boost.basePriceMinor : undefined,
  };
  const replacedBase = included && boost && choices.find(option => option !== regular
    && option.amountMinor === boost.baseAmountMinor
    && (option.id === boost.baseSubscriptionId || option.id.startsWith(`quote:${boost.baseSubscriptionId}:`)));
  const visibleChoices = included && boostOption
    ? [...choices.filter(option => option !== replacedBase), boostOption] : choices;
  const selected = boostOption?.id === selection ? boostOption
    : visibleChoices.find((option) => option.id === selection) ?? (included ? boostOption : cheapest ?? choices[0]);
  const showOffer = Boolean(boost && !included && selected === boostOption);
  const hasValidOptions = choices.length > 0;
  const baseIndex = replacedBase ? options.indexOf(replacedBase) : -1;
  const snapshot = JSON.stringify({
    title, amountMinor, regularLabel, regularDetail, terms, explanations,
    boost: boost && { ...boost, baseSubscriptionId: baseIndex >= 0 ? `option-${baseIndex}` : "" },
    options: options.map((option, index) => ({ ...option, id: `option-${index}` })),
  });
  useEffect(() => {
    if (category && scope && !loading && hasValidOptions) storeComparisonQuote(category, snapshot, scope);
  }, [category, scope, loading, snapshot, hasValidOptions]);

  const renderOption = (option: BookingOption, offer = false) => (
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
        <strong>{option.visitsLeft !== undefined ? `Остаток: ${option.visitsLeft}`
          : option.amountMinor === 0 && !offer ? "Бесплатно" : money(option.amountMinor!)}</strong>
      </span>
    </label>
  );

  return (
    <section className="matrix-payment" aria-label={title} aria-busy={loading}>
      <header className="matrix-payment-heading"><h2>{title}</h2></header>
      <fieldset className="matrix-options">
        <legend>Выберите способ записи</legend>
        {visibleChoices.map((option) => renderOption(option))}
        {boostOption && !included && (
          <>
            <strong className="matrix-add-on-heading">Записаться с дополнительными опциями</strong>
            {renderOption(boostOption, true)}
          </>
        )}
      </fieldset>
      {(loading || !choices.length) && (
        <p role="status">{loading ? "Проверяем ваши подписки…" : "Стоимость пока не подтверждена."}</p>
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
      {showOffer && boost && (
        <dl className="matrix-add-on-cost">
          <div><dt>Участие</dt><dd>{money(boost.participationAmountMinor)}</dd></div>
          <div><dt>РАбуста · {boost.durationDays} дн.</dt><dd>{money(boost.productAmountMinor)}</dd></div>
          <div><dt>Итого</dt><dd>{money(boost.participationAmountMinor + boost.productAmountMinor)}</dd></div>
        </dl>
      )}
      <footer className="matrix-booking-footer">
        <button className="matrix-confirm" type="button" disabled>
          {showOffer ? "Выбрать РАбуста" : !selected ? "Записаться" : selected.visitsLeft !== undefined ? "Записаться по абонементу" : selected.amountMinor === 0 ? "Записаться бесплатно"
            : `Записаться за ${money(selected.amountMinor!)}`}
        </button>
        <details className="matrix-booking-terms"><summary>Условия записи <span aria-hidden="true">⌄</span></summary><p>{terms}</p></details>
        <p className="matrix-payment-footnote">Предпросмотр. Запись и оплата отключены.</p>
      </footer>
    </section>
  );
}
