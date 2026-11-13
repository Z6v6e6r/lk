import { useId, useState } from 'react';
import { Modal } from '../../src/components/UI/Modal';
import { AuthForm } from '../../src/components/auth/AuthForm';
import { useAuth } from './auth';
import { buildBookingPaymentOptions, formatRubles, readMatrixSettings, SERVICES, type GamePaymentScope, type PaymentKind, type PaymentOption, type ServiceKind } from './paymentMatrix';
import { bookingButtonText, combineResidencyBoost, combineSubscriptionBoost, createPreviewOrder, defaultPaymentOption, isSelectableMethod, passBalanceText, readPassRemaining, readResidencyPrice, trainingCount, withPassBalance, withPersonalSubscription, withoutResidencyForSubscribers, type PreviewOrder } from './bookingCheckout';
import { recommendedSubscriptionChoice, subscriptionPurchaseChoices, type SubscriptionOffer } from './subscriptionOffers';
import { SUBSCRIPTION_PLANS } from './privilegeRules';
import { SubscriptionPurchaseOffer } from './SubscriptionPurchaseOffer';
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

export function MatrixPaymentOptions({ service, eventKey, disabled = false, excludesPrivileges = false, durationMinutes, gamePaymentScope, courtAmount = null }: { service: ServiceKind; eventKey: string; disabled?: boolean; excludesPrivileges?: boolean; durationMinutes?: number; gamePaymentScope?: GamePaymentScope; courtAmount?: number | null }) {
  const params = new URLSearchParams(location.search);
  const settings = readMatrixSettings(params);
  const residencyPrice = readResidencyPrice(params);
  const [purchasedResidency, setPurchasedResidency] = useState(false);
  const [purchasedSubscription, setPurchasedSubscription] = useState<SubscriptionOffer | null>(null);
  const [passRemaining, setPassRemaining] = useState(settings.profile.pass ? readPassRemaining(params) : 0);
  const [passVisitDebited, setPassVisitDebited] = useState(false);
  const profile = { ...settings.profile, residency: settings.profile.residency || purchasedResidency,
    subscription: settings.profile.subscription || purchasedSubscription !== null, pass: settings.profile.pass };
  const applicability = { subscription: purchasedSubscription ? true : settings.applicability.subscription, pass: settings.applicability.pass };
  const excludedGroup = service === 'training' && (excludesPrivileges || settings.excludedGroups);
  const duration = durationMinutes ?? SERVICES[service].durationMinutes;
  const paymentContext = { ...settings, subscriptionPlan: purchasedSubscription?.plan || settings.subscriptionPlan, excludedGroups: excludedGroup, durationMinutes: duration };
  const isWholeCourt = service === 'game' && gamePaymentScope === 'court';
  const isPersonalGame = service === 'game' && gamePaymentScope === 'quarter';
  const subscriptionChoices = subscriptionPurchaseChoices(service, paymentContext, gamePaymentScope, courtAmount);
  const recommendedSubscription = recommendedSubscriptionChoice(subscriptionChoices);
  const [purchaseSubscriptionId, setPurchaseSubscriptionId] = useState(recommendedSubscription?.offer.id || '');
  const purchaseSubscriptionChoice = subscriptionChoices.find(choice => choice.offer.id === purchaseSubscriptionId) || recommendedSubscription;
  const purchaseSubscription = purchaseSubscriptionChoice?.offer;
  const subscriptionPurchaseOption = purchaseSubscriptionChoice?.option;
  const rawPaymentOptions = withPassBalance(buildBookingPaymentOptions(service, profile, applicability, paymentContext, gamePaymentScope, courtAmount), passRemaining)
    .flatMap(option => option.kind === 'subscription' && !profile.subscription ? subscriptionPurchaseOption ? [subscriptionPurchaseOption] : [] : [option]);
  const paymentOptions = withoutResidencyForSubscribers(combineResidencyBoost(combineSubscriptionBoost(rawPaymentOptions, profile), profile), profile);
  const options = isPersonalGame ? withPersonalSubscription(paymentOptions, profile.subscription) : paymentOptions;
  const available = options.filter(isSelectableMethod);
  const defaultChoice = defaultPaymentOption(options);
  const [selected, setSelected] = useState<PaymentKind>(defaultChoice?.kind || 'full');
  const [residencyOfferOpen, setResidencyOfferOpen] = useState(false);
  const [checkout, setCheckout] = useState<PreviewOrder | null>(null);
  const [checkoutOption, setCheckoutOption] = useState<PaymentOption | null>(null);
  const [checkoutSubscription, setCheckoutSubscription] = useState<SubscriptionOffer | null>(null);
  const [paidOrder, setPaidOrder] = useState<PreviewOrder | null>(null);
  const [subscriptionOfferOpen, setSubscriptionOfferOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [registered, setRegistered] = useState(params.get('state') === 'registered');
  const [busy, setBusy] = useState(false);
  const [submittedOption, setSubmittedOption] = useState<PaymentOption | null>(null);
  const { isAuthenticated } = useAuth();
  const groupId = useId();
  const price = SERVICES[service];
  const full = params.get('state') === 'full';
  const combinedSubscription = available.find(option => option.withSubscription);
  const selectedKind = (selected === 'boost' || selected === 'subscription') && combinedSubscription ? combinedSubscription.kind : selected;
  const choice = available.find(option => option.kind === selectedKind) || defaultChoice;
  const locked = disabled || full || busy;
  const displayBaseAmount = options.find(option => option.kind === 'full')?.amount ?? price.price;
  const displayResidencyAmount = options.find(option => option.kind === 'residency')?.amount ?? price.residentPrice;
  const referenceAmount = options.find(option => option.kind === 'full')?.amount ?? null;
  const subscriptionOrder = subscriptionPurchaseOption && purchaseSubscription ? createPreviewOrder(subscriptionPurchaseOption, null, purchaseSubscription.price) : null;
  const startCheckout = (order: PreviewOrder, option: PaymentOption, subscription: SubscriptionOffer | null = null) => {
    setCheckout(order); setCheckoutOption(option); setCheckoutSubscription(subscription);
  };

  const title = (option: PaymentOption) => {
    if (option.withResidency) return `С Резидентством и РАбуста${option.amount === 0 ? ' — бесплатно' : ''}`;
    if (option.withSubscription) return `По подписке и РАбуста${option.amount === 0 ? ' — бесплатно' : ''}`;
    if (option.kind === 'boost') return option.amount === 0 ? 'С Бустом — бесплатно' : option.benefit === 'partial-hour' ? `С Бустом · ${option.freeMinutes} минут бесплатно` : `С Бустом · скидка ${price.discount}%`;
    if (isWholeCourt && option.kind === 'full') return 'Полная оплата за 4 игроков';
    if (isPersonalGame && option.kind === 'full') return 'Моя доля · ¼ стоимости';
    if (isPersonalGame && profile.subscription && option.kind === 'subscription' && option.mode === 'book') return 'Моя доля · по подписке';
    if (option.kind !== 'subscription') return optionNames[option.kind];
    if (option.mode === 'offer' && option.amount === 0) return 'По подписке — бесплатно';
    if (option.benefit === 'free-event') return `По подписке ${option.subscriptionPlan === 'friendship-2' ? 'Дружба 2.0' : 'РА'} — бесплатно`;
    if (option.benefit === 'discount') return `По подписке · скидка ${price.discount}%`;
    if (option.benefit === 'partial-hour') return `По подписке · ${option.freeMinutes} минут бесплатно`;
    if (!profile.subscription && !excludedGroup) return 'Бесплатно при наличии подписки';
    if (option.benefit === 'free-training') return 'По подписке · 1 тренировка в день';
    if (option.benefit === 'free-hour') return `По подписке · ${option.subscriptionPlan === 'friendship-2' ? '2 часа' : '1 час'} в день`;
    return 'Подписка';
  };
  const detail = (option: PaymentOption) => {
    if (option.reason === 'excluded-group') return option.kind === 'residency' ? 'Резидентство не действует на эту категорию групповых' : 'Подписка не действует на эту категорию групповых';
    if (option.reason === 'training-only') return option.mode === 'offer' ? 'Выберите подходящую подписку для записи на это событие' : 'Бесплатная тренировка ещё доступна. Скидки на другие услуги — после использования дневного лимита';
    if (option.reason === 'unknown-price') return 'Стоимость корта уточняется';
    if (option.reason === 'unknown-duration') return 'Нужно уточнить длительность события';
    if (option.mode === 'unavailable') return option.kind === 'subscription' ? 'Тариф подписки не подходит к этому событию' : 'Нет подходящего абонемента с доступными посещениями';
    if (option.kind === 'full') return isWholeCourt ? 'Оплата всего корта без применения льгот' : isPersonalGame ? 'Оплачиваете только своё участие, остальные игроки — своё' : 'Разовая запись без привилегий';
    if (option.kind === 'residency') return option.mode === 'offer' ? `Скидка ${price.discount}% при оформлении Резидентства` : `Скидка ${price.discount}%`;
    if (option.withResidency && (option.benefit === 'free-hour' || option.benefit === 'free-event')) return 'Дневной лимит РАбуста доступен';
    if (option.withSubscription && (option.benefit === 'free-hour' || option.benefit === 'free-event')) return SUBSCRIPTION_PLANS.find(plan => plan.id === paymentContext.subscriptionPlan)?.name || 'Подписка';
    if (option.kind === 'subscription' && option.mode === 'offer' && option.amount === 0) return purchaseSubscription?.name || 'Подписка';
    if (option.kind === 'subscription' || option.kind === 'boost') {
      const prefix = option.mode === 'offer' ? `При оформлении подписки ${purchaseSubscription?.name || 'подходящего тарифа'}. ` : '';
      const source = option.kind === 'boost' ? 'Буст' : option.subscriptionPlan === 'friendship-2' ? 'Дружбу 2.0' : 'РА';
      if (option.benefit === 'free-event') return `${prefix}Занятие входит в ${source} · без доплаты за участие${paymentContext.proDirection ? ' · ПРО: 1 событие в день' : ''}`;
      if (option.benefit === 'discount') return `${prefix}${option.reason === 'active-limit' ? 'Больше 8 активных записей. ' : paymentContext.dailyQuota === 'used' ? 'Дневной бесплатный лимит использован. ' : ''}Скидка ${price.discount}% на запись`;
      if (option.benefit === 'partial-hour') return `${prefix}${option.freeMinutes} минут бесплатно · ${option.amount != null ? `доплата за ${option.paidMinutes} минут — ${formatRubles(option.amount)}` : `за оставшиеся ${option.paidMinutes} минут нужна доплата. Формула уточняется`}${option.overtimeDiscount ? ' · на доплату действует скидка 30%' : ''}`;
      if (option.benefit === 'free-hour') return `${prefix}Дневной лимит доступен · запись на ${option.freeMinutes} мин. без доплаты${option.kind === 'boost' ? ' · с Бустом' : ''}`;
      return `${prefix}Дневная бесплатная тренировка доступна · без списания абонемента`;
    }
    return `${passBalanceText(passRemaining)} · спишется 1 тренировка`;
  };
  const amount = (option: PaymentOption) => option.reason === 'unknown-price' ? 'Нужен расчёт' : option.mode === 'unavailable' ? 'Не действует'
    : option.reason === 'training-only' ? 'Выбрать тариф'
    : option.benefit === 'partial-hour' && option.amount == null ? 'Нужен расчёт'
      : option.kind === 'pass' ? trainingCount(passRemaining) : option.amount === 0 ? 'Бесплатно' : formatRubles(option.amount!);
  const confirmText = bookingButtonText(choice);
  const confirm = async () => {
    if (locked || !choice || registered) return;
    if (!isAuthenticated) { setLoginOpen(true); return; }
    if (choice.mode === 'offer') {
      if (choice.kind === 'residency') setResidencyOfferOpen(true);
      else if (choice.kind === 'subscription') setSubscriptionOfferOpen(true);
      return;
    }
    const order = createPreviewOrder(choice);
    if (!order) return;
    if (order.total > 0) { startCheckout(order, choice); return; }
    if (choice.kind === 'pass' && passRemaining <= 0) return;
    setBusy(true);
    // Local interaction only: no payment API, booking write or real debit.
    await new Promise(resolve => setTimeout(resolve, 300));
    setSubmittedOption(choice);
    if (choice.kind === 'pass') { setPassRemaining(value => value - 1); setPassVisitDebited(true); }
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
  const completePayment = async () => {
    if (locked || !checkout || !checkoutOption || registered || !isAuthenticated || (checkout.product === 'subscription' && !checkoutSubscription)) return;
    setBusy(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    setPaidOrder(checkout);
    setSubmittedOption(checkoutOption);
    if (checkout.product === 'subscription') setPurchasedSubscription(checkoutSubscription);
    if (checkout.product === 'residency') setPurchasedResidency(true);
    setCheckout(null);
    setRegistered(true);
    setBusy(false);
  };

  return <section className="matrix-payment" aria-label={`Способы записи: ${price.name}`} data-service={service} data-event={eventKey}>
    <header className="matrix-payment-heading"><div><h2>{registered ? 'Ваша запись' : checkout ? 'Оплата записи' : 'Выберите способ записи'}</h2><p>{price.name}{isPersonalGame ? ' · моя доля ¼' : isWholeCourt ? ' · плачу за всех' : ''}{Number.isFinite(duration) && duration > 0 ? ` · ${duration} мин` : ''}{service !== 'game' && paymentContext.proDirection ? ' · ПРО' : ''}{service === 'tournament' && paymentContext.friendsTournament ? ' · Время на друзей' : ''}</p></div>
    </header>
    {registered ? <div className="matrix-success" role="status">
      <strong>Вы записаны</strong><p>{submittedOption?.kind === 'pass' ? `Энергия 5 · списана 1 тренировка · ${passBalanceText(passRemaining)}` : submittedOption ? `${title(submittedOption)}${submittedOption.amount != null ? ` · ${amount(submittedOption)}` : ''}` : 'Место за вами. Детали записи доступны в личном кабинете.'}</p>
      {paidOrder && <p>Оплачено {formatRubles(paidOrder.total)}{paidOrder.product === 'residency' ? ` · запись ${formatRubles(paidOrder.bookingAmount)} + Резидентство ${formatRubles(paidOrder.productAmount)}` : ''}</p>}
      <button type="button" onClick={() => { if (passVisitDebited) setPassRemaining(value => Math.min(5, value + 1)); setPassVisitDebited(false); setRegistered(false); setSubmittedOption(null); setPaidOrder(null); }}>Отменить запись</button>
    </div> : checkout ? <div className="matrix-checkout" aria-label="Оплата выбранного варианта">
      <dl className="matrix-order-lines"><div><dt>{price.name}</dt><dd>{formatRubles(checkout.bookingAmount)}</dd></div>
        {checkout.product && <div><dt>{checkout.product === 'residency' ? 'Резидентство' : `Подписка ${checkoutSubscription?.name || ''}`}</dt><dd>{formatRubles(checkout.productAmount)}</dd></div>}
        <div className="matrix-order-total"><dt>Итого к оплате</dt><dd>{formatRubles(checkout.total)}</dd></div></dl>
      <button type="button" className="matrix-confirm" disabled={locked} onClick={() => void completePayment()}>{busy ? 'Подтверждаем оплату…' : `Оплатить ${formatRubles(checkout.total)}`}</button>
      <button type="button" className="matrix-back" disabled={busy} onClick={() => setCheckout(null)}>Вернуться к выбору оплаты</button>
    </div> : <>
      {isWholeCourt && <p className="matrix-notice">Полная оплата корта: подписка, Резидентство и абонементы не применяются.</p>}
      {full && <p className="matrix-notice" role="status">Все места заняты. Запись на это событие недоступна.</p>}
      <fieldset className="matrix-options" disabled={busy}>
        <legend className="matrix-sr-only">Способы записи</legend>
        {options.filter(option => option.mode !== 'reference' && option.mode !== 'unavailable').map(option => {
          const displayKind = option.withResidency ? 'residency' : option.withSubscription ? 'subscription' : option.kind;
          const showBasePrice = (option.kind === 'residency' || option.kind === 'subscription' || option.kind === 'boost')
            && referenceAmount != null && option.amount != null && option.amount >= 0 && option.amount < referenceAmount;
          const copy = <><span className={`matrix-icon matrix-icon--${displayKind}`}><PaymentIcon kind={displayKind} /></span>
            <span className="matrix-option-copy"><strong>{title(option)}</strong><span>{detail(option)}</span></span>
            <span className="matrix-option-value">{showBasePrice && <span className="matrix-base-price matrix-option-base-price"><span>Полная цена</span><del>{formatRubles(referenceAmount!)}</del></span>}<strong>{amount(option)}</strong></span></>;
          const classes = `matrix-option matrix-option--${displayKind} ${choice?.kind === option.kind ? 'is-selected' : ''} ${option.mode === 'quote' ? 'is-quote' : ''}`;
          if (isSelectableMethod(option)) return <label className={classes} key={option.kind}>
            <input type="radio" name={`${groupId}-method`} value={option.kind} checked={choice?.kind === option.kind} disabled={locked} onChange={() => setSelected(option.kind)} />{copy}
          </label>;
          return <div className={classes} key={option.kind} aria-disabled="true">{copy}</div>;
        })}
      </fieldset>
      {options.some(option => option.benefit === 'partial-hour' && option.mode === 'quote') && <p className="matrix-copay-note" role="status">Стоимость доплаты пока не определена. Запись с использованием бесплатного часа станет доступна после расчёта.</p>}
      <button className="matrix-confirm" type="button" disabled={locked || !choice} onClick={() => void confirm()}>{busy ? 'Подтверждаем запись…' : full ? 'Мест нет' : !isAuthenticated ? 'Войти для записи' : confirmText}</button>
      <p className="matrix-payment-footnote">{isWholeCourt ? 'Стоимость оплачивается полностью за всех игроков. Льготы не расходуются.' : 'Выбран один способ записи. Скидки подписки и Резидентства не суммируются. Абонемент списывается только при выборе абонемента.'}</p>
    </>}
    <Modal isOpen={subscriptionOfferOpen} onClose={() => { if (!busy) setSubscriptionOfferOpen(false); }} title="Добавьте подписку" variant="fullscreen" bodyClassName="matrix-subscription-modal">
      <SubscriptionPurchaseOffer choices={subscriptionChoices} offer={purchaseSubscription} option={subscriptionPurchaseOption}
        eventDescription={`${price.name} · ${duration} мин${isPersonalGame ? ' · моя доля ¼' : ''}`} groupId={groupId} disabled={locked}
        onSelect={setPurchaseSubscriptionId} onContinue={confirmSubscriptionPurchase} />
    </Modal>
    <Modal isOpen={residencyOfferOpen} onClose={() => setResidencyOfferOpen(false)} title="Добавьте Резидентство" variant="dialog">
      <div className="matrix-information">
        <h3>{formatRubles(displayResidencyAmount)} вместо <del>{formatRubles(displayBaseAmount)}</del></h3>
        <p>Скидка 30% на игры и 50% на групповые тренировки и турниры.</p>
        <dl className="matrix-order-lines"><div><dt>Запись с Резидентством</dt><dd>{formatRubles(displayResidencyAmount)}</dd></div>
          <div><dt>Резидентство</dt><dd>{residencyPrice != null ? formatRubles(residencyPrice) : 'Цена уточняется'}</dd></div>
          {choice && createPreviewOrder(choice, residencyPrice) && <div className="matrix-order-total"><dt>Итого</dt><dd>{formatRubles(createPreviewOrder(choice, residencyPrice)!.total)}</dd></div>}</dl>
        <button type="button" className="matrix-confirm" disabled={locked || residencyPrice == null} onClick={addResidency}>{residencyPrice != null ? `Добавить Резидентство за ${formatRubles(residencyPrice)}` : 'Стоимость Резидентства уточняется'}</button>
      </div>
    </Modal>
    <Modal isOpen={loginOpen && !isAuthenticated} onClose={() => setLoginOpen(false)} title="Вход для записи" variant="dialog"><AuthForm onLogin={() => setLoginOpen(false)} /></Modal>
  </section>;
}
