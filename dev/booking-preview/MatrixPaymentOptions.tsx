import { Fragment, useId, useState } from 'react';
import { Modal } from '../../src/components/UI/Modal';
import { AuthForm } from '../../src/components/auth/AuthForm';
import { useAuth } from './auth';
import { buildBookingPaymentOptions, formatRubles, readMatrixSettings, SERVICES, type GamePaymentScope, type PaymentKind, type PaymentOption, type ServiceKind } from './paymentMatrix';
import { bookingButtonText, combineResidencyBoost, combineSubscriptionBoost, createPreviewOrder, defaultPaymentOption, isSelectableMethod, passBalanceText, readBoostPrice, readPassRemaining, readResidencyPrice, trainingCount, withPassBalance, withPersonalSubscription, withoutResidencyForSubscribers, type PreviewOrder } from './bookingCheckout';
import { recommendedSubscriptionChoice, subscriptionPurchaseChoices, type SubscriptionOffer } from './subscriptionOffers';
import { SUBSCRIPTION_PLANS, dailyAllowanceSummary } from './privilegeRules';
import { SubscriptionPurchaseOffer } from './SubscriptionPurchaseOffer';
import { ResidencyPurchaseOffer } from './ResidencyPurchaseOffer';
import { PurchaseOfferLayout } from './PurchaseOfferLayout';
import { BoostPurchaseOffer } from './BoostPurchaseOffer';
import { boostPurchaseOption } from './boostOffers';
import { readPreviewStage } from './previewStage';
import { type BookingEventDetails } from './bookingEventDetails';
import { previewScheduleUrl } from './previewNavigation';
import './matrix.css';

function PaymentIcon({ kind }: { kind: PaymentKind }) {
  const paths: Record<PaymentKind, string> = {
    full: 'M3 4h8l10 10-7 7L3 10V4Zm4 3h.01',
    residency: 'm3 7 5 4 4-7 4 7 5-4-2 12H5L3 7ZM5 22h14',
    subscription: 'm3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5',
    pass: 'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Zm9 0v3m0 3v2m0 3v3',
    boost: 'm13 2-9 12h7l-1 8L21 9h-8l1-7Z',
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>;
}

const optionNames: Record<PaymentKind, string> = {
  full: 'Полная цена', residency: 'С Резидентством', subscription: 'По подписке', pass: 'По абонементу Энергия 5', boost: 'С Бустом — бесплатно',
};

export function MatrixPaymentOptions({ service, eventKey, disabled = false, excludesPrivileges = false, durationMinutes, gamePaymentScope, courtAmount = null, eventDetails, eventName }: { service: ServiceKind; eventKey: string; disabled?: boolean; excludesPrivileges?: boolean; durationMinutes?: number; gamePaymentScope?: GamePaymentScope; courtAmount?: number | null; eventDetails?: BookingEventDetails; eventName?: string }) {
  const params = new URLSearchParams(location.search);
  const settings = readMatrixSettings(params);
  const residencyPrice = readResidencyPrice(params);
  const boostPrice = readBoostPrice(params);
  const [purchasedResidency, setPurchasedResidency] = useState(false);
  const [purchasedBoost, setPurchasedBoost] = useState(false);
  const [purchasedSubscription, setPurchasedSubscription] = useState<SubscriptionOffer | null>(null);
  const [passRemaining, setPassRemaining] = useState(settings.profile.pass ? readPassRemaining(params) : 0);
  const [passVisitDebited, setPassVisitDebited] = useState(false);
  const profile = { ...settings.profile, residency: settings.profile.residency || purchasedResidency,
    subscription: settings.profile.subscription || purchasedSubscription !== null, pass: settings.profile.pass };
  const applicability = { subscription: purchasedSubscription ? true : settings.applicability.subscription, pass: settings.applicability.pass };
  const excludedGroup = service === 'training' && (excludesPrivileges || settings.excludedGroups);
  const duration = durationMinutes ?? SERVICES[service].durationMinutes;
  const hasBoost = readPreviewStage(params) === 'full' && (settings.boost || purchasedBoost) && (profile.residency || profile.subscription);
  const paymentContext = { ...settings, boost: hasBoost, subscriptionPlan: purchasedSubscription?.plan || settings.subscriptionPlan, excludedGroups: excludedGroup, durationMinutes: duration };
  const isWholeCourt = service === 'game' && gamePaymentScope === 'court';
  const isPersonalGame = service === 'game' && gamePaymentScope === 'quarter';
  const subscriptionChoices = subscriptionPurchaseChoices(service, paymentContext, gamePaymentScope, courtAmount);
  const subscriptionParticipationPrices = subscriptionChoices.flatMap(({ option }) => option.amount != null && Number.isFinite(option.amount) && option.amount >= 0 ? [option.amount] : []);
  const subscriptionFromPrice = subscriptionParticipationPrices.length ? Math.min(...subscriptionParticipationPrices) : null;
  const recommendedSubscription = recommendedSubscriptionChoice(subscriptionChoices);
  const [purchaseSubscriptionId, setPurchaseSubscriptionId] = useState(recommendedSubscription?.offer.id || '');
  const purchaseSubscriptionChoice = subscriptionChoices.find(choice => choice.offer.id === purchaseSubscriptionId) || recommendedSubscription;
  const purchaseSubscription = purchaseSubscriptionChoice?.offer;
  const subscriptionPurchaseOption = purchaseSubscriptionChoice?.option;
  const rawPaymentOptions = withPassBalance(buildBookingPaymentOptions(service, profile, applicability, paymentContext, gamePaymentScope, courtAmount), passRemaining)
    .flatMap(option => option.kind === 'subscription' && !profile.subscription ? subscriptionPurchaseOption ? [subscriptionPurchaseOption] : [] : [option]);
  const paymentOptions = withoutResidencyForSubscribers(combineResidencyBoost(combineSubscriptionBoost(rawPaymentOptions, profile), profile), profile);
  const boostOffer = boostPurchaseOption(service, profile, applicability, paymentContext, readPreviewStage(params), gamePaymentScope, courtAmount);
  const allOptions = boostOffer ? [...paymentOptions, boostOffer] : paymentOptions;
  const options = isPersonalGame ? withPersonalSubscription(allOptions, profile.subscription) : allOptions;
  const available = options.filter(isSelectableMethod);
  const defaultChoice = defaultPaymentOption(options);
  const [selected, setSelected] = useState<PaymentKind>(defaultChoice?.kind || 'full');
  const [residencyOfferOpen, setResidencyOfferOpen] = useState(false);
  const [checkout, setCheckout] = useState<PreviewOrder | null>(null);
  const [checkoutOption, setCheckoutOption] = useState<PaymentOption | null>(null);
  const [checkoutSubscription, setCheckoutSubscription] = useState<SubscriptionOffer | null>(null);
  const [paidOrder, setPaidOrder] = useState<PreviewOrder | null>(null);
  const [subscriptionOfferOpen, setSubscriptionOfferOpen] = useState(false);
  const [boostOfferOpen, setBoostOfferOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [pendingAllowance, setPendingAllowance] = useState<PaymentOption | null>(null);
  const [registered, setRegistered] = useState(params.get('state') === 'registered');
  const [busy, setBusy] = useState(false);
  const [submittedOption, setSubmittedOption] = useState<PaymentOption | null>(null);
  const { isAuthenticated } = useAuth();
  const groupId = useId();
  const price = SERVICES[service];
  const full = params.get('state') === 'full';
  const combinedSubscription = available.find(option => option.withSubscription && option.mode === 'book');
  const selectedKind = (selected === 'boost' || selected === 'subscription') && combinedSubscription ? combinedSubscription.kind : selected;
  const choice = available.find(option => option.kind === selectedKind) || defaultChoice;
  const locked = disabled || full || busy;
  const referenceAmount = options.find(option => option.kind === 'full')?.amount ?? null;
  const subscriptionOrder = subscriptionPurchaseOption && purchaseSubscription ? createPreviewOrder(subscriptionPurchaseOption, null, purchaseSubscription.price) : null;
  const startCheckout = (order: PreviewOrder, option: PaymentOption, subscription: SubscriptionOffer | null = null) => {
    setCheckout(order); setCheckoutOption(option); setCheckoutSubscription(subscription);
  };

  const productName = (option: PaymentOption) => option.kind === 'residency' ? 'Резидентство' : option.kind === 'boost' ? 'РАбуста' : `подписку «${purchaseSubscription?.name || 'Подписка'}»`;
  const productCost = (option: PaymentOption) => option.kind === 'residency' ? residencyPrice : option.kind === 'boost' ? boostPrice : purchaseSubscription?.price ?? null;
  const offerOrder = (option: PaymentOption) => createPreviewOrder(option, residencyPrice, purchaseSubscription?.price ?? null, boostPrice);
  const usesAllowance = (option: PaymentOption) => option.mode === 'book' && (option.kind === 'pass' || ((option.kind === 'subscription' || option.kind === 'boost') && ['free-hour', 'partial-hour', 'free-event', 'free-training'].includes(option.benefit || '')));
  const allowanceText = (option: PaymentOption) => option.kind === 'pass' ? `Спишем 1 из ${passRemaining} тренировок Энергии 5. После записи останется ${trainingCount(passRemaining - 1)}.` : `Запись использует ${option.freeMinutes ? `${option.freeMinutes} мин` : '1 занятие'} дневного лимита ${option.kind === 'boost' ? 'РАбуста' : 'подписки'}.`;
  const title = (option: PaymentOption) => {
    if (option.mode === 'offer' && option.kind === 'subscription') return `Запись с подпиской${subscriptionFromPrice != null ? ` от ${formatRubles(subscriptionFromPrice)}` : ''}`;
    if (option.mode === 'offer' && option.kind === 'boost') return 'С РАбуста';
    if (option.mode === 'offer') return `Добавить ${productName(option)}`;
    if (option.withResidency) return `С Резидентством и РАбуста${option.amount === 0 ? ' — бесплатно' : ''}`;
    if (option.withSubscription) return `С подпиской и РАбуста${option.amount === 0 ? ' — бесплатно' : ''}`;
    if (option.kind === 'boost') return option.amount === 0 ? 'С Бустом — бесплатно' : option.benefit === 'partial-hour' ? `С Бустом · ${option.freeMinutes} минут бесплатно` : `С Бустом · скидка ${price.discount}%`;
    if (isWholeCourt && option.kind === 'full') return 'Полная оплата за 4 игроков';
    if (isPersonalGame && option.kind === 'full') return 'Разовое участие';
    if (isPersonalGame && profile.subscription && option.kind === 'subscription' && option.mode === 'book') return 'Моя доля · по подписке';
    if (option.kind !== 'subscription') return optionNames[option.kind];
    if (option.benefit === 'free-event') return `По подписке ${option.subscriptionPlan === 'friendship-2' ? 'Дружба 2.0' : 'РА'} — бесплатно`;
    if (option.benefit === 'discount') return `По подписке · скидка ${price.discount}%`;
    if (option.benefit === 'partial-hour') return `По подписке · ${option.freeMinutes} минут бесплатно`;
    if (!profile.subscription && !excludedGroup) return 'Бесплатно при наличии подписки';
    if (option.benefit === 'free-training') return 'По подписке · 1 тренировка в день';
    if (option.benefit === 'free-hour') return `По подписке · ${option.subscriptionPlan === 'friendship-2' ? '2 часа' : '1 час'} в день`;
    return 'Подписка';
  };
  const detail = (option: PaymentOption) => {
    if (option.mode === 'offer' && option.kind === 'subscription') return recommendedSubscription?.offer.name || 'Подписка';
    if (option.mode === 'offer' && option.kind === 'boost') return `Буст ${profile.subscription ? 'подписки' : 'Резидентства'} на 7 дней`;
    if (option.mode === 'offer') {
      const cost = productCost(option);
      return `${cost == null ? 'Цена продукта уточняется' : `${formatRubles(cost)} за 30 дней`} · ${option.amount === 0 ? 'участие включено' : option.amount != null ? `участие ${formatRubles(option.amount)}` : 'стоимость участия уточняется'}`;
    }
    if (option.reason === 'excluded-group') return option.kind === 'residency' ? 'Резидентство не действует на эту категорию групповых' : 'Подписка не действует на эту категорию групповых';
    if (option.reason === 'training-only') return 'Бесплатная тренировка ещё доступна. Скидки на другие услуги — после использования дневного лимита';
    if (option.reason === 'unknown-price') return 'Стоимость корта уточняется';
    if (option.reason === 'unknown-duration') return 'Нужно уточнить длительность события';
    if (option.mode === 'unavailable') return option.kind === 'subscription' ? 'Тариф подписки не подходит к этому событию' : 'Нет подходящего абонемента с доступными посещениями';
    if (option.kind === 'full') return isWholeCourt ? 'Оплата всего корта без применения льгот' : '';
    if (option.withResidency && option.benefit === 'discount') return 'Бесплатный лимит РАбуста недоступен · действует скидка Резидентства';
    if (option.kind === 'residency') return `Скидка ${price.discount}%`;
    if (option.withResidency && (option.benefit === 'free-hour' || option.benefit === 'free-event')) return 'Дневной лимит РАбуста доступен';
    if (option.withSubscription && (option.benefit === 'free-hour' || option.benefit === 'free-event')) return SUBSCRIPTION_PLANS.find(plan => plan.id === paymentContext.subscriptionPlan)?.name || 'Подписка';
    if (option.kind === 'subscription' || option.kind === 'boost') {
      const prefix = '';
      const source = option.kind === 'boost' ? 'Буст' : option.subscriptionPlan === 'friendship-2' ? 'Дружбу 2.0' : 'РА';
      if (option.benefit === 'free-event') return `${prefix}Занятие входит в ${source} · без доплаты за участие${paymentContext.proDirection ? ' · ПРО: 1 событие в день' : ''}`;
      if (option.benefit === 'discount') return `${prefix}${option.reason === 'active-limit' ? 'Больше 8 активных записей. ' : paymentContext.dailyQuota === 'used' ? 'Дневной бесплатный лимит использован. ' : ''}Скидка ${price.discount}% на запись`;
      if (option.benefit === 'partial-hour') return `${prefix}${option.freeMinutes} минут бесплатно · ${option.amount != null ? `доплата за ${option.paidMinutes} минут — ${formatRubles(option.amount)}` : `за оставшиеся ${option.paidMinutes} минут нужна доплата. Формула уточняется`}${option.overtimeDiscount ? ' · на доплату действует скидка 30%' : ''}`;
      if (option.benefit === 'free-hour') return `${prefix}Дневной лимит доступен · запись на ${option.freeMinutes} мин. без доплаты${option.kind === 'boost' ? ' · с Бустом' : ''}`;
      return `${prefix}Дневная бесплатная тренировка доступна · без списания абонемента`;
    }
    return `${passBalanceText(passRemaining)} · спишется 1 тренировка`;
  };
  const amount = (option: PaymentOption) => option.mode === 'offer' && option.kind === 'subscription' ? subscriptionFromPrice != null ? formatRubles(subscriptionFromPrice) : 'Нужен расчёт' : option.mode === 'offer' ? offerOrder(option) ? formatRubles(offerOrder(option)!.total) : 'Нужен расчёт' : option.reason === 'unknown-price' ? 'Нужен расчёт' : option.mode === 'unavailable' ? 'Не действует'
    : option.reason === 'training-only' ? 'Выбрать тариф'
    : option.benefit === 'partial-hour' && option.amount == null ? 'Нужен расчёт'
      : option.kind === 'pass' ? `Остаток: ${trainingCount(passRemaining)}` : option.amount === 0 ? 'Бесплатно' : formatRubles(option.amount!);
  const confirmText = bookingButtonText(choice, choice ? productCost(choice) : null);
  const confirm = async (allowanceConfirmed = false) => {
    const method = allowanceConfirmed ? pendingAllowance : choice;
    if (locked || !method || registered || (!allowanceConfirmed && pendingAllowance)) return;
    if (!isAuthenticated) { setLoginOpen(true); return; }
    if (method.mode === 'offer') {
      if (method.kind === 'residency') setResidencyOfferOpen(true);
      else if (method.kind === 'subscription') setSubscriptionOfferOpen(true);
      else if (method.kind === 'boost') setBoostOfferOpen(true);
      return;
    }
    if (usesAllowance(method) && !allowanceConfirmed) { setPendingAllowance({ ...method }); return; }
    setPendingAllowance(null);
    const order = createPreviewOrder(method);
    if (!order) return;
    if (order.total > 0) { startCheckout(order, method); return; }
    if (method.kind === 'pass' && passRemaining <= 0) return;
    setBusy(true);
    // Local interaction only: no payment API, booking write or real debit.
    await new Promise(resolve => setTimeout(resolve, 300));
    setSubmittedOption(method);
    if (method.kind === 'pass') { setPassRemaining(value => value - 1); setPassVisitDebited(true); }
    setRegistered(true);
    setBusy(false);
  };
  const confirmSubscriptionPurchase = () => {
    if (locked || registered || !subscriptionOrder || !subscriptionPurchaseOption || !purchaseSubscription) return;
    if (!isAuthenticated) { setLoginOpen(true); return; }
    startCheckout(subscriptionOrder, subscriptionPurchaseOption, purchaseSubscription);
    setSubscriptionOfferOpen(false);
  };
  const addResidency = () => {
    if (locked || registered || choice?.kind !== 'residency' || choice.mode !== 'offer') return;
    const order = createPreviewOrder(choice, residencyPrice);
    if (!order) return;
    setResidencyOfferOpen(false);
    startCheckout(order, choice);
  };
  const addBoost = () => {
    if (locked || registered || !isAuthenticated || hasBoost || !boostOffer || choice?.kind !== 'boost' || choice.mode !== 'offer') return;
    const order = createPreviewOrder(boostOffer, null, null, boostPrice);
    if (!order) return;
    setBoostOfferOpen(false);
    startCheckout(order, boostOffer);
  };
  const completePayment = async () => {
    if (locked || !checkout || !checkoutOption || registered || !isAuthenticated || (checkout.product === 'subscription' && !checkoutSubscription)) return;
    if (checkout.product === 'boost' && (hasBoost || (!profile.residency && !profile.subscription) || readPreviewStage(params) !== 'full')) return;
    setBusy(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    setPaidOrder(checkout);
    setSubmittedOption(checkoutOption);
    if (checkout.product === 'subscription') setPurchasedSubscription(checkoutSubscription);
    if (checkout.product === 'residency') setPurchasedResidency(true);
    if (checkout.product === 'boost') setPurchasedBoost(true);
    setCheckout(null);
    setRegistered(true);
    setBusy(false);
  };

  const paymentFootnote = isWholeCourt ? 'Стоимость оплачивается полностью за всех игроков. Льготы не расходуются.' : 'Выбран один способ записи. Скидки подписки и Резидентства не суммируются. Абонемент списывается только при выборе абонемента.';
  return <section className="matrix-payment" aria-label={`Способы записи: ${(eventName || price.name)}`} data-service={service} data-event={eventKey}>
    <header className="matrix-payment-heading"><div><h2><span className="matrix-current-only">{registered ? 'Ваша запись' : checkout ? 'Оплата записи' : 'Выберите способ записи'}</span><span className="matrix-lk2-only">{registered ? 'Ваша запись' : checkout ? 'Оплата записи' : service === 'game' ? 'Запись на игру' : service === 'training' ? 'Запись на тренировку' : 'Запись на турнир'}</span></h2><p><span className="matrix-event-copy"><strong>{(eventName || price.name)}</strong><span>{isPersonalGame ? ' · моя доля ¼' : isWholeCourt ? ' · плачу за всех' : ''}{Number.isFinite(duration) && duration > 0 ? ` · ${duration} мин` : ''}{service !== 'game' && paymentContext.proDirection ? ' · ПРО' : ''}{service === 'tournament' && paymentContext.friendsTournament ? ' · Время на друзей' : ''}</span></span></p></div>
    </header>
    {registered ? <div className="matrix-success" role="status">
      <strong>Вы записаны</strong><p>{submittedOption?.kind === 'pass' ? `Энергия 5 · списана 1 тренировка · ${passBalanceText(passRemaining)}` : submittedOption ? `${title({ ...submittedOption, mode: 'book' })}${submittedOption.amount != null && submittedOption.amount > 0 ? ` · ${formatRubles(submittedOption.amount)}` : ''}` : 'Место за вами. Это заранее заданное тестовое состояние; способ оплаты и сумма записи не переданы.'}</p>
      {paidOrder && <p>Оплачено {formatRubles(paidOrder.total)}{paidOrder.product ? ` · запись ${formatRubles(paidOrder.bookingAmount)} + ${paidOrder.product === 'subscription' ? checkoutSubscription?.name || 'Подписка' : paidOrder.product === 'boost' ? 'РАбуста' : 'Резидентство'} ${formatRubles(paidOrder.productAmount)}` : ''}</p>}
      <p>Отмена на стенде имитируется. Условия и срок возврата в рабочем ЛК зависят от события; автоматический возврат здесь не выполняется.</p>
      <button type="button" onClick={() => { if (passVisitDebited) setPassRemaining(value => Math.min(5, value + 1)); setPassVisitDebited(false); setRegistered(false); setSubmittedOption(null); setPaidOrder(null); }}>Отменить запись</button>
    </div> : checkout ? <div className="matrix-checkout" aria-label="Оплата выбранного варианта">
      <dl className="matrix-order-lines"><div><dt>{(eventName || price.name)}</dt><dd>{formatRubles(checkout.bookingAmount)}</dd></div>
        {checkout.product && <div><dt>{checkout.product === 'residency' ? 'Резидентство' : checkout.product === 'boost' ? 'РАбуста' : `Подписка ${checkoutSubscription?.name || ''}`}</dt><dd>{formatRubles(checkout.productAmount)}</dd></div>}
        <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(checkout.total)}</dd></div></dl>
      <button type="button" className="matrix-confirm" disabled={locked} onClick={() => void completePayment()}>{busy ? 'Подтверждаем оплату…' : `Оплатить ${formatRubles(checkout.total)}`}</button>
      <button type="button" className="matrix-back" disabled={busy} onClick={() => setCheckout(null)}>Вернуться к выбору оплаты</button>
    </div> : <>
      {isWholeCourt && <p className="matrix-notice">Полная оплата корта: подписка, Резидентство и абонементы не применяются.</p>}
      {full && <p className="matrix-notice" role="status">Все места заняты. Запись на это событие недоступна. <button type="button" className="matrix-back" onClick={() => location.assign(previewScheduleUrl(location.href))}>Выбрать другое событие</button></p>}
      {!isWholeCourt && dailyAllowanceSummary(profile, paymentContext) && <p className="matrix-notice">{dailyAllowanceSummary(profile, paymentContext)}</p>}
      <fieldset className="matrix-options" disabled={locked || !!pendingAllowance}>
        <legend className="matrix-sr-only"><span className="matrix-current-only">Способы записи</span><span className="matrix-lk2-only">Выберите способ записи</span></legend>
        {options.filter(option => option.mode !== 'reference' && option.mode !== 'unavailable').sort((a, b) => Number(a.mode === 'offer') - Number(b.mode === 'offer')).map((option, index, visible) => {
          const displayKind = option.withResidency ? 'residency' : option.withSubscription ? 'subscription' : option.kind;
          const showBasePrice = option.mode !== 'offer' && (option.kind === 'residency' || option.kind === 'subscription' || option.kind === 'boost')
            && referenceAmount != null && option.amount != null && option.amount >= 0 && option.amount < referenceAmount;
          const optionDetail = detail(option);
          const copy = <><span className={`matrix-icon matrix-icon--${displayKind}`}><PaymentIcon kind={displayKind} /></span>
            <span className="matrix-option-copy"><strong>{title(option)}</strong>{optionDetail && <span>{optionDetail}</span>}{isPersonalGame && option.kind === 'full' && <span className="matrix-option-share">Моя доля 1/4 стоимости</span>}</span>
            <span className="matrix-option-value">{showBasePrice && <span className="matrix-base-price matrix-option-base-price"><span>Полная цена</span><del>{formatRubles(referenceAmount!)}</del></span>}<strong>{amount(option)}</strong></span></>;
          const classes = `matrix-option matrix-option--${displayKind} ${choice?.kind === option.kind ? 'is-selected' : ''} ${option.mode === 'quote' ? 'is-quote' : ''}`;
          const groupTitle = option.mode === 'offer' && (index === 0 || visible[index - 1].mode !== 'offer') ? <div className="matrix-method-group-label">Записаться с дополнительными опциями</div> : null;
          if (isSelectableMethod(option)) return <Fragment key={option.kind}>{groupTitle}<label className={classes} key={option.kind}>
            <input type="radio" name={`${groupId}-method`} value={option.kind} checked={choice?.kind === option.kind} disabled={locked} onChange={() => setSelected(option.kind)} />{copy}
          </label></Fragment>;
          return <div className={classes} key={option.kind} aria-disabled="true">{copy}</div>;
        })}
      </fieldset>
      {!isWholeCourt && <details className="matrix-unavailable"><summary>Применимость льгот</summary><ul>
        {profile.subscription && profile.residency && <li>Резидентство не показано отдельно: скидки с подпиской не суммируются.</li>}
        {options.filter(option => option.mode === 'unavailable').map(option => <li key={option.kind}>{optionNames[option.kind]}: {option.reason === 'pro-direction' ? 'ПРО не входит или дневной лимит ПРО уже использован' : detail(option)}.</li>)}
        {profile.pass && passRemaining === 0 && <li>Энергия 5: тренировки закончились.</li>}
        {profile.pass && service === 'game' && <li>Энергия 5 не применяется к обычной игре 2×2.</li>}
        {profile.pass && passRemaining > 0 && service !== 'game' && !settings.applicability.pass && service !== 'tournament' && <li>Энергия 5 не подходит к выбранному занятию.</li>}
        {!profile.subscription && (settings.dailyQuota === 'used' || settings.activeLimitExceeded) && <li>Покупка подписки в стенде не обнуляет заданные ограничения профиля.</li>}
        {profile.subscription && !(paymentContext.subscriptionPlan === 'ra' ? settings.raFits : settings.applicability.subscription) && <li>Подписка не подходит к событию. Предложение РАбуста скрыто до подтверждения применимости связки.</li>}
        <li>Доступные способы и итоговая стоимость показаны выше. Покупка Энергии 5 в этом потоке не предлагается.</li>
      </ul></details>}
      {options.some(option => option.benefit === 'partial-hour' && option.mode === 'quote') && <p className="matrix-copay-note" role="status">Стоимость доплаты пока не определена. Запись с использованием бесплатного часа станет доступна после расчёта.</p>}
      <div className="matrix-booking-footer">
        <button className="matrix-confirm" type="button" disabled={locked || !!pendingAllowance || !choice || (choice.mode === 'offer' && !offerOrder(choice))} onClick={() => void confirm()}>{busy ? 'Подтверждаем запись…' : full ? 'Мест нет' : !isAuthenticated ? 'Войти для записи' : confirmText}</button>
        <p className="matrix-payment-footnote matrix-current-only">{paymentFootnote}</p>
        <details className="matrix-lk2-only matrix-booking-terms"><summary>Условия записи<span aria-hidden="true">⌄</span></summary><p>{paymentFootnote}</p></details>
      </div>
    </>}
    <Modal isOpen={!!pendingAllowance} onClose={() => setPendingAllowance(null)} title="Подтвердите использование льготы" variant="fullscreen" bodyClassName="matrix-purchase-modal">
      <PurchaseOfferLayout footer={<button type="button" className="matrix-confirm" disabled={locked || !pendingAllowance} onClick={() => void confirm(true)}>{pendingAllowance?.amount ? `Подтвердить и перейти к оплате ${formatRubles(pendingAllowance.amount)}` : 'Подтвердить и записаться'}</button>}>
        <section className="matrix-purchase-benefits"><h2 tabIndex={-1} data-purchase-title>Использование льготы</h2><p>{pendingAllowance ? allowanceText(pendingAllowance) : ''}</p><p>Можно вернуться и выбрать оплату без использования льгот.</p></section>
      </PurchaseOfferLayout>
    </Modal>
    <Modal isOpen={subscriptionOfferOpen} onClose={() => { if (!busy) setSubscriptionOfferOpen(false); }} title="Добавьте подписку" variant="fullscreen" bodyClassName="matrix-purchase-modal">
      <SubscriptionPurchaseOffer choices={subscriptionChoices} offer={purchaseSubscription} option={subscriptionPurchaseOption}
        eventName={eventName || price.name} eventDetails={eventDetails} service={service} gamePaymentScope={gamePaymentScope} groupId={groupId} disabled={locked}
        onSelect={setPurchaseSubscriptionId} onContinue={confirmSubscriptionPurchase} />
    </Modal>
    <Modal isOpen={residencyOfferOpen} onClose={() => setResidencyOfferOpen(false)} title={`Добавь Резидентство ${service === 'training' ? 'к своей тренировке' : service === 'tournament' ? 'к своему турниру' : 'к своей игре'}`} variant="fullscreen" bodyClassName="matrix-purchase-modal">
      <ResidencyPurchaseOffer option={choice} residencyPrice={residencyPrice} referenceAmount={referenceAmount}
        eventName={(eventName || price.name)} eventDetails={eventDetails} service={service} gamePaymentScope={gamePaymentScope} disabled={locked} onContinue={addResidency} />
    </Modal>
    <Modal isOpen={boostOfferOpen} onClose={() => setBoostOfferOpen(false)} title="Добавьте РАбуста" variant="fullscreen" bodyClassName="matrix-purchase-modal">
      <BoostPurchaseOffer option={boostOffer} boostPrice={boostPrice} profile={profile} plan={paymentContext.subscriptionPlan}
        eventDescription={`${(eventName || price.name)} · ${duration} мин${isPersonalGame ? ' · моя доля ¼' : ''}`} disabled={locked || hasBoost || !boostOffer} onContinue={addBoost} />
    </Modal>
    <Modal isOpen={loginOpen && !isAuthenticated} onClose={() => setLoginOpen(false)} title="Вход для записи" variant="dialog"><AuthForm onLogin={() => setLoginOpen(false)} /></Modal>
  </section>;
}
