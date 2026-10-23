import './event-community.css';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { EventRegistration } from '../../utils/communityApi';

export function EventRegistrationForm({ onSubmit, onCancel }: {
  onSubmit: (value: EventRegistration) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = { fullName: String(data.get('fullName') || '').trim(), company: String(data.get('company') || '').trim(), email: String(data.get('email') || '').trim() };
    if (value.fullName.split(/\s+/).length < 2) { setError('Укажите фамилию, имя и отчество (при наличии).'); return; }
    setBusy(true); setError(null);
    try { setError(await onSubmit(value)); }
    catch { setError('Не удалось сохранить анкету. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  };
  return <form className="community-form community-event-registration" onSubmit={event => void submit(event)}>
    <p>Для участия в мероприятии заполните анкету. ФИО, компания и email не публикуются в рейтинге.</p>
    <label className="form-label">ФИО<input autoFocus className="form-input" name="fullName" autoComplete="name" required maxLength={160} /></label>
    <label className="form-label">Компания<input className="form-input" name="company" autoComplete="organization" required maxLength={160} /></label>
    <label className="form-label">Электронная почта<input className="form-input" name="email" type="email" autoComplete="email" required maxLength={254} /></label>
    {error && <p role="alert" className="community-form-error">{error}</p>}
    <div className="form-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Отмена</button><button className="btn-primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Участвовать'}</button></div>
  </form>;
}
