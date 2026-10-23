import './event-community.css';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { eventRetentionUntil } from '../../services/community-policy';
import type { EventNotice, EventRegistration } from '../../utils/communityApi';

export function EventRegistrationForm({ onSubmit, onCancel, notice }: {
  onSubmit: (value: EventRegistration) => Promise<string | null>;
  onCancel: () => void;
  notice?: EventNotice;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const available = !!notice && Date.now() < Date.parse(notice.policy.endsAt);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!available || !notice) return;
    const data = new FormData(event.currentTarget);
    const value = { fullName: String(data.get('fullName') || '').trim(), company: String(data.get('company') || '').trim(), email: String(data.get('email') || '').trim(), policyRevision: notice.revision };
    if (value.fullName.split(/\s+/).length < 2) { setError('Укажите фамилию, имя и отчество (при наличии).'); return; }
    setBusy(true); setError(null);
    try { setError(await onSubmit(value)); }
    catch { setError('Не удалось сохранить анкету. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };
  if (!available || !notice) return <div className="community-event-registration"><p role="status">Регистрация пока закрыта или мероприятие завершено. Обратитесь к организатору.</p><button type="button" className="btn-secondary" onClick={onCancel}>Закрыть</button></div>;
  const format = (value: string) => new Date(value).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'});
  return <form className="community-form community-event-registration" onSubmit={event => void submit(event)}>
    <p>Для участия в мероприятии заполните анкету. ФИО, компания и email не публикуются в рейтинге.</p>
    <p>Анкета используется для регистрации и организации участия в мероприятии. Ответственный: {notice.policy.responsibleName}. Обращения и удаление: <a href={'mailto:' + notice.policy.contactEmail}>{notice.policy.contactEmail}</a>. Хранение — один календарный год после окончания мероприятия, до {format(eventRetentionUntil(notice.policy.endsAt))} (МСК).</p>
    <p>Мероприятие: {format(notice.policy.startsAt)} — {format(notice.policy.endsAt)} (МСК). В рейтинге видны имя профиля и лучший результат Падл Jump.</p>
    <label className="form-label">ФИО<input autoFocus className="form-input" name="fullName" autoComplete="name" required maxLength={160} /></label>
    <label className="form-label">Компания<input className="form-input" name="company" autoComplete="organization" required maxLength={160} /></label>
    <label className="form-label">Электронная почта<input className="form-input" name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    {error && <p role="alert" className="community-form-error">{error}</p>}
    <div className="form-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button><button className="btn-primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Участвовать'}</button></div>
  </form>;
}
