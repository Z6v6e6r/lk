import { useId, useState } from 'react';
import { Modal } from '../../src/components/UI/Modal';
import { AuthForm } from '../../src/components/auth/AuthForm';
import { useAuth } from './auth';
import { buildPaymentOptions, formatRubles, readMatrixSettings, SERVICES, type PaymentKind, type PaymentOption, type ServiceKind } from './paymentMatrix';
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

const optionNames: Record<PaymentKind, string> = {
  full: 'Полная цена', residency: 'С Резидентством', subscription: 'По подписке', pass: 'По абонементу',
};

export function MatrixPaymentOptions({ service, eventKey, disabled = false, excludesPrivileges = false, durationMinutes }: { service: ServiceKind; eventKey: string; disabled?: boolean; excludesPrivileges?: boolean; durationMinutes?: number }) {
  const params = new URLSearchParams(location.search);
  const settings = readMatrixSettings(params);
  const excludedGroup = service === 'training' && (excludesPrivileges || settings.excludedGroups);
  const duration = durationMinutes ?? SERVICES[service].durationMinutes;
  const options = buildPaymentOptions(service, settings.profile, settings.applicability, { ...settings, excludedGroups: excludedGroup, durationMinutes: duration });
  const available = options.filter(option => option.mode === 'book');
  const [selected, setSelected] = useState<PaymentKind>(available[0]?.kind || 'full');
  const [information, setInformation] = useState<PaymentKind | null>(null);
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

  const title = (option: PaymentOption) => {
    if (option.kind !== 'subscription') return optionNames[option.kind];
    if (option.benefit === 'discount') return `По подписке · скидка ${price.discount}%`;
    if (option.benefit === 'partial-hour') return 'По подписке · 60 минут бесплатно';
    if (option.benefit === 'free-training') return 'По подписке · 1 тренировка в день';
    if (option.benefit === 'free-hour') return 'По подписке · 1 час в день';
    return 'Подписка';
  };
  const detail = (option: PaymentOption) => {
    if (option.reason === 'excluded-group') return option.kind === 'residency' ? 'Резидентство не действует на эту категорию групповых' : 'Подписка не действует на эту категорию групповых';
    if (option.reason === 'training-only') return 'Бесплатная тренировка ещё доступна. Скидки на другие услуги — после использования дневного лимита';
    if (option.reason === 'unknown-duration') return 'Нужно уточнить длительность события';
    if (option.mode === 'unavailable') return option.kind === 'subscription' ? 'Тариф подписки не подходит к этому событию' : 'Нет подходящего абонемента с доступными посещениями';
    if (option.kind === 'full') return 'Разовая запись без привилегий';
    if (option.kind === 'residency') return `Скидка ${price.discount}%${option.mode === 'offer' ? ' · можно оформить Резидентство' : ' · Резидентство уже действует'}`;
    if (option.kind === 'subscription') {
      const prefix = option.mode === 'offer' ? 'Если оформить подходящий тариф. ' : '';
      if (option.benefit === 'discount') return `${prefix}Дневной бесплатный лимит использован. Действует цена со скидкой по подписке`;
      if (option.benefit === 'partial-hour') return `${prefix}${option.freeMinutes} минут включено, за оставшиеся ${option.paidMinutes} минут нужна доплата. Формула уточняется`;
      if (option.benefit === 'free-hour') return `${prefix}Дневной лимит доступен · запись на ${option.freeMinutes} мин. без доплаты`;
      return `${prefix}Дневная бесплатная тренировка доступна · без списания абонемента`;
    }
    return option.mode === 'offer' ? 'Если выбрать подходящий пакет посещений' : 'Осталось 3 посещения · спишется одно';
  };
  const amount = (option: PaymentOption) => option.mode === 'unavailable' ? 'Не действует'
    : option.benefit === 'partial-hour' ? 'Нужен расчёт'
      : option.kind === 'pass' ? '1 посещение' : option.amount === 0 ? 'Бесплатно' : formatRubles(option.amount!);
  const confirmText = choice?.kind === 'subscription' ? choice.benefit === 'discount' ? `Записаться по подписке за ${formatRubles(choice.amount!)}` : 'Записаться по подписке бесплатно'
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

  return <section className="matrix-payment" aria-label={`Способы записи: ${price.name}`} data-service={service} data-event={eventKey}>
    <header className="matrix-payment-heading"><div><h2>{registered ? 'Ваша запись' : 'Выберите способ записи'}</h2><p>{price.name}{Number.isFinite(duration) && duration > 0 ? ` · ${duration} мин` : ''}</p></div>
      {reference && !registered && <div className="matrix-base-price"><span>Полная цена</span><del>{formatRubles(price.price)}</del></div>}
    </header>
    {registered ? <div className="matrix-success" role="status">
      <strong>Вы записаны</strong><p>{submittedOption ? `${title(submittedOption)}${submittedOption.kind === 'pass' ? ' · осталось 2 посещения' : submittedOption.amount != null ? ` · ${amount(submittedOption)}` : ''}` : 'Место за вами. Детали записи доступны в личном кабинете.'}</p>
      <button type="button" onClick={() => { setRegistered(false); setSubmittedOption(null); }}>Отменить запись</button>
    </div> : <>
      {excludedGroup && <p className="matrix-notice">Для этой категории групповых не действуют подписки и Резидентство.</p>}
      {full && <p className="matrix-notice" role="status">Все места заняты. Запись на это событие недоступна.</p>}
      <fieldset className="matrix-options" disabled={busy}>
        <legend className="matrix-sr-only">Способы записи</legend>
        {options.filter(option => option.mode !== 'reference').map(option => {
          const copy = <><span className={`matrix-icon matrix-icon--${option.kind}`}><PaymentIcon kind={option.kind} /></span>
            <span className="matrix-option-copy"><strong>{title(option)}</strong><span>{detail(option)}</span></span>
            <span className="matrix-option-value"><strong>{amount(option)}</strong>{option.mode === 'offer' && <span>Подробнее →</span>}</span></>;
          const classes = `matrix-option matrix-option--${option.kind} ${option.mode === 'book' && choice?.kind === option.kind ? 'is-selected' : ''} ${option.mode === 'unavailable' ? 'is-unavailable' : option.mode === 'quote' ? 'is-quote' : ''}`;
          if (option.mode === 'book') return <label className={classes} key={option.kind}>
            <input type="radio" name={`${groupId}-method`} value={option.kind} checked={choice?.kind === option.kind} disabled={locked} onChange={() => setSelected(option.kind)} />{copy}
          </label>;
          if (option.mode === 'offer') return <button type="button" className={classes} key={option.kind} onClick={() => setInformation(option.kind)} aria-label={`Подробнее: ${title(option)}`}>{copy}</button>;
          return <div className={classes} key={option.kind} aria-disabled="true">{copy}</div>;
        })}
      </fieldset>
      {settings.profile.residency && !excludedGroup && <p className="matrix-resident-perks"><PaymentIcon kind="residency" />По Резидентству: ракетка, полотенце и тапочки бесплатно</p>}
      {options.some(option => option.mode === 'quote') && <p className="matrix-copay-note" role="status">Стоимость доплаты пока не определена. Запись с использованием бесплатного часа станет доступна после расчёта.</p>}
      <button className="matrix-confirm" type="button" disabled={locked || !choice} onClick={() => void confirm()}>{busy ? 'Подтверждаем запись…' : full ? 'Мест нет' : !isAuthenticated ? 'Войти для записи' : confirmText}</button>
      <p className="matrix-payment-footnote">Выбран один способ записи. Скидки подписки и Резидентства не суммируются. Абонемент списывается только при выборе абонемента.</p>
    </>}
    <Modal isOpen={information !== null} onClose={() => setInformation(null)} title={information === 'residency' ? 'Резидентство' : information === 'pass' ? 'Абонемент' : 'Подписка'} variant="dialog">
      <div className="matrix-information">
        {information === 'residency' ? <><h3>{formatRubles(price.residentPrice)} вместо {formatRubles(price.price)}</h3><p>С Резидентством скидка на игры — 30%, на турниры и групповые тренировки — 50%.</p><p>Тапочки, полотенце и ракетка — бесплатно.</p></>
          : information === 'subscription' ? <><h3>Запись по условиям подписки</h3><p>Тариф может включать одну бесплатную тренировку или один бесплатный час в день. После использования дневного лимита действуют скидки по подписке: 30% на игры, 50% на групповые и турниры. Исключённые категории групповых не участвуют. При частичном покрытии часа доплата рассчитывается отдельно.</p></>
            : <><h3>Пакет посещений</h3><p>Выберите абонемент, подходящий к этому событию. Запись списывает одно доступное посещение.</p></>}
        <p className="matrix-information-note">Условия и стоимость оформления уточняются отдельно. Этот вариант не активирует привилегию автоматически.</p>
        <button type="button" className="matrix-confirm" onClick={() => setInformation(null)}>Понятно</button>
      </div>
    </Modal>
    <Modal isOpen={loginOpen && !isAuthenticated} onClose={() => setLoginOpen(false)} title="Вход для записи" variant="dialog"><AuthForm onLogin={() => setLoginOpen(false)} /></Modal>
  </section>;
}
