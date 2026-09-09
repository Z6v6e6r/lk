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
  const [scroll, setScroll] = useState({ position: 0, max: 0, stops: [0] });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    const measure = () => {
      const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
      const position = Math.max(0, Math.min(max, rail.scrollLeft));
      const left = rail.getBoundingClientRect().left;
      const stops = Array.from(rail.children, item =>
        Math.min(max, Math.max(0, item.getBoundingClientRect().left - left + rail.scrollLeft)))
        .filter((stop, index, all) => index === 0 || stop - all[index - 1] > 1);
      setScroll(previous => previous.position === position && previous.max === max
        && previous.stops.length === stops.length && previous.stops.every((stop, index) => Math.abs(stop - stops[index]) < 0.5)
        ? previous : { position, max, stops });
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

  const goTo = (left: number) => {
    railRef.current?.scrollTo({ left, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  const move = (direction: -1 | 1) => {
    const position = railRef.current?.scrollLeft ?? scroll.position;
    goTo(direction === 1
      ? scroll.stops.find(stop => stop > position + 1) ?? scroll.max
      : [...scroll.stops].reverse().find(stop => stop < position - 1) ?? 0);
  };
  const activeStop = scroll.stops.reduce((closest, stop, index) =>
    Math.abs(stop - scroll.position) < Math.abs(scroll.stops[closest] - scroll.position) ? index : closest, 0);


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

      {scroll.max > 1 && <div className="subscription-rail-dots" role="group" aria-label="Переключение карточек подписок">
        {scroll.stops.map((stop, index) => <button key={index} type="button"
          aria-label={`Показать подписки, страница ${index + 1} из ${scroll.stops.length}`}
          aria-controls={railId} aria-current={activeStop === index ? 'true' : undefined}
          onClick={() => goTo(stop)} />)}
      </div>}
      <div className="subscription-rail-frame">
        {scroll.max > 1 && <>
          <button className="subscription-rail-arrow subscription-rail-arrow--previous" type="button"
            aria-label="Предыдущая подписка" aria-controls={railId}
            disabled={scroll.position <= 1} onClick={() => move(-1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
          </button>
          <button className="subscription-rail-arrow subscription-rail-arrow--next" type="button"
            aria-label="Следующая подписка" aria-controls={railId}
            disabled={scroll.position >= scroll.max - 1} onClick={() => move(1)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
          </button>
        </>}
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
      </div>
    </section>
  );
}
