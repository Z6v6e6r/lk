import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../UI/Modal";
import {
  apiCreateAmericanoTournament, apiFetchTournamentHistory, apiUpdateAmericanoResults,
  type AmericanoTournamentPayload, type TournamentHistoryRecord,
} from "../../utils/apiClient";
import {
  createFprState, fprCompletedRounds, fprCurrentAttempt, fprProjection, fprReserveThreshold,
  fprServeAt, fprStandings, fprStartingSides, validateFprState, type FprCommand, type FprMatch, type FprState,
} from "./fpr6x25";
import { apiFetchCommunities, apiFetchCommunityRanking, apiFetchTournamentCommunityBinding,
  type TournamentCommunityBinding } from "../../utils/communityApi";
import { loadFprCommunityLeague, fprLeagueLabel, type FprLeagueValue, type FprLoadedLeague } from "./fprCommunityLeague";
import "./fpr6x25.css";
import { useLkTournamentSession } from "../../utils/useLkTournamentSession";

type Player = { id: string; name: string; rating?: string | null; phone?: string | null; photo?: string | null };
const message = (e: unknown) => e instanceof Error ? e.message : "Не удалось выполнить действие";
const number = (s: string) => s.trim() ? Number(s.replace(",", ".")) : Number.NaN;
function download(value: unknown, file: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = file; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FprTournamentSetup({ players, context, onSaved }: {
  players: Player[];
  context: {
    tenantKey: string; organizer: AmericanoTournamentPayload["organizer"]; sourceExerciseId?: string;
    stationName?: string; stationId?: string; endsAt?: string; dateKey: string;
    communityBinding?: TournamentCommunityBinding | null;
  };
  onSaved: (payload: AmericanoTournamentPayload) => void;
}) {
  const [id] = useState(() => `fpr-${crypto.randomUUID()}`);
  useLkTournamentSession(true);
  const [reserve, setReserve] = useState(true);
  const [values, setValues] = useState<Record<string, Partial<FprLeagueValue>>>({});
  const [courtValues, setCourtValues] = useState<Record<number, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const presentPlayers = useMemo(() => players.filter(p => included[p.id] !== false), [players, included]);
  const [communities, setCommunities] = useState<Array<{ id: string; name: string }>>([]);
  const [communityLoading, setCommunityLoading] = useState(true);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [binding, setBinding] = useState<TournamentCommunityBinding | null>(context.communityBinding ?? null);
  const [bindingLoading, setBindingLoading] = useState(Boolean(context.sourceExerciseId));
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [selectedCommunityId, setSelectedCommunityId] = useState("");
  const [league, setLeague] = useState<FprLoadedLeague | null>(null);
  const [leagueLoading, setLeagueLoading] = useState(false);
  const [leagueError, setLeagueError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AmericanoTournamentPayload | null>(null);
  const organizerId = context.organizer.id, organizerPhone = context.organizer.phone;
  const sourceExerciseId = context.sourceExerciseId;

  useEffect(() => {
    let active = true;
    setCommunityLoading(true); setCommunityError(null);
    void apiFetchCommunities({ clientId: organizerId, phone: organizerPhone }).then(result => {
      if (!active) return;
      if (result.error || !result.data) throw new Error(result.error?.message || "Не удалось загрузить сообщества");
      setCommunities(result.data.communities.map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name, "ru")));
    }).catch(e => { if (active) setCommunityError(message(e)); })
      .finally(() => { if (active) setCommunityLoading(false); });
    return () => { active = false; };
  }, [organizerId, organizerPhone, reload]);
  useEffect(() => {
    let active = true;
    setBindingError(null);
    if (!sourceExerciseId) { setBinding({ ratingCommunityId: null, publishedCommunities: [] }); setBindingLoading(false); return; }
    setBindingLoading(true);
    void apiFetchTournamentCommunityBinding(sourceExerciseId).then(result => {
      if (!active) return;
      if (result.error || !result.data) throw new Error(result.error?.message || "Не удалось проверить сообщество события");
      setBinding(result.data);
    }).catch(e => { if (active) setBindingError(message(e)); })
      .finally(() => { if (active) setBindingLoading(false); });
    return () => { active = false; };
  }, [sourceExerciseId, reload]);
  const choices = useMemo(() => binding?.publishedCommunities.length
    ? binding.publishedCommunities.map(p => ({ id: p.communityId,
      name: p.communityName || communities.find(c => c.id === p.communityId)?.name || p.communityId }))
    : communities, [binding, communities]);
  const boundCommunityId = binding?.ratingCommunityId ?? null;
  const communityId = boundCommunityId || (choices.some(c => c.id === selectedCommunityId) ? selectedCommunityId : "");
  const communityName = choices.find(c => c.id === communityId)?.name || communities.find(c => c.id === communityId)?.name || communityId;
  useEffect(() => { setValues({}); }, [communityId]);
  useEffect(() => {
    let active = true;
    setLeague(null); setLeagueError(null);
    if (!communityId || bindingLoading || bindingError || !presentPlayers.length) { setLeagueLoading(false); return; }
    setLeagueLoading(true);
    void loadFprCommunityLeague({ communityId, communityName, players: presentPlayers,
      fetch: async period => {
        const result = await apiFetchCommunityRanking(communityId, { clientId: organizerId, phone: organizerPhone, tab: "overall", period });
        if (result.error || !result.data) throw new Error(result.error?.message || "Не удалось загрузить рейтинг сообщества");
        if (result.data.period !== period) throw new Error("Получен рейтинг другого периода");
        return { ...result.data, period };
      },
    }).then(result => { if (active) setLeague(result); })
      .catch(e => { if (active) setLeagueError(message(e)); })
      .finally(() => { if (active) setLeagueLoading(false); });
    return () => { active = false; };
  }, [communityId, communityName, presentPlayers, bindingLoading, bindingError, organizerId, organizerPhone, reload]);
  const get = (p: Player): FprLeagueValue => ({
    ...(league?.values[p.id] ?? { level: p.rating ?? "", points: "", place: "", newcomer: false }), ...values[p.id],
  });
  const change = (p: Player, update: Partial<FprLeagueValue>) => setValues(v => ({ ...v, [p.id]: { ...v[p.id], ...update } }));
  const save = async () => {
    if (busy) return;
    setError(null);
    try {
      let payload = pending;
      if (!payload) {
        if (!league || league.communityId !== communityId || leagueLoading || bindingLoading || bindingError) throw new Error("Дождитесь загрузки рейтинга сообщества");
        const now = new Date().toISOString();
        const publication = binding?.publishedCommunities.find(p => p.communityId === communityId);
        const state = createFprState({ tournamentId: id, players: presentPlayers.map(p => ({
          id: p.id, name: p.name, level: number(get(p).level),
          leaguePoints: get(p).newcomer ? 0 : number(get(p).points),
          leaguePlace: get(p).newcomer ? null : number(get(p).place),
        })), courts: Array.from({ length: Math.floor(presentPlayers.length / 4) }, (_, i) => courtValues[i] ?? `Корт №${i + 1}`),
        leagueSource: fprLeagueLabel(league), endsAt: context.endsAt || new Date(Date.now() + 90 * 60_000).toISOString(),
        reserveAllowed: reserve, testMode: false, now,
        communityRating: { policy: "community-tournament-v1", communityId, communityName, period: league.period,
          snapshotUpdatedAt: league.snapshotUpdatedAt, sourceExerciseId: sourceExerciseId ?? null, publicationId: publication?.publicationId ?? null },
        });
        const projected = fprProjection(state, {
          manualTournament: true, localStatus: "draft", syncStatus: "not_required", localDateKey: context.dateKey,
          sourceExerciseId: sourceExerciseId ?? null, stationName: context.stationName ?? null,
          stationId: context.stationId ?? null, organizerName: context.organizer.name ?? null,
        });
        payload = {
          tournamentId: id, tournamentType: "fpr_6x25", tenantKey: context.tenantKey, createdAt: now,
          organizer: context.organizer, targetScore: 25, courts: state.courts,
          participants: presentPlayers.map(p => ({ id: p.id, name: p.name, rating: p.rating ?? null, phone: p.phone ?? null, photo: p.photo ?? null })),
          params: projected.params, rounds: projected.rounds,
        };
        setPending(payload);
      }
      setBusy(true);
      const response = await apiCreateAmericanoTournament(payload);
      if (response.status == null || response.status < 200 || response.status >= 300) {
        throw new Error(response.error?.message || "Создание не подтверждено. Повтор использует тот же ID и снимок; также можно проверить список турниров.");
      }
      const saved = response.data?.params?.fpr6x25;
      validateFprState(saved);
      if (saved.tournamentId !== payload.tournamentId || saved.revision !== 0) throw new Error("Сервер не подтвердил создание этого протокола ФПР");
      onSaved(payload);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const loading = bindingLoading || leagueLoading || (!boundCommunityId && communityLoading);
  const loadError = bindingError || leagueError || (!boundCommunityId ? communityError : null);
  return <div className="fpr-panel">
    <p>ФПР 6×25 · шесть общих раундов, два запасных. В каждом матче ровно 25 очков на две пары.</p>
    <fieldset disabled={busy || Boolean(pending)}>
      {boundCommunityId ? <p><strong>Сообщество турнира:</strong> {communityName}</p> : <label>Сообщество для рейтинга
        <select value={selectedCommunityId} disabled={bindingLoading || communityLoading} onChange={e => setSelectedCommunityId(e.target.value)}>
          <option value="">Выберите сообщество</option>
          {choices.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
        </select>
      </label>}
      {loading && <p role="status">Загружаем данные сообщества…</p>}
      {loadError && <p role="alert" className="fpr-error">{loadError} <button type="button" onClick={() => setReload(v => v + 1)}>Повторить загрузку</button></p>}
      {league && <p aria-live="polite">Рейтинг: {fprLeagueLabel(league)}.{league.missingFromMonth.length > 0
        ? " В текущем месяце нет данных хотя бы об одном участнике, поэтому для всего состава выбран рейтинг за всё время." : " Данные текущего месяца есть у всех участников."}</p>}
      {!loading && !loadError && !choices.length && !boundCommunityId && <p>Нет доступных сообществ для выбора.</p>}
      <label className="fpr-check"><input type="checkbox" checked={reserve} onChange={e => setReserve(e.target.checked)} /> Разрешены 7-й и 8-й раунды при выполнении порога времени</label>
      <p>В составе: {presentPlayers.length} из {players.length}. Кортов одновременно: {Math.floor(presentPlayers.length / 4)}. Отдыхает в раунде: {presentPlayers.length % 4}.</p>
      {Array.from({ length: Math.floor(presentPlayers.length / 4) }, (_, i) => <label key={i}>Название корта {i + 1}<input value={courtValues[i] ?? `Корт №${i + 1}`} onChange={e => setCourtValues(v => ({ ...v, [i]: e.target.value }))} /></label>)}
      <details>
        <summary>Состав и снимок рейтинга · {presentPlayers.length} участников{league ? " · заполнено автоматически" : ""}</summary>
        <p>Места и очки загружены из сообщества. При необходимости организатор может исправить их и отметить отсутствующих игроков. Если игрока нет и в таблице за всё время, отмечается отсутствие очков.</p>
        <div className="fpr-scroll"><table>
          <thead><tr><th>В составе</th><th>Участник / ID</th><th>Уровень</th><th>Место в Лиге</th><th>Очки Лиги</th><th>Без очков Лиги</th></tr></thead>
          <tbody>{players.map(p => <tr key={p.id}>
            <td><input aria-label={`В составе: ${p.name}`} type="checkbox" checked={included[p.id] !== false} onChange={e => setIncluded(v => ({ ...v, [p.id]: e.target.checked }))} /></td>
            <th scope="row">{p.name}<small>{p.id}</small></th>
            <td><input aria-label={`Уровень: ${p.name}`} inputMode="decimal" value={get(p).level} onChange={e => change(p, { level: e.target.value })} /></td>
            <td><input aria-label={`Место в Лиге: ${p.name}`} inputMode="numeric" disabled={get(p).newcomer} value={get(p).place} onChange={e => change(p, { place: e.target.value })} /></td>
            <td><input aria-label={`Очки Лиги: ${p.name}`} inputMode="decimal" disabled={get(p).newcomer} value={get(p).points} onChange={e => change(p, { points: e.target.value })} /></td>
            <td><input aria-label={`Нет очков Лиги: ${p.name}`} type="checkbox" checked={get(p).newcomer} onChange={e => change(p, { newcomer: e.target.checked })} /></td>
          </tr>)}</tbody>
        </table></div>
      </details>
    </fieldset>
    <p>Посев и жребий отдыха фиксируются при создании. Очки сообщества начисляются по обычным правилам после завершения и публикации турнира в этом сообществе. Уровень игрока эта механика не меняет.</p>
    {error && <p role="alert" className="fpr-error">{error}</p>}
    <button className="section-cta" type="button" disabled={busy || (!pending && (loading || Boolean(loadError) || !league)) || presentPlayers.length < 4 || presentPlayers.length > 28 || !organizerId} onClick={() => void save()}>
      {busy ? "Сохраняем протокол…" : pending ? "Повторить создание с тем же ID" : "Создать протокол ФПР 6×25"}
    </button>
  </div>;
}

type ScoreAction = Extract<FprCommand, { action: "score" | "correct_score" }>;
function HeadToHeadDetails({ state }: { state: FprState }) {
  const groups = new Map<string, ReturnType<typeof fprStandings>>();
  for (const row of fprStandings(state).filter(p => p.status !== "DNF" && p.headToHead !== null)) {
    const key = `${row.wins}:${row.totalPoints}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (!groups.size) return null;
  return <details><summary>Результаты очных серий равных групп</summary>
    {[...groups.entries()].map(([key, group]) => <section key={key}>
      <p>{group[0].wins} побед, {group[0].totalPoints} очков: {group.map(p => p.name).join(", ")}</p>
      <ul>{group.flatMap((a, i) => group.slice(i + 1).map(b => {
        let winsA = 0, winsB = 0;
        for (const attempt of state.attempts.filter(r => r.status === "closed")) for (const match of attempt.matches) {
          const direct = match.pair1.includes(a.id) && match.pair2.includes(b.id);
          const reverse = match.pair2.includes(a.id) && match.pair1.includes(b.id);
          if (!direct && !reverse) continue;
          const aWon = direct ? match.score1! > match.score2! : match.score2! > match.score1!;
          if (aWon) winsA += 1; else winsB += 1;
        }
        return <li key={`${a.id}:${b.id}`}>{a.name} — {b.name}: {winsA}:{winsB} по победам в очной серии ({winsA + winsB} матчей)</li>;
      }))}</ul>
    </section>)}
    <p>Матчи, где игроки были партнёрами, и отменённые попытки в эти серии не входят. Мини-таблица равной группы считается один раз.</p>
  </details>;
}
function MatchHeader({ match, state }: { match: FprMatch; state: FprState }) {
  const sides = fprStartingSides(state, match);
  return <div className="tournament-match-header">
    <div className="tournament-match-court"><span className="tournament-match-label">Корт</span><span className="tournament-match-value">{state.courts[match.courtIndex]}</span></div>
    <span className="fpr-hint">Жребий стартовых сторон: A — {sides.sideA}, B — {sides.sideB}</span>
  </div>;
}
function MatchEditor({ match, state, closed, disabled, onSave, now }: {
  match: FprMatch; state: FprState; closed: boolean; disabled: boolean; now: string;
  onSave: (value: Omit<ScoreAction, "id" | "expectedRevision">) => void;
}) {
  const [score1, setScore1] = useState(match.score1?.toString() ?? "");
  const [score2, setScore2] = useState(match.score2?.toString() ?? "");
  const [confirmed1, setConfirmed1] = useState(match.confirmed1);
  const [confirmed2, setConfirmed2] = useState(match.confirmed2);
  const [reason, setReason] = useState("");
  const [playedAt, setPlayedAt] = useState("");
  const [lastRallyAt, setLastRallyAt] = useState("");
  const names = (ids: string[]) => ids.map(id => state.players.find(p => p.id === id)?.name ?? id).join(" + ");
  const played = (match.score1 ?? 0) + (match.score2 ?? 0);
  const lateEntry = !closed && Date.parse(now) >= Date.parse(state.endsAt) - 180_000 && !match.completedAt;
  const serve = played < 25 ? fprServeAt(match, played) : null;
  const changeScore = (team: 1 | 2, value: string) => {
    (team === 1 ? setScore1 : setScore2)(value); setConfirmed1(false); setConfirmed2(false);
  };
  return <section className="tournament-match fpr-match" aria-label={`Матч: ${state.courts[match.courtIndex]}`}>
    <MatchHeader match={match} state={state} />
    <fieldset disabled={disabled}>
      <div className="tournament-match-row">
        <span className="tournament-match-label">Пара A</span><span className="tournament-match-value">{names(match.pair1)}</span>
        <input className="tournament-score-input" aria-label={`Счёт A: ${match.id}`} type="number" min="0" max="25" step="1" value={score1} onChange={e => changeScore(1, e.target.value)} />
      </div>
      <div className="tournament-match-row">
        <span className="tournament-match-label">Пара B</span><span className="tournament-match-value">{names(match.pair2)}</span>
        <input className="tournament-score-input" aria-label={`Счёт B: ${match.id}`} type="number" min="0" max="25" step="1" value={score2} onChange={e => changeScore(2, e.target.value)} />
      </div>
      {!closed && <p className="fpr-hint">A1: {names([match.firstServer])}. Подача по два очка: A1 → B1 → A2 → B2. После 12-го очка — смена сторон.
        {serve && <> Следующая подача по записанному счёту: {names([serve.playerId])}, {serve.side === "right" ? "справа" : "слева"}.</>}</p>}
      <p>Сумма: {Number.isFinite(number(score1) + number(score2)) ? number(score1) + number(score2) : "—"} / 25</p>
      <label className="fpr-check"><input type="checkbox" checked={confirmed1} onChange={e => setConfirmed1(e.target.checked)} /> Участник пары A подтвердил счёт</label>
      <label className="fpr-check"><input type="checkbox" checked={confirmed2} onChange={e => setConfirmed2(e.target.checked)} /> Участник пары B подтвердил счёт</label>
      {closed && <label>Причина исправления<input value={reason} onChange={e => setReason(e.target.value)} /></label>}
      {lateEntry && <>
        <p>Игровой дедлайн наступил. Частичный счёт можно записать для протокола отменённой попытки. Для 25 очков нужны фактические времена и объяснение позднего ввода.</p>
        <label>Фактическое окончание матча (местное время)<input type="datetime-local" step="1" value={playedAt} onChange={e => setPlayedAt(e.target.value)} /></label>
        <label>Если доигрывали последнее очко: когда начался этот розыгрыш<input type="datetime-local" step="1" value={lastRallyAt} onChange={e => setLastRallyAt(e.target.value)} /></label>
        <label>Причина позднего ввода<input value={reason} onChange={e => setReason(e.target.value)} /></label>
      </>}
      <button type="button" disabled={!score1.trim() || !score2.trim() || (closed && (!reason.trim() || !confirmed1 || !confirmed2))} onClick={() => onSave({
        action: closed ? "correct_score" : "score", matchId: match.id, score1: number(score1), score2: number(score2), confirmed1, confirmed2,
        ...(closed || lateEntry ? { reason } : {}), ...(playedAt ? { playedAt: new Date(playedAt).toISOString() } : {}), ...(lastRallyAt ? { lastRallyStartedAt: new Date(lastRallyAt).toISOString() } : {}),
      })}>{closed ? "Сохранить исправление с историей" : "Сохранить счёт и подтверждения"}</button>
    </fieldset>
    <p aria-live="polite">{match.confirmed1 && match.confirmed2 ? "Обе пары подтвердили запись" : match.score1 !== null ? "Запись сохранена, ждём подтверждений" : "Счёт ещё не записан"}</p>
  </section>;
}

export function FprTournamentManager({ data, onClose, onDataChange }: {
  data: AmericanoTournamentPayload; onClose: () => void; onDataChange: (payload: AmericanoTournamentPayload) => void;
}) {
  const pendingKey = `padlhub:fpr-command:${data.tournamentId}`;
  useLkTournamentSession(true);
  const [state, setState] = useState<FprState | null>(() => {
    try { validateFprState(data.params?.fpr6x25); return data.params.fpr6x25; } catch { return null; }
  });
  const [pending, setPending] = useState<FprCommand | null>(() => {
    try { return JSON.parse(localStorage.getItem(pendingKey) || "null") as FprCommand | null; } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"round" | "table" | "protocol">("round");
  const [reason, setReason] = useState("");
  const [withdrawId, setWithdrawId] = useState("");
  const [finishConfirmation, setFinishConfirmation] = useState(false);
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date().toISOString()), 10_000); return () => window.clearInterval(timer); }, []);
  const applyResponse = (next: FprState, payload = data) => {
    validateFprState(next);
    setState(next);
    const projected = fprProjection(next, payload.params);
    onDataChange({ ...payload, params: projected.params, rounds: projected.rounds });
  };
  const clearPending = () => { localStorage.removeItem(pendingKey); setPending(null); };
  const send = async (command: FprCommand) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      localStorage.setItem(pendingKey, JSON.stringify(command)); setPending(command);
      const response = await apiUpdateAmericanoResults({ tournamentId: data.tournamentId, results: [], params: { fprCommand: command } });
      if (response.status == null || response.status < 200 || response.status >= 300) throw new Error(response.error?.message || "Сохранение не подтверждено. Повторите эту команду или проверьте сервер.");
      const next = response.data?.params?.fpr6x25;
      validateFprState(next);
      if (next.tournamentId !== data.tournamentId || !next.audit.some(a => a.id === command.id)
        || next.revision <= command.expectedRevision) throw new Error("Сервер вернул протокол без подтверждения этой команды. Проверьте актуальный протокол перед повтором.");
      applyResponse(next); clearPending(); setReason(""); setFinishConfirmation(false);
    } catch (e) { setError(message(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  type Action = FprCommand extends infer T ? T extends FprCommand ? Omit<T, "id" | "expectedRevision"> : never : never;
  const act = (action: Action) => {
    if (!state || pending || busyRef.current) return;
    void send({ ...action, id: crypto.randomUUID(), expectedRevision: state.revision } as FprCommand);
  };
  const reload = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const response = await apiFetchTournamentHistory(data.tournamentId, { forceRefresh: true });
      if (response.error) throw new Error(response.error.message);
      const record = response.data?.find(p => p.tournamentId === data.tournamentId);
      const next = record?.params?.fpr6x25;
      validateFprState(next);
      applyResponse(next);
      if (pending && (next.audit.some(a => a.id === pending.id) || next.revision !== pending.expectedRevision)) {
        if (!next.audit.some(a => a.id === pending.id)) setError("Другой организатор изменил протокол. Ожидавшая команда не применена; проверьте таблицу и введите её заново.");
        clearPending();
      }
    } catch (e) { setError(message(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const current = state ? fprCurrentAttempt(state) : null;
  const completed = state ? fprCompletedRounds(state) : 0;
  const finished = state?.status === "completed" || state?.status === "incomplete";
  const threshold = state ? fprReserveThreshold(state, now) : null;
  const name = (id: string) => state?.players.find(p => p.id === id)?.name ?? id;
  const disabled = busy || Boolean(pending);
  return <Modal isOpen onClose={onClose} title={`ФПР 6×25${state?.testMode ? " · тестовое проведение" : ""}`} variant="fullscreen" bodyClassName="tournament-settings-modal-body">
    <div className="tournament-manager fpr-panel">
      {!state ? <p role="alert">Протокол ФПР повреждён или имеет другую версию. Загрузите его с сервера.</p> : <>
        <div className="tournament-manager-meta"><span className="tournament-manager-chip strong">ФПР 6×25</span><span className="tournament-manager-chip">25 очков на матч</span><span className="tournament-manager-chip">{state.players.length} игроков</span><span className="tournament-manager-chip">Кортов: {state.courts.length}</span></div>
        <p><b>{finished ? state.status === "completed" ? "Турнир состоялся" : "Турнир не завершён" : "Турнир в работе"}</b> · полных раундов: {completed}/6{completed > 6 ? ` (+${completed - 6})` : ""} · версия записи: {state.revision}</p>
        <p>Конец события: {new Date(state.endsAt).toLocaleString("ru-RU")}. Игровой дедлайн: {new Date(Date.parse(state.endsAt) - 180_000).toLocaleTimeString("ru-RU")}.</p>
        {!finished && Date.parse(now) >= Date.parse(state.endsAt) - 180_000 && <p role="alert" className="fpr-error">Игровой дедлайн наступил. Доиграйте начатый розыгрыш и остановите игру. При неполном матче исключите весь общий раунд кнопкой завершения события.</p>}
        <div className="tournament-tabs" role="group" aria-label="Раздел протокола">
          {([["round", "Турнир"], ["table", "Таблица"], ["protocol", "Протокол"]] as const).map(([key, label]) => <button className={`tournament-tab${tab === key ? " active" : ""}`} type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        {tab === "round" && <>
          {current ? <div className="tournament-rounds"><section className="tournament-round unsaved">
            <div className="tournament-round-header"><div className="tournament-round-heading"><span className="tournament-round-title">Раунд {current.round}{current.round >= 7 ? " · запасной" : ""}</span><span className="tournament-round-meta-text">Попытка {current.attempt}</span></div><span className="tournament-round-status">{current.status === "scheduled" ? "Готов к старту" : "В игре"}</span></div>
            <div className="tournament-round-body">
            <p>Отдых: {current.byes.length ? current.byes.map(name).join(", ") : "нет"}. За отдых — ноль очков и побед.</p>
            {current.status === "scheduled" && <>
              {current.matches.map(m => <section className="tournament-match fpr-match" key={m.id} aria-label={`Матч: ${state.courts[m.courtIndex]}`}>
                <MatchHeader match={m} state={state} />
                <div className="tournament-match-row"><span className="tournament-match-label">Пара A</span><span className="tournament-match-value">{m.pair1.map(name).join(" + ")}</span><span className="fpr-score-placeholder">—</span></div>
                <div className="tournament-match-row"><span className="tournament-match-label">Пара B</span><span className="tournament-match-value">{m.pair2.map(name).join(" + ")}</span><span className="fpr-score-placeholder">—</span></div>
                <details className="fpr-serve-order"><summary>Порядок подачи</summary><p>A1: {name(m.firstServer)}. B1: {name(m.pair2[0])}. После 12-го очка пары меняются сторонами.</p>
                  <label>Первый подающий пары B · можно изменить до старта<select aria-label={`Первый подающий пары B: ${m.id}`} disabled={disabled} value={m.pair2[0]} onChange={e => act({ action: "set_b1", matchId: m.id, playerId: e.target.value })}>{m.pair2.map(id => <option key={id} value={id}>{name(id)}</option>)}</select></label>
                </details>
              </section>)}
              <button type="button" className="section-cta" disabled={disabled || Date.parse(now) >= Date.parse(state.endsAt) - 180_000 || (current.round >= 7 && !threshold?.allowed)} onClick={() => act({ action: "start_round" })}>Общий старт всех кортов</button>
            </>}
            {current.status === "running" && <>
              <p>Начало: {new Date(current.startedAt!).toLocaleTimeString("ru-RU")}. Новая сетка появится после подтверждения всех матчей и закрытия раунда.</p>
              {current.matches.map(m => <MatchEditor key={`${m.id}:${m.score1}:${m.score2}:${m.confirmed1}:${m.confirmed2}`} match={m} state={state} closed={false} disabled={disabled} onSave={act} now={now} />)}
              <button type="button" className="section-cta" disabled={disabled || current.matches.some(m => !m.confirmed1 || !m.confirmed2)} onClick={() => act({ action: "close_round" })}>Закрыть общий раунд и обновить таблицу</button>
            </>}
            </div>
          </section></div> : !finished && completed < 8 ? <>
            <p>{completed >= 6 ? `Запасной раунд: нужно не меньше ${Math.ceil((threshold?.requiredMs ?? 0) / 60_000)} мин до конца события; осталось ${Math.max(0, Math.floor((threshold?.remainingMs ?? 0) / 60_000))} мин.` : "Предыдущая попытка отменена. Можно подготовить повтор с тем же номером зачётного раунда."}</p>
            <button type="button" disabled={disabled || (completed >= 6 && !threshold?.allowed)} onClick={() => act({ action: "prepare_round" })}>Подготовить {completed + 1}-й раунд</button>
          </> : null}
          {state.attempts.filter(a => a.id !== current?.id).slice().reverse().map(a => <details className={`tournament-round ${a.status === "closed" ? "saved" : "unsaved"}`} key={a.id}>
            <summary className="tournament-round-header"><span className="tournament-round-title">Раунд {a.round} · попытка {a.attempt}</span><span className="tournament-round-status">{a.status === "closed" ? "Сохранено" : "Отменён"}</span></summary>
            <div className="tournament-round-body"><p>Отдых: {a.byes.map(name).join(", ") || "нет"}. {a.reason}</p>{a.matches.map(m => a.status === "closed"
              ? <MatchEditor key={`${m.id}:${m.score1}:${m.score2}:${m.confirmed1}:${m.confirmed2}`} match={m} state={state} closed disabled={disabled} onSave={act} now={now} />
              : <section className="tournament-match fpr-match" key={m.id}><MatchHeader match={m} state={state} /><p>{m.pair1.map(name).join(" + ")} — {m.pair2.map(name).join(" + ")}: {m.score1 ?? "—"}:{m.score2 ?? "—"}</p></section>)}</div>
          </details>)}
          {!finished && <details><summary>Остановка или снятие участника</summary>
            <label>Причина<input value={reason} disabled={disabled} onChange={e => setReason(e.target.value)} /></label>
            {current && <button type="button" disabled={disabled || !reason.trim()} onClick={() => act({ action: "cancel_round", reason })}>Отменить весь текущий раунд</button>}
            <label>Снять участника (DNF)<select value={withdrawId} disabled={disabled} onChange={e => setWithdrawId(e.target.value)}><option value="">Выберите игрока</option>{state.players.filter(p => !state.withdrawals.some(w => w.id === p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <p>При DNF текущий незакрытый раунд отменяется целиком. Предыдущие полные раунды сохраняются; итогового места у снявшегося нет.</p>
            <button type="button" disabled={disabled || !reason.trim() || !withdrawId} onClick={() => act({ action: "withdraw", playerId: withdrawId, reason })}>Зафиксировать DNF</button>
          </details>}
          {!finished && <div className="fpr-finish">
            {!finishConfirmation ? <button type="button" disabled={disabled} onClick={() => setFinishConfirmation(true)}>Завершить событие</button> : <>
              <p>{completed < 6 ? "Сейчас меньше шести полных раундов: событие получит статус незавершённого." : "Будет зафиксирован итог по всем полным раундам."} Неполная текущая попытка будет исключена целиком; полностью подтверждённая — включена в итог.</p>
              <button type="button" disabled={disabled} onClick={() => act({ action: "finish" })}>Подтвердить завершение события</button>
              <button type="button" disabled={busy} onClick={() => setFinishConfirmation(false)}>Продолжить проведение</button>
            </>}
          </div>}
        </>}
        {tab === "table" && <>
          <p>Победы → очки → очные серии всей равной группы → меньшие очки Лиги до старта. Полностью равные участники делят место; посев нужен только для назначений.</p>
          <div className="fpr-scroll"><table><thead><tr><th>Место</th><th>Участник</th><th>Победы</th><th>Очки</th><th>Матчи</th><th>Отдых</th><th>Очные серии</th><th>Лига до старта</th><th>Статус</th></tr></thead>
            <tbody>{fprStandings(state).map(p => <tr key={p.id}><td>{p.rank ?? "—"}</td><th scope="row">{p.name}</th><td>{p.wins}</td><td>{p.totalPoints}</td><td>{p.matchesPlayed}</td><td>{p.byeCount}</td><td>{p.headToHead ?? "не применялись"}</td><td>{p.leaguePoints}</td><td>{p.status === "DNF" ? "DNF" : p.status === "no_matches" ? "нет матчей" : "в зачёте"}</td></tr>)}</tbody>
          </table></div>
          <HeadToHeadDetails state={state} />
          <p>Таблица учитывает только закрытые общие раунды. {state.testMode ? "Это тестовый протокол без начислений." : "Очки сообщества рассчитываются по обычным правилам опубликованных турниров после полного завершения."} Уровень игрока эта механика не меняет.</p>
        </>}
        {tab === "protocol" && <>
          <p>Алгоритм: {state.version}. Источник: {state.leagueSource}. Снимок: {new Date(state.leagueSnapshotAt).toLocaleString("ru-RU")}.</p>
          <div className="fpr-scroll"><table><thead><tr><th>Посев</th><th>Участник</th><th>Уровень</th><th>Место Лиги</th><th>Очки Лиги</th><th>Жребий отдыха</th></tr></thead><tbody>{state.players.map(p => <tr key={p.id}><td>{p.seed}</td><th scope="row">{p.name}</th><td>{p.level}</td><td>{p.leaguePlace ?? "без очков"}</td><td>{p.leaguePoints}</td><td>{p.restLot}</td></tr>)}</tbody></table></div>
          <h3>Попытки и исправления</h3>
          {state.attempts.map(a => <details key={a.id}><summary>Раунд {a.round} · попытка {a.attempt} · {a.status === "closed" ? "зачтён" : a.status === "cancelled" ? "отменён" : a.status === "running" ? "идёт" : "подготовлен"}</summary>
            <p>{a.startedAt ? new Date(a.startedAt).toLocaleString("ru-RU") : "Не стартовал"}{a.finishedAt ? ` → ${new Date(a.finishedAt).toLocaleTimeString("ru-RU")}` : ""}. {a.reason}</p>
            <p>Отдых: {a.byes.map(name).join(", ") || "нет"}. Окно: {a.window ?? "первый посев / один корт"}.</p>
            {a.matches.map(m => a.status === "closed" ? <MatchEditor key={`${m.id}:${m.score1}:${m.score2}:${m.confirmed1}:${m.confirmed2}`} match={m} state={state} closed disabled={disabled} onSave={act} now={now} /> : <p key={m.id}>{m.pair1.map(name).join(" + ")} — {m.pair2.map(name).join(" + ")}: {m.score1 ?? "—"}:{m.score2 ?? "—"}</p>)}
          </details>)}
          <ol>{state.audit.map(a => <li key={a.id}>{new Date(a.at).toLocaleTimeString("ru-RU")} · {a.action}{a.detail ? ` · ${a.detail}` : ""}</li>)}</ol>
        </>}
        <label>ID протокола для другого устройства<input readOnly value={data.tournamentId} onFocus={e => e.currentTarget.select()} /></label>
        <button type="button" onClick={() => download({ kind: "fpr6x25-protocol", state, pendingCommand: pending, standings: fprStandings(state) }, `${data.tournamentId}-protocol.json`)}>Скачать протокол и таблицу JSON</button>
      </>}
      {pending && <div role="status"><p>Есть команда без подтверждённого ответа сервера. Новые действия временно заблокированы.</p><button type="button" disabled={busy} onClick={() => void send(pending)}>Повторить ту же команду</button></div>}
      {error && <p role="alert" className="fpr-error">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void reload()}>{busy ? "Проверяем…" : "Прочитать актуальный протокол с сервера"}</button>
    </div>
  </Modal>;
}

export function FprProtocolLookup({ onFound, profileId, canHost }: {
  onFound: (record: TournamentHistoryRecord) => void; profileId: string; canHost: boolean;
}) {
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await apiFetchTournamentHistory(id.trim(), { forceRefresh: true });
      if (result.error) throw new Error(result.error.message);
      const record = result.data?.find(t => t.tournamentId === id.trim() && t.tournamentType === "fpr_6x25");
      if (!record) throw new Error("Протокол ФПР с таким ID не найден");
      if (!canHost && String(record.organizer?.id ?? "") !== profileId) throw new Error("Открывать управление этим протоколом может его организатор или сотрудник с доступом к турнирам");
      validateFprState(record.params?.fpr6x25);
      onFound(record);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  return <details className="fpr-panel"><summary>Открыть сохранённый протокол ФПР по ID</summary>
    <p>Используйте ID из протокола, чтобы продолжить на другом устройстве.</p>
    <label>ID протокола<input value={id} disabled={busy} placeholder="fpr-…" onChange={e => setId(e.target.value)} /></label>
    <button type="button" disabled={busy || !/^fpr-[a-f0-9-]{36}$/.test(id.trim())} onClick={() => void open()}>{busy ? "Загрузка…" : "Открыть протокол"}</button>
    {error && <p className="fpr-error" role="alert">{error}</p>}
  </details>;
}
