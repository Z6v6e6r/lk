import './event-community.css';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { eventRetentionUntil } from '../../services/community-policy';
import type { EventNotice, EventRegistration } from '../../utils/communityApi';

/** Accepts +7/8 and bare 10-digit RU numbers; returns the canonical 7XXXXXXXXXX form. */
export function normalizeEventPhone(value: string): string | null {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) return '7' + digits.slice(1);
  if (digits.length === 10 && digits.startsWith('9')) return '7' + digits;
  return null;
}

const PHONE_ERROR = 'Укажите телефон в формате +7 (999) 000-00-00.';

export function EventRegistrationForm({ onSubmit, onCancel, notice }: {
  onSubmit: (value: EventRegistration) => Promise<string | null>;
  onCancel: () => void;
  notice?: EventNotice;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pushOptIn, setPushOptIn] = useState(false);
  const perpetual = notice?.retentionMode === 'submitted-year-v1';
  const available = !!notice && (perpetual || Date.now() < Date.parse(notice.policy.endsAt));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!available || !notice) return;
    const data = new FormData(event.currentTarget);
    const fullName = String(data.get('fullName') || '').trim();
    const company = String(data.get('company') || '').trim();
    const email = String(data.get('email') || '').trim();
    const phone = perpetual ? normalizeEventPhone(String(data.get('phone') || '')) : null;
    if (fullName.split(/\s+/).length < 2) { setError('Укажите фамилию, имя и отчество (при наличии).'); return; }
    if (perpetual && !phone) { setError(PHONE_ERROR); return; }
    const value: EventRegistration = {
      fullName,
      company,
      email,
      policyRevision: notice.revision,
      ...(perpetual ? { retentionMode: notice.retentionMode, ...(phone ? { phone } : {}), pushOptIn } : {}),
    };
    setBusy(true); setError(null);
    try { setError(await onSubmit(value)); }
    catch { setError('Не удалось сохранить анкету. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };
  if (!available || !notice) return <div className="community-event-registration"><p role="status">Регистрация пока закрыта или мероприятие завершено. Обратитесь к организатору.</p><button type="button" className="btn-secondary" onClick={onCancel}>Закрыть</button></div>;
  if (perpetual) return <form className="community-form community-event-registration community-event-registration--exhibition" onSubmit={event => void submit(event)}>
    <p className="community-event-registration__lead">Заполните, пожалуйста, Ваши данные: мы пришлём Вам персональную презентацию, пригласим на командную тренировку и разыграем среди участников 3 месячных подписки, которые позволяют играть и тренироваться хоть каждый день.</p>
    <label className="form-label">ФИО<input autoFocus className="form-input" name="fullName" autoComplete="name" required maxLength={160} /></label>
    <label className="form-label">Компания<input className="form-input" name="company" autoComplete="organization" required maxLength={160} /></label>
    <label className="form-label">Телефон<input className="form-input" name="phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={32} placeholder="+7 (999) 000-00-00" /></label>
    <label className="form-label">Электронная почта<input className="form-input" name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    <label className="community-event-registration__optin"><input type="checkbox" name="pushOptIn" checked={pushOptIn} onChange={event => setPushOptIn(event.target.checked)} /><span>Оповестить меня о результатах</span></label>
    <details className="community-event-registration__legal"><summary>Правовая информация</summary>
      <p>Анкета используется для регистрации в сообществе и связи по мероприятию. Хранение — один календарный год с момента отправки анкеты. Ответственный: {notice.policy.responsibleName}. Обращения и удаление: <a href={'mailto:' + notice.policy.contactEmail}>{notice.policy.contactEmail}</a>. <a href="https://padlhub.ru/politica" target="_blank" rel="noopener noreferrer">Политика обработки персональных данных</a>.</p>
    </details>
    {error && <p role="alert" className="community-form-error">{error}</p>}
    <div className="form-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button><button className="btn-primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Вступить'}</button></div>
  </form>;
  const format = (value: string) => new Date(value).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'});
  return <form className="community-form community-event-registration" onSubmit={event => void submit(event)}>
    <p>{perpetual ? 'Для вступления в сообщество заполните анкету.' : 'Для участия в мероприятии заполните анкету.'} ФИО, компания и email не публикуются в рейтинге.</p>
    <p>Анкета используется {perpetual ? 'для регистрации в сообществе.' : 'для регистрации и организации участия в мероприятии.'} Ответственный: {notice.policy.responsibleName}. Обращения и удаление: <a href={'mailto:' + notice.policy.contactEmail}>{notice.policy.contactEmail}</a>. {perpetual ? 'Хранение — один календарный год с момента отправки анкеты.' : <>Хранение — один календарный год после окончания мероприятия, до {format(eventRetentionUntil(notice.policy.endsAt))} (МСК).</>}</p>
    <p>{perpetual ? 'Игровое окно' : 'Мероприятие'}: {format(notice.policy.startsAt)} — {format(notice.policy.endsAt)} (МСК). В рейтинге видны имя профиля и лучший результат Падл Jump.</p>
    <label className="form-label">ФИО<input autoFocus className="form-input" name="fullName" autoComplete="name" required maxLength={160} /></label>
    <label className="form-label">Компания<input className="form-input" name="company" autoComplete="organization" required maxLength={160} /></label>
    <label className="form-label">Электронная почта<input className="form-input" name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    {error && <p role="alert" className="community-form-error">{error}</p>}
    <div className="form-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button><button className="btn-primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Вступить'}</button></div>
  </form>;
}
