import { useId, useState } from 'react';
import { Modal } from '../../src/components/UI/Modal';
import { AuthForm } from '../../src/components/auth/AuthForm';
import { useAuth } from './auth';
import { buildBookingPaymentOptions, formatRubles, readMatrixSettings, SERVICES, type GamePaymentScope, type PaymentKind, type PaymentOption, type ServiceKind, type SubscriptionPlan } from './paymentMatrix';
import './matrix.css';

function PaymentIcon({ kind }: { kind: PaymentKind }) {
  const paths: Record<PaymentKind, string> = {
    full: 'M3 4h8l10 10-7 7L3 10V4Zm4 3h.01',
    residency: 'm3 7 5 4 4-7 4 7 5-4-2 12H5L3 7ZM5 22h14',
    subscription: 'm3 7 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 17l9 5 9-5',
    pass: 'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Zm9 0v3m0 3v2m0 3v3',
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]} /></svg>;
}

const ENERGY_PASS_PRICE = 19800;

const optionNames: Record<PaymentKind, string> = {
  full: 'Полная цена', residency: 'С Резидентством', subscription: 'По подписке', pass: 'По абонементу Энергия 5',
};

export function MatrixPaymentOptions({ service, eventKey, disabled = false, excludesPrivileges = false, durationMinutes, gamePaymentScope, courtAmount = null }: { service: ServiceKind; eventKey: string; disabled?: boolean; excludesPrivileges?: boolean; durationMinutes?: number; gamePaymentScope?: GamePaymentScope; courtAmount?: number | null }) {
  const params = new URLSearchParams(location.search);
  const settings = readMatrixSettings(params);
  const excludedGroup = service === 'training' && (excludesPrivileges || settings.excludedGroups);
  const duration = durationMinutes ?? SERVICES[service].durationMinutes;
  const paymentContext = { ...settings, excludedGroups: excludedGroup, durationMinutes: duration };
  const isWholeCourt = service === 'game' && gamePaymentScope === 'court';
  const isPersonalGame = service === 'game' && gamePaymentScope === 'quarter';
  const options = buildBookingPaymentOptions(service, settings.profile, settings.applicability, paymentContext, gamePaymentScope, courtAmount);
  const available = options.filter(option => option.mode === 'book');
  const [selected, setSelected] = useState<PaymentKind>(available[0]?.kind || 'full');
  const [information, setInformation] = useState<PaymentKind | null>(null);
  const [purchase, setPurchase] = useState<'subscription' | 'pass' | null>(null);
  const [purchasePlan, setPurchasePlan] = useState<SubscriptionPlan>(settings.subscriptionPlan);
  const [submittedPurchase, setSubmittedPurchase] = useState<'pass' | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [registered, setRegistered] = useState(params.get('state') === 'registered');
  const [busy, setBusy] = useState(false);
  const [submittedOption, setSubmittedOption] = useState<PaymentOption | null>(null);
  const { isAuthenticated } = useAuth();
  const groupId = useId();
  const price = SERVICES[service];
  const full = params.get('state') === 'full';
  const choice = available.find(option => option.kind === selected) || available[0];
  const reference = options.find(option => option.mode === 'reference');
  const locked = disabled || full || busy;
  const displayBaseAmount = options.find(option => option.kind === 'full')?.amount ?? price.price;
  const displayResidencyAmount = options.find(option => option.kind === 'residency')?.amount ?? price.residentPrice;
  const referenceAmount = reference?.amount ?? displayBaseAmount;
  const purchaseOption = options.find(option => option.kind === purchase);
  const subscriptionPurchaseOption = buildBookingPaymentOptions(service, settings.profile, settings.applicability,
    { ...paymentContext, subscriptionPlan: purchasePlan }, gamePaymentScope, courtAmount).find(option => option.kind === 'subscription');
  const openPurchase = (kind: 'subscription' | 'pass') => { setPurchasePlan(settings.subscriptionPlan); setPurchase(kind); };

  const title = (option: PaymentOption) => {
    if (isWholeCourt && option.kind === 'full') return 'Полная оплата за 4 игроков';
    if (isPersonalGame && option.kind === 'full') return 'Моя доля · ¼ стоимости';
    if (option.kind !== 'subscription') return optionNames[option.kind];
    if (option.benefit === 'discount') return `По подписке · скидка ${price.discount}%`;
    if (option.benefit === 'partial-hour') return 'По подписке · 60 минут бесплатно';
    if (!settings.profile.subscription && !excludedGroup) return 'Бесплатно при наличии подписки';
    if (option.benefit === 'free-training') return 'По подписке · 1 тренировка в день';
    if (option.benefit === 'free-hour') return 'По подписке · 1 час в день';
    return 'Подписка';
  };
  const detail = (option: PaymentOption) => {
    if (option.reason === 'excluded-group') return option.kind === 'residency' ? 'Резидентство не действует на эту категорию групповых' : 'Подписка не действует на эту категорию групповых';
    if (option.reason === 'training-only') return option.mode === 'offer' ? 'Выберите подходящую подписку для записи на это событие' : 'Бесплатная тренировка ещё доступна. Скидки на другие услуги — после использования дневного лимита';
    if (option.reason === 'unknown-price') return 'Стоимость корта уточняется';
    if (option.reason === 'unknown-duration') return 'Нужно уточнить длительность события';
    if (option.mode === 'unavailable') return option.kind === 'subscription' ? 'Тариф подписки не подходит к этому событию' : 'Нет подходящего абонемента с доступными посещениями';
    if (option.kind === 'full') return isWholeCourt ? 'Оплата всего корта без применения льгот' : isPersonalGame ? 'Оплачиваете только своё участие, остальные игроки — своё' : 'Разовая запись без привилегий';
    if (option.kind === 'residency') return `Скидка ${price.discount}%${option.mode === 'offer' ? ' · можно оформить Резидентство' : ' · Резидентство уже действует'}`;
    if (option.kind === 'subscription') {
      const prefix = option.mode === 'offer' ? 'Если оформить подходящий тариф. ' : '';
      if (option.benefit === 'discount') return `${prefix}Дневной бесплатный лимит использован. Действует цена со скидкой по подписке`;
      if (option.benefit === 'partial-hour') return `${prefix}${option.freeMinutes} минут бесплатно · ${option.amount != null ? `доплата за ${option.paidMinutes} минут — ${formatRubles(option.amount)}` : `за оставшиеся ${option.paidMinutes} минут нужна доплата. Формула уточняется`}`;
      if (option.benefit === 'free-hour') return `${prefix}Дневной лимит доступен · запись на ${option.freeMinutes} мин. без доплаты`;
      return `${prefix}Дневная бесплатная тренировка доступна · без списания абонемента`;
    }
    return option.mode === 'offer' ? 'Пакет из 5 посещений · для записи нужен подходящий абонемент' : 'Осталось 3 посещения · спишется одно';
  };
  const amount = (option: PaymentOption) => option.reason === 'unknown-price' ? 'Нужен расчёт' : option.mode === 'unavailable' ? 'Не действует'
    : option.reason === 'training-only' ? 'Выбрать тариф'
    : option.benefit === 'partial-hour' && option.amount == null ? 'Нужен расчёт'
      : option.kind === 'pass' ? option.mode === 'offer' ? formatRubles(ENERGY_PASS_PRICE) : '1 посещение' : option.amount === 0 ? 'Бесплатно' : formatRubles(option.amount!);
  const confirmText = !choice ? 'Стоимость уточняется' : isWholeCourt ? `Оплатить весь корт · ${choice?.amount != null ? formatRubles(choice.amount) : 'цена уточняется'}` : choice?.kind === 'subscription' ? choice.benefit === 'partial-hour' ? `Записаться с доплатой ${formatRubles(choice.amount!)}` : choice.amount != null && choice.amount > 0 ? `Записаться по подписке за ${formatRubles(choice.amount)}` : 'Записаться по подписке бесплатно'
    : choice?.kind === 'pass' ? 'Списать 1 посещение и записаться'
      : `Записаться за ${formatRubles(choice?.amount || price.price)}`;
  const confirm = async () => {
    if (locked || !choice || registered) return;
    if (!isAuthenticated) { setLoginOpen(true); return; }
    setBusy(true);
    // Local interaction only: no payment API, booking write or real debit.
    await new Promise(resolve => setTimeout(resolve, 300));
    setSubmittedOption(choice);
    setRegistered(true);
    setBusy(false);
  };
  const confirmPassPurchase = async () => {
    if (locked || registered || purchaseOption?.kind !== 'pass' || purchaseOption.mode !== 'offer') return;
    if (!isAuthenticated) { setLoginOpen(true); return; }
    setBusy(true);
    // Purchase + first visit are simulated in component state only.
    await new Promise(resolve => setTimeout(resolve, 300));
    setSubmittedPurchase('pass');
    setSubmittedOption(purchaseOption);
    setRegistered(true);
    setPurchase(null);
    setBusy(false);
  };

  return <section className="matrix-payment" aria-label={`Способы записи: ${price.name}`} data-service={service} data-event={eventKey}>
    <header className="matrix-payment-heading"><div><h2>{registered ? 'Ваша запись' : 'Выберите способ записи'}</h2><p>{price.name}{isPersonalGame ? ' · моя доля ¼' : isWholeCourt ? ' · плачу за всех' : ''}{Number.isFinite(duration) && duration > 0 ? ` · ${duration} мин` : ''}</p></div>
      {reference && !registered && <div className="matrix-base-price"><span>Полная цена</span><del>{formatRubles(referenceAmount)}</del></div>}
    </header>
    {registered ? <div className="matrix-success" role="status">
      <strong>Вы записаны</strong><p>{submittedPurchase === 'pass' ? `Энергия 5 оформлен за ${formatRubles(ENERGY_PASS_PRICE)} · использовано 1 из 5 посещений · осталось 4` : submittedOption ? `${title(submittedOption)}${submittedOption.kind === 'pass' ? ' · осталось 2 посещения' : submittedOption.amount != null ? ` · ${amount(submittedOption)}` : ''}` : 'Место за вами. Детали записи доступны в личном кабинете.'}</p>
      <button type="button" onClick={() => { setRegistered(false); setSubmittedOption(null); setSubmittedPurchase(null); }}>Отменить запись</button>
    </div> : <>
      {isWholeCourt && <p className="matrix-notice">Полная оплата корта: подписка, Резидентство и абонементы не применяются.</p>}
      {excludedGroup && <p className="matrix-notice">Для этой категории групповых не действуют подписки и Резидентство.</p>}
      {full && <p className="matrix-notice" role="status">Все места заняты. Запись на это событие недоступна.</p>}
      <fieldset className="matrix-options" disabled={busy}>
        <legend className="matrix-sr-only">Способы записи</legend>
        {options.filter(option => option.mode !== 'reference').map(option => {
          const copy = <><span className={`matrix-icon matrix-icon--${option.kind}`}><PaymentIcon kind={option.kind} /></span>
            <span className="matrix-option-copy"><strong>{title(option)}</strong><span>{detail(option)}</span></span>
            <span className="matrix-option-value"><strong>{amount(option)}</strong>{option.mode === 'offer' && <span>{option.kind === 'subscription' || option.kind === 'pass' ? 'Купить и записаться →' : 'Подробнее →'}</span>}</span></>;
          const classes = `matrix-option matrix-option--${option.kind} ${option.mode === 'book' && choice?.kind === option.kind ? 'is-selected' : ''} ${option.mode === 'unavailable' ? 'is-unavailable' : option.mode === 'quote' ? 'is-quote' : ''}`;
          if (option.mode === 'book') return <label className={classes} key={option.kind}>
            <input type="radio" name={`${groupId}-method`} value={option.kind} checked={choice?.kind === option.kind} disabled={locked} onChange={() => setSelected(option.kind)} />{copy}
          </label>;
          if (option.mode === 'offer') return <button type="button" className={classes} key={option.kind} disabled={locked} onClick={() => option.kind === 'subscription' || option.kind === 'pass' ? openPurchase(option.kind) : setInformation(option.kind)} aria-label={`${option.kind === 'subscription' || option.kind === 'pass' ? 'Запись с покупкой' : 'Подробнее'}: ${title(option)}${option.kind === 'pass' ? ` — ${formatRubles(ENERGY_PASS_PRICE)}` : ''}`}>{copy}</button>;
          return <div className={classes} key={option.kind} aria-disabled="true">{copy}</div>;
        })}
      </fieldset>
      {settings.profile.residency && !excludedGroup && !isWholeCourt && <p className="matrix-resident-perks"><PaymentIcon kind="residency" />По Резидентству: ракетка, полотенце и тапочки бесплатно</p>}
      {options.some(option => option.benefit === 'partial-hour' && option.mode === 'quote') && <p className="matrix-copay-note" role="status">Стоимость доплаты пока не определена. Запись с использованием бесплатного часа станет доступна после расчёта.</p>}
      <button className="matrix-confirm" type="button" disabled={locked || !choice} onClick={() => void confirm()}>{busy ? 'Подтверждаем запись…' : full ? 'Мест нет' : !isAuthenticated ? 'Войти для записи' : confirmText}</button>
      <p className="matrix-payment-footnote">{isWholeCourt ? 'Стоимость оплачивается полностью за всех игроков. Льготы не расходуются.' : 'Выбран один способ записи. Скидки подписки и Резидентства не суммируются. Абонемент списывается только при выборе абонемента.'}</p>
    </>}
    <Modal isOpen={purchase !== null} onClose={() => { if (!busy) setPurchase(null); }} title={purchase === 'pass' ? 'Запись с покупкой абонемента' : 'Запись с покупкой подписки'} variant="dialog">
      <div className="matrix-information">
        <h3>{purchase === 'pass' ? `Энергия 5 — ${formatRubles(ENERGY_PASS_PRICE)}` : 'Выберите подписку для записи'}</h3>
        <p>{price.name} · {duration} мин{isPersonalGame ? ' · моя доля ¼' : ''}</p>
        {purchase === 'pass' ? <><p>Пакет из 5 посещений. Первое посещение используется для этой записи, останется 4.</p><p><strong>К оплате: {formatRubles(ENERGY_PASS_PRICE)}</strong><br />Запись включена в стоимость абонемента.</p>
          <button type="button" className="matrix-confirm" disabled={locked || purchaseOption?.mode !== 'offer'} onClick={() => void confirmPassPurchase()}>{busy ? 'Оформляем…' : isAuthenticated ? `Купить за ${formatRubles(ENERGY_PASS_PRICE)} и записаться` : 'Войти для оформления'}</button></>
          : <><label className="matrix-product-plan">Тариф подписки<select value={purchasePlan} onChange={event => setPurchasePlan(event.target.value as SubscriptionPlan)}><option value="daily-hour">1 бесплатный час в день</option><option value="daily-training">1 бесплатная тренировка в день</option></select></label>{subscriptionPurchaseOption && <p>{detail(subscriptionPurchaseOption)}</p>}
            <p><strong>Стоимость подписки уточняется</strong>{subscriptionPurchaseOption?.amount != null && <><br />За участие: {amount(subscriptionPurchaseOption)}</>}</p>
            <p>После выбора подписки с ценой здесь появится общая сумма покупки и записи.</p>
            <button type="button" className="matrix-confirm" disabled>Для продолжения нужна цена подписки</button></>}
      </div>
    </Modal>
    <Modal isOpen={information !== null} onClose={() => setInformation(null)} title={information === 'residency' ? 'Резидентство' : information === 'pass' ? 'Абонемент Энергия 5' : 'Подписка'} variant="dialog">
      <div className="matrix-information">
        {information === 'residency' ? <><h3>{formatRubles(displayResidencyAmount)} вместо {formatRubles(displayBaseAmount)}</h3><p>С Резидентством скидка на игры — 30%, на турниры и групповые тренировки — 50%.</p><p>Тапочки, полотенце и ракетка — бесплатно.</p></>
          : information === 'subscription' ? <><h3>Запись по условиям подписки</h3>{isPersonalGame && options.find(option => option.kind === 'subscription' && option.amount != null) && <p>{detail(options.find(option => option.kind === 'subscription')!)}</p>}<p>Тариф может включать одну бесплатную тренировку или один бесплатный час в день. После использования дневного лимита действуют скидки по подписке: 30% на игры, 50% на групповые и турниры. Исключённые категории групповых не участвуют. При частичном покрытии часа доплата рассчитывается отдельно.</p></>
            : <><h3>Энергия 5 — {formatRubles(ENERGY_PASS_PRICE)}</h3><p>Пакет из 5 посещений. Запись на подходящее событие списывает одно доступное посещение. Это стоимость всего абонемента, а не одной записи.</p></>}
        <p className="matrix-information-note">{information === 'pass' ? 'Абонемент применяется только к подходящим событиям. Покупка абонемента и запись на событие — отдельные действия.' : 'Условия и стоимость оформления уточняются отдельно. Этот вариант не активирует привилегию автоматически.'}</p>
        <button type="button" className="matrix-confirm" onClick={() => setInformation(null)}>Понятно</button>
      </div>
    </Modal>
    <Modal isOpen={loginOpen && !isAuthenticated} onClose={() => setLoginOpen(false)} title="Вход для записи" variant="dialog"><AuthForm onLogin={() => setLoginOpen(false)} /></Modal>
  </section>;
}
