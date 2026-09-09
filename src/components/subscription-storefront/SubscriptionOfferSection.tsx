import { useEffect, useId, useRef, useState } from 'react';
import { SubscriptionPlanCard } from './SubscriptionPlanCard.js';
import type { SubscriptionOfferSectionView, SubscriptionPlanSelection } from './model.js';


export function SubscriptionOfferSection(props: {
  readonly section: SubscriptionOfferSectionView;
  readonly selectedBillingOptions: Readonly<Record<string, string>>;
  readonly onBillingOptionChange: (planId: string, optionId: string) => void;
  readonly onChoose: (selection: SubscriptionPlanSelection) => void;
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null);
  const railId = useId();
  const [scroll, setScroll] = useState({ position: 0, max: 0 });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const measure = () => {
      const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
      const position = Math.max(0, Math.min(max, rail.scrollLeft));
      setScroll(previous => previous.position === position && previous.max === max
        ? previous : { position, max });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(rail);
    for (const item of rail.children) observer.observe(item);
    rail.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      rail.removeEventListener('scroll', schedule);
    };
  }, [props.section.plans]);

  const move = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    const left = rail.getBoundingClientRect().left;
    const stops = Array.from(rail.children, item =>
      Math.min(scroll.max, Math.max(0, item.getBoundingClientRect().left - left + rail.scrollLeft)));
    const target = direction === 1
      ? stops.find(stop => stop > rail.scrollLeft + 1) ?? scroll.max
      : stops.reverse().find(stop => stop < rail.scrollLeft - 1) ?? 0;
    rail.scrollTo({ left: target, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };

  return (
    <section className="subscription-offer-section" aria-labelledby={`${props.section.id}-title`}>
      {props.section.title ? (
        <header className="subscription-offer-section__header">
          <h2 id={`${props.section.id}-title`}>{props.section.title}</h2>
          {props.section.description ? <p>{props.section.description}</p> : null}
        </header>
      ) : (
        <h2 id={`${props.section.id}-title`} className="subscription-visually-hidden">
          Варианты абонементов
        </h2>
      )}

      {scroll.max > 1 && <div className="subscription-rail-controls">
        <button type="button" aria-label="Предыдущая подписка" aria-controls={railId}
          disabled={scroll.position <= 1} onClick={() => move(-1)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <label className="subscription-rail-controls__track">
          <span>Листайте подписки</span>
          <input type="range" min={0} max={Math.ceil(scroll.max)} step={1}
            aria-label="Прокрутка подписок" aria-controls={railId}
            aria-valuetext={`${Math.round(scroll.position / scroll.max * 100)}%`}
            value={Math.ceil(scroll.position)}
            onChange={event => railRef.current?.scrollTo({ left: Number(event.target.value), behavior: 'instant' })} />
        </label>
        <button type="button" aria-label="Следующая подписка" aria-controls={railId}
          disabled={scroll.position >= scroll.max - 1} onClick={() => move(1)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
        </button>
      </div>}
      <div
        ref={railRef}
        id={railId}
        className="subscription-plan-rail"
        role="list"
        aria-label={props.section.title ?? 'Варианты абонементов'}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const rail = event.currentTarget;
          const offsets: Record<string, number> = {
            ArrowRight: rail.scrollLeft + rail.clientWidth,
            ArrowLeft: rail.scrollLeft - rail.clientWidth,
            Home: 0,
            End: rail.scrollWidth,
          };
          if (!(event.key in offsets)) return;
          event.preventDefault();
          rail.scrollTo({ left: offsets[event.key], behavior: 'instant' });
        }}
      >
        {props.section.plans.map((plan) => {
          const selectedBillingOptionId =
            props.selectedBillingOptions[plan.id] ??
            plan.initialBillingOptionId ??
            plan.billingOptions[0]?.id;
          if (!selectedBillingOptionId) {
            throw new Error(`Subscription plan ${plan.id} has no selected billing option`);
          }
          return (
            <div
              key={plan.id}
              className={`subscription-plan-rail__item${
                plan.featured ? ' subscription-plan-rail__item--featured' : ''
              }`}
              role="listitem"
            >
              <SubscriptionPlanCard
                plan={plan}
                selectedBillingOptionId={selectedBillingOptionId}
                onBillingOptionChange={(optionId) => props.onBillingOptionChange(plan.id, optionId)}
                onChoose={() =>
                  props.onChoose({ planId: plan.id, billingOptionId: selectedBillingOptionId })
                }
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
