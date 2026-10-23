import { EVENT_JUMP_ENGINE_VERSION } from '../../services/eventJumpContract';
import './event-community.css';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { apiEventGame } from '../../utils/communityApi';
import type { CommunityRecord, EventReplay } from '../../utils/communityApi';
import { Modal } from '../UI/Modal';
import { getServ2Origin } from '../../utils/apiClient';
const EventJump = lazy(() => import('../padel-jump/EventJump').then(module => ({default: module.EventJump})));
type Run = {runId: string; seed: number; engineVersion: string; completed: boolean};
type Row = {rank: number; name: string; score: number};

export function EventCommunityPanel({ community, onRegister }: {community: CommunityRecord; onRegister: () => void}) {
  const [rows,setRows] = useState<Row[]>([]), [loading,setLoading] = useState(true), [error,setError] = useState<string | null>(null);
  const [run,setRun] = useState<Run | null>(null), [busy,setBusy] = useState(false), [result,setResult] = useState<string | null>(null);
  const [pending,setPending] = useState<{runId: string; inputs: EventReplay; requestId: string} | null>(null);
  const startRequestId = useRef<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++generation.current; setLoading(true);
    const response = await apiEventGame<{rows: Row[]}>(community.id,'ranking');
    if (id !== generation.current) return;
    setLoading(false);
    if (response.error) setError(response.status === 422 ? 'Заполните анкету для участия в мероприятии.' : 'Не удалось загрузить рейтинг. Вступите в мероприятие или повторите попытку.');
    else { setRows(response.data?.rows || []); setError(null); }
  },[community.id]);
  useEffect(() => { void refresh(); return () => { generation.current++; }; },[refresh]);
  const start = async () => {
    setBusy(true); setError(null); setResult(null); startRequestId.current ||= crypto.randomUUID();
    try {
      const response = await apiEventGame<Run>(community.id,'start',{},startRequestId.current);
      if (response.error) { if (response.status === 422) onRegister(); else setError('Не удалось начать партию. Повторите попытку.'); }
      else if (response.data?.engineVersion !== EVENT_JUMP_ENGINE_VERSION) setError('Обновите страницу: версия игры изменилась.');
      else if (response.data?.completed) { startRequestId.current = null; setResult('Эта партия уже завершена. Можно начать новую.'); }
      else if (response.data) setRun(response.data);
    } catch { setError('Не удалось начать партию. Повторите попытку.'); }
    finally { setBusy(false); }
  };
  const submit = async (value: NonNullable<typeof pending>) => {
    setPending(value); setBusy(true); setError(null); setRun(null);
    try {
      const response = await apiEventGame<{score: number; bestScore: number}>(community.id,'finish',value,value.requestId);
      if (response.error) setError('Результат пока не сохранён. Повторите отправку, чтобы он попал в рейтинг.');
      else { setPending(null); startRequestId.current = null; setResult(`Результат: ${response.data?.score} м. Лучший: ${response.data?.bestScore} м.`); void refresh(); }
    } catch { setError('Результат пока не сохранён. Повторите отправку.'); }
    finally { setBusy(false); }
  };
  return <section className="community-ranking-box community-event-panel" aria-label="Игры и рейтинг мероприятия">
    <h2>Игры мероприятия</h2>
    {community.typeSettings?.gameIds?.includes('padel-jump') && <button type="button" className="btn-primary" disabled={busy || !!pending} onClick={() => void start()}>Падл Jump — играть</button>}
    {community.typeSettings?.gameIds?.includes('time-for-friends') && <p><a className="btn-secondary" href={new URL('/padel/', getServ2Origin()).href} target="_blank" rel="noopener noreferrer">Падел Микс ↗</a></p>}
    <h3>Рейтинг Падл Jump</h3><p>Лучший результат каждого участника.</p>
    {loading && <p role="status">Загружаем рейтинг…</p>}
    {error && <p role="alert" className="community-form-error">{error}</p>}
    {result && <p role="status">{result}</p>}
    {pending && <button className="btn-primary" type="button" disabled={busy} onClick={() => void submit(pending)}>Повторить отправку результата</button>}
    {!loading && rows.length === 0 && <p>Пока нет результатов. Сыграйте первую партию!</p>}
    {rows.length > 0 && <ol>{rows.map(row => <li key={row.rank}>{row.name} — <strong>{row.score} м</strong></li>)}</ol>}
    <button type="button" className="btn-secondary" disabled={loading} onClick={() => void refresh()}>Обновить рейтинг</button>
    <button type="button" className="btn-secondary" onClick={onRegister}>Заполнить анкету</button>
    <Modal isOpen={!!run} onClose={() => setRun(null)} title="Падл Jump" variant="fullscreen">
      {run && <Suspense fallback={<p role="status">Загружаем игру…</p>}><EventJump key={run.runId} seed={run.seed} onBack={() => setRun(null)} onFinish={inputs => void submit({runId:run.runId,inputs,requestId:crypto.randomUUID()})} /></Suspense>}
    </Modal>
  </section>;
}
