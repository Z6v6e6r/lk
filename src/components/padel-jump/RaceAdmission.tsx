import { useEffect, useRef, useState } from 'react';
import { entryRequest } from './live-client';
import type { RaceEntryStatus } from './live-client';
import { normalizeEnrollment } from './enrollment-form';
import type { EnrollmentFields } from './enrollment-form';
import RaceJump from './RaceJump';
import logo from '../../assets/logo-hab-compact.svg';

export function EnrollmentForm({ fields, busy, onSubmit }: { fields?: EnrollmentFields; busy: boolean; onSubmit: (data: EnrollmentFields & { consent: true }) => void }) {
  const [data, setData] = useState<EnrollmentFields>(fields ?? { firstName: '', lastName: '', email: '', companyWebsite: '' });
  const [consent, setConsent] = useState(false), [error, setError] = useState('');
  return <form className="pj-enrollment" onSubmit={event => {
    event.preventDefault(); setError('');
    try { onSubmit({ ...normalizeEnrollment({ ...data, consent }), consent: true }); } catch { setError('Заполни все поля, укажи почту и сайт компании и подтверди сохранение анкеты.'); }
  }}>
    <h2>Знакомимся перед игрой</h2><p>Ты ещё не участник сообщества. Заполни анкету для организаторов, чтобы вступить и открыть игру. Основной профиль ПадлхАБ не изменится.</p>
    {([{ key: 'firstName', title: 'Имя', autoComplete: 'given-name', max: 80 }, { key: 'lastName', title: 'Фамилия', autoComplete: 'family-name', max: 80 }, { key: 'email', title: 'Электронная почта', autoComplete: 'email', max: 254 }, { key: 'companyWebsite', title: 'Сайт компании', autoComplete: 'url', max: 500 }] as const).map(field => <label key={field.key} htmlFor={'jump-' + field.key}>{field.title}<input id={'jump-' + field.key} name={field.key} type={field.key === 'email' ? 'email' : 'text'} inputMode={field.key === 'companyWebsite' ? 'url' : field.key === 'email' ? 'email' : 'text'} autoComplete={field.autoComplete} maxLength={field.max} required disabled={busy} value={data[field.key]} placeholder={field.key === 'companyWebsite' ? 'company.ru' : undefined} onChange={event => setData(previous => ({ ...previous, [field.key]: event.target.value }))} /></label>)}
    <label className="pj-enrollment-consent"><input type="checkbox" required disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} /><span>Согласен сохранить анкету для организаторов сообщества и вступить в него. Почта и сайт не появятся на общем экране. <a href="https://padlhub.ru/politica" target="_blank" rel="noopener noreferrer">Обработка персональных данных</a></span></label>
    {error && <p role="alert">{error}</p>}<button className="auth-btn" type="submit" disabled={busy || !consent}>{busy ? 'Сохраняем и подтверждаем вступление…' : 'Сохранить анкету и вступить'}</button>
  </form>;
}

export default function RaceAdmission({ onChangeProfile }: { onChangeProfile: () => void }) {
  const [entry, setEntry] = useState<RaceEntryStatus | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [opened, setOpened] = useState(false);
  const request = useRef<AbortController | null>(null);
  const accept = (value: RaceEntryStatus) => {
    if (!['ready', 'form', 'pending', 'blocked', 'confirming'].includes(value?.state)) throw new Error('Не удалось подтвердить доступ к игре.');
    setEntry(value);
  };
  useEffect(() => {
    const controller = new AbortController(); request.current = controller; setEntry(null); setError(''); setBusy(true);
    void entryRequest<RaceEntryStatus>('entry', controller.signal).then(value => { if (!controller.signal.aborted) accept(value); }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось проверить сообщество.'); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [attempt]);
  const submit = async (data: EnrollmentFields & { consent: true }) => {
    if (busy) return;
    setBusy(true); setError(''); const controller = new AbortController(); request.current = controller;
    try { accept(await entryRequest<RaceEntryStatus>('enrollment', controller.signal, data)); }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось сохранить анкету.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  if (opened) return <RaceJump onChangeProfile={onChangeProfile} />;
  return <main className="pj-race-auth pj-admission"><img className="auth-brand-logo" src={logo} alt="ПадлхАБ" /><h1>Jump · заезд команды</h1>
    {!entry && busy && <p role="status">Проверяем профиль и участие в сообществе…</p>}
    {entry && <p className="pj-admission-community">{entry.communityName}</p>}
      {entry?.state === 'form' && <EnrollmentForm fields={entry.fields} busy={busy} onSubmit={data => void submit(data)} />}
      {entry?.state === 'ready' && <section><h2>Всё готово к игре</h2><p>{entry.name ? `${entry.name}, ты участник сообщества.` : 'Участие в сообществе подтверждено.'}</p><button className="auth-btn" onClick={() => setOpened(true)}>Открыть игру</button></section>}
      {entry?.state === 'pending' && <p role="status">Заявка на вступление ожидает подтверждения организатором. Игра откроется после подтверждения.</p>}
      {entry?.state === 'blocked' && <p role="alert">Участие в сообществе ограничено. Обратись к организатору.</p>}
      {entry?.state === 'confirming' && <p role="status">Анкета сохранена. Вступление ещё не подтверждено; повторной отправки не будет. Проверь ещё раз или обратись к организатору.</p>}
    {error && <p role="alert" className="auth-error">{error}</p>}
    {entry?.state !== 'ready' && entry?.state !== 'blocked' && <button className="auth-link-btn" disabled={busy} onClick={() => setAttempt(n => n + 1)}>Проверить ещё раз</button>}
    <button className="auth-link-btn pj-change-profile" disabled={busy} onClick={onChangeProfile}>Выйти и сменить профиль</button>
  </main>;
}
