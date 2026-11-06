import { tournamentEventId } from "../../utils/tournamentEventIdentity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../UI/Modal";
import {
  apiCreateAmericanoTournament, apiFetchTournamentHistory, apiUpdateAmericanoResults, apiFetchFprStartRatings,
  type AmericanoTournamentPayload,
} from "../../utils/apiClient";
import {
  createFprState, fprCompletedRounds, fprCurrentAttempt, fprProjection, fprReserveThreshold,
  fprServeAt, fprStandings, validateFprState, type FprCommand, type FprMatch, type FprState,
} from "./fpr6x25";
import { apiFetchCommunities, apiFetchCommunityRanking, apiFetchTournamentCommunityBinding,
  type TournamentCommunityBinding } from "../../utils/communityApi";
import { loadFprCommunityLeague, fprLeagueLabel, type FprLeagueValue, type FprLoadedLeague } from "./fprCommunityLeague";
import { resolveFprCommunitySelection } from "./fprCommunitySelection";
import { isRejectedFprCommand } from "./fprCommandRecovery";
import "./fpr6x25.css";
import { useLkTournamentSession } from "../../utils/useLkTournamentSession";
import { TournamentBroadcastControl } from "./TournamentBroadcastControl";

type Player = { id: string; name: string; rating?: string | null; phone?: string | null; photo?: string | null };
const message = (e: unknown) => e instanceof Error ? e.message : "Не удалось выполнить действие";
const number = (s: string) => s.trim() ? Number(s.replace(",", ".")) : Number.NaN;
function download(value: unknown, file: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = file; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FprTournamentSetup({ players, context, onSaved, initialState, onResume }: {
  players: Player[];
  initialState?: FprState;
  onResume?: () => void;
  context: {
    tenantKey: string; organizer: AmericanoTournamentPayload["organizer"]; sourceExerciseId?: string;
    stationName?: string; stationId?: string; endsAt?: string; dateKey: string;
    communityBinding?: TournamentCommunityBinding | null;
  };
  onSaved: (payload: AmericanoTournamentPayload) => void;
}) {
  const [id] = useState(() => initialState?.tournamentId || context.sourceExerciseId || `fpr-${crypto.randomUUID()}`);
  useLkTournamentSession(true);
  const [reserve, setReserve] = useState(initialState?.reserveAllowed ?? true);
  const [values, setValues] = useState<Record<string, Partial<FprLeagueValue>>>({});
  const [courtValues, setCourtValues] = useState<Record<number, string>>(() => Object.fromEntries((initialState?.courts ?? []).map((court, i) => [i, court])));
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const presentPlayers = useMemo(() => players.filter(p => included[p.id] !== false), [players, included]);
  const [communities, setCommunities] = useState<Array<{ id: string; name: string }>>([]);
  const [communityLoading, setCommunityLoading] = useState(true);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [binding, setBinding] = useState<TournamentCommunityBinding | null>(context.communityBinding ?? null);
  const [bindingLoading, setBindingLoading] = useState(Boolean(context.sourceExerciseId));
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [selectedCommunityId, setSelectedCommunityId] = useState(initialState?.communityRating?.communityId ?? "");
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
      setCommunities(result.data.communities.map(c => ({ id: c.id, name: c.name })));
    }).catch(e => { if (active) setCommunityError(message(e)); })
      .finally(() => { if (active) setCommunityLoading(false); });
    return () => { active = false; };
  }, [organizerId, organizerPhone, reload]);
  useEffect(() => {
    let active = true;
    setBindingError(null);
    if (!sourceExerciseId) { setBinding(context.communityBinding ?? null); setBindingLoading(false); return; }
    setBindingLoading(true);
    void apiFetchTournamentCommunityBinding(sourceExerciseId).then(result => {
      if (!active) return;
      if (result.error || !result.data) throw new Error(result.error?.message || "Не удалось проверить сообщество события");
      setBinding(result.data);
    }).catch(e => { if (active) setBindingError(message(e)); })
      .finally(() => { if (active) setBindingLoading(false); });
    return () => { active = false; };
  }, [sourceExerciseId, context.communityBinding, reload]);
  const { fixed: fixedCommunity, choices, communityId, communityName, publishedNames, error: selectionError } = useMemo(
    () => resolveFprCommunitySelection(binding, communities, selectedCommunityId),
    [binding, communities, selectedCommunityId],
  );
  useEffect(() => { setValues({}); }, [communityId]);
  useEffect(() => {
    let active = true;
    setLeague(null); setLeagueError(null);
    if (initialState || !communityId || bindingLoading || bindingError || selectionError || !presentPlayers.length) { setLeagueLoading(false); return; }
    setLeagueLoading(true);
    void loadFprCommunityLeague({ communityId, communityName, players: presentPlayers,
      fetchLevels: async () => {
        const result = await apiFetchFprStartRatings(presentPlayers.map(p => p.id));
        if (result.error || !result.data) throw new Error(result.error?.message || "Не удалось загрузить стартовые уровни ЦУП");
        return result.data;
      },
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
  }, [communityId, communityName, presentPlayers, bindingLoading, bindingError, selectionError, organizerId, organizerPhone, reload, initialState]);
  const frozen = (p: Player): FprLeagueValue | undefined => {
    const saved = initialState?.players.find(player => player.id === p.id);
    return saved ? { level: String(saved.level), points: String(saved.leaguePoints), place: saved.leaguePlace === null ? "" : String(saved.leaguePlace), newcomer: saved.leaguePlace === null } : undefined;
  };
  const get = (p: Player): FprLeagueValue => ({
    ...(frozen(p) ?? league?.values[p.id] ?? { level: "", points: "", place: "", newcomer: false }), ...values[p.id],
  });
  const change = (p: Player, update: Partial<FprLeagueValue>) => setValues(v => ({ ...v, [p.id]: { ...v[p.id], ...update } }));
  const save = async () => {
    if (busy) return;
    setError(null);
    try {
      let payload = pending;
      if (!payload) {
        if (!league || league.communityId !== communityId || leagueLoading || bindingLoading || bindingError || selectionError) throw new Error("Дождитесь загрузки рейтинга сообщества");
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
          fprCanonicalStart: league.canonicalStart,
        });
        payload = {
          tournamentId: id, tournamentType: "fpr_6x25", tenantKey: context.tenantKey, createdAt: now,
          organizer: context.organizer, targetScore: 25, courts: state.courts,
          participants: presentPlayers.map(p => ({ id: p.id, name: p.name, rating: get(p).level, phone: p.phone ?? null, photo: p.photo ?? null })),
          params: projected.params, rounds: projected.rounds,
        };
        setPending(payload);
      }
      setBusy(true);
      const response = await apiCreateAmericanoTournament(payload);
      const readback = await apiFetchTournamentHistory(payload.tournamentId, { forceRefresh: true });
      if (readback.error) {
        if (response.status === 409) { setPending(null); setReload(v => v + 1); }
        throw new Error(readback.error.message);
      }
      const record = readback.data?.find(item => tournamentEventId(item) === tournamentEventId(payload!) && item.tournamentType === "fpr_6x25");
      const saved = record?.params?.fpr6x25;
      if (!record || !saved) {
        if (response.status === 409) { setPending(null); setReload(v => v + 1); }
        throw new Error(response.error?.message || "Создание не подтверждено. Повторите загрузку турнира.");
      }
      validateFprState(saved);
      // A retry may discover a protocol that was already saved/started elsewhere.
      // Open that authoritative protocol rather than replaying the setup snapshot.
      payload = { ...payload, tournamentId: record.tournamentId, participants: record.participants.map(p => ({ ...p, id: p.id! })), courts: record.courts,
        organizer: { ...payload.organizer, id: record.organizer?.id ?? payload.organizer.id }, params: record.params ?? undefined,
        rounds: record.rounds as AmericanoTournamentPayload["rounds"] };
      onSaved(payload);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const loading = bindingLoading || leagueLoading || (!fixedCommunity && communityLoading);
  const loadError = bindingError || selectionError || leagueError || (!fixedCommunity ? communityError : null);
  return <div className="fpr-panel">
    <fieldset disabled={Boolean(initialState) || busy || Boolean(pending)}>
      {fixedCommunity ? <>
        <p><strong>Опубликован в сообществе:</strong> {publishedNames.length ? publishedNames.join(", ") : communityName}</p>
        {publishedNames.length > 1 && communityId && <p><strong>Сообщество для рейтинга:</strong> {communityName}</p>}
      </> : !bindingLoading && !bindingError && <label>Сообщество «Время на друзей» для рейтинга
        <select value={communityId} disabled={communityLoading} onChange={e => setSelectedCommunityId(e.target.value)}>
          <option value="">Выберите сообщество</option>
          {choices.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
        </select>
      </label>}
      {loading && <p role="status">Загружаем данные сообщества…</p>}
      {loadError && <p role="alert" className="fpr-error">{loadError} <button type="button" onClick={() => setReload(v => v + 1)}>Повторить загрузку</button></p>}
      {!loading && !loadError && !choices.length && !fixedCommunity && <p>Нет доступных сообществ «Время на друзей» для выбора.</p>}
      <label className="fpr-check"><input type="checkbox" checked={reserve} onChange={e => setReserve(e.target.checked)} /> Разрешены 7-й и 8-й раунды при выполнении порога времени</label>
      <p>В составе: {presentPlayers.length} из {players.length}. Кортов одновременно: {Math.floor(presentPlayers.length / 4)}. Отдыхает в раунде: {presentPlayers.length % 4}.</p>
      {Array.from({ length: Math.floor(presentPlayers.length / 4) }, (_, i) => <label key={i}>Название корта {i + 1}<input value={courtValues[i] ?? `Корт №${i + 1}`} onChange={e => setCourtValues(v => ({ ...v, [i]: e.target.value }))} /></label>)}
      <details>
        <summary>Состав и снимок рейтинга · {presentPlayers.length} участников{league ? " · заполнено автоматически" : ""}</summary>
        <p>Стартовые уровни загружены из ЦУП. Места и очки загружены из сообщества: их можно исправить и отметить отсутствующих игроков. Если игрока нет и в таблице за всё время, отмечается отсутствие очков.</p>
        <div className="fpr-scroll"><table>
          <thead><tr><th>В составе</th><th>Участник / ID</th><th>Уровень</th><th>Место в Лиге</th><th>Очки Лиги</th><th>Без очков Лиги</th></tr></thead>
          <tbody>{players.map(p => <tr key={p.id}>
            <td><input aria-label={`В составе: ${p.name}`} type="checkbox" checked={included[p.id] !== false} onChange={e => setIncluded(v => ({ ...v, [p.id]: e.target.checked }))} /></td>
            <th scope="row">{p.name}<small>{p.id}</small></th>
            <td><input aria-label={`Уровень: ${p.name}`} readOnly value={get(p).level} /></td>
            <td><input aria-label={`Место в Лиге: ${p.name}`} inputMode="numeric" disabled={get(p).newcomer} value={get(p).place} onChange={e => change(p, { place: e.target.value })} /></td>
            <td><input aria-label={`Очки Лиги: ${p.name}`} inputMode="decimal" disabled={get(p).newcomer} value={get(p).points} onChange={e => change(p, { points: e.target.value })} /></td>
            <td><input aria-label={`Нет очков Лиги: ${p.name}`} type="checkbox" checked={get(p).newcomer} onChange={e => change(p, { newcomer: e.target.checked })} /></td>
          </tr>)}</tbody>
        </table></div>
      </details>
    </fieldset>
    {initialState && <p>Настройки сохранённого турнира. Состав и результаты сохранены.</p>}
    {error && <p role="alert" className="fpr-error">{error}</p>}
    {initialState ? <button className="section-cta" type="button" onClick={onResume}>Вернуться к турниру</button> : <button className="section-cta" type="button" disabled={busy || (!pending && (loading || Boolean(loadError) || !league)) || presentPlayers.length < 4 || presentPlayers.length > 28 || !organizerId} onClick={() => void save()}>
      {busy ? "Сохраняем протокол…" : pending ? "Повторить создание с тем же ID" : "Создать протокол ФПР 6×25"}
    </button>}
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
  return <div className="tournament-match-header">
    <div className="tournament-match-court"><span className="tournament-match-value">{state.courts[match.courtIndex]}</span></div>
  </div>;
}
function MatchEditor({ match, state, closed, disabled, onSave, autoCloseRound = true, onDirtyChange }: {
  match: FprMatch; state: FprState; closed: boolean; disabled: boolean;
  autoCloseRound?: boolean;
  onDirtyChange?: (matchId: string, dirty: boolean) => void;
  onSave: (value: Omit<ScoreAction, "id" | "expectedRevision">) => void;
}) {
  const [score1, setScore1] = useState(match.score1?.toString() ?? "");
  const [score2, setScore2] = useState(match.score2?.toString() ?? "");
  const [reason, setReason] = useState("");
  useEffect(() => () => onDirtyChange?.(match.id, false), [match.id, onDirtyChange]);
  const names = (ids: string[]) => ids.map(id => state.players.find(p => p.id === id)?.name ?? id).join(" + ");
  const played = (match.score1 ?? 0) + (match.score2 ?? 0);
  const serve = !closed && played < 25 ? fprServeAt(match, played) : null;
  const total = number(score1) + number(score2);
  const validScore = score1.trim() && score2.trim() && Number.isInteger(number(score1)) && Number.isInteger(number(score2))
    && number(score1) >= 0 && number(score2) >= 0 && total <= 25 && (!closed || total === 25);
  const saved = match.score1 !== null && match.score2 !== null && number(score1) === match.score1 && number(score2) === match.score2;
  const changeScore = (team: 1 | 2, value: string) => {
    if (!value.trim()) {
      setScore1(""); setScore2("");
      onDirtyChange?.(match.id, match.score1 !== null || match.score2 !== null);
      return;
    }
    const parsed = Math.max(0, Math.min(25, Number.parseInt(value, 10) || 0));
    (team === 1 ? setScore1 : setScore2)(String(parsed));
    (team === 1 ? setScore2 : setScore1)(String(25 - parsed));
    const next1 = team === 1 ? parsed : 25 - parsed, next2 = 25 - next1;
    onDirtyChange?.(match.id, next1 !== match.score1 || next2 !== match.score2);
  };
  return <section className="tournament-match fpr-match" aria-label={`Матч: ${state.courts[match.courtIndex]}`}>
    <MatchHeader match={match} state={state} />
    <fieldset disabled={disabled}>
      <div className="tournament-match-row">
        <span className="tournament-match-label">Пара 1</span>
        <span className="tournament-match-value">{names(match.pair1)}{serve && match.pair1.includes(serve.playerId) && <span className="fpr-serving-pair" role="img" aria-label="Подаёт пара 1" title={`Следующая подача по сохранённому счёту: ${names([serve.playerId])}`}>🎾</span>}</span>
        <input className="tournament-score-input" aria-label={`Счёт: ${names(match.pair1)}`} type="number" min="0" max="25" step="1" value={score1} onChange={e => changeScore(1, e.target.value)} />
      </div>
      <div className="tournament-match-row">
        <span className="tournament-match-label">Пара 2</span>
        <span className="tournament-match-value">{names(match.pair2)}{serve && match.pair2.includes(serve.playerId) && <span className="fpr-serving-pair" role="img" aria-label="Подаёт пара 2" title={`Следующая подача по сохранённому счёту: ${names([serve.playerId])}`}>🎾</span>}</span>
        <input className="tournament-score-input" aria-label={`Счёт: ${names(match.pair2)}`} type="number" min="0" max="25" step="1" value={score2} onChange={e => changeScore(2, e.target.value)} />
      </div>
      {closed && <label>Причина исправления<input value={reason} onChange={e => setReason(e.target.value)} /></label>}
      <div className="tournament-match-actions">
      <div className="tournament-match-status" aria-live="polite">{saved && <span className="tournament-round-status saved">Сохранено</span>}</div>
      <button className="tournament-round-save" type="button" disabled={!validScore || (closed && !reason.trim())} onClick={() => onSave({
        action: closed ? "correct_score" : "score", matchId: match.id, score1: number(score1), score2: number(score2), confirmed1: total === 25, confirmed2: total === 25,
        ...(!closed ? { startIfScheduled: true, autoCloseRound, recordResult: true } : {}),
        ...(closed ? { reason } : {}),
      })}>Сохранить</button>
      </div>
    </fieldset>
  </section>;
}

export function FprTournamentManager({ data, onClose, onDataChange, onEditSettings }: {
  data: AmericanoTournamentPayload; onClose: () => void; onDataChange: (payload: AmericanoTournamentPayload) => void;
  onEditSettings?: () => void;
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
  const [dirtyMatches, setDirtyMatches] = useState<Record<string, boolean>>({});
  const handleDirtyChange = useCallback((matchId: string, dirty: boolean) => {
    setDirtyMatches(previous => {
      if (Boolean(previous[matchId]) === dirty) return previous;
      const next = { ...previous };
      if (dirty) next[matchId] = true; else delete next[matchId];
      return next;
    });
  }, []);
  const [tab, setTab] = useState<"round" | "table" | "protocol">("round");
  const [reason, setReason] = useState("");
  const [withdrawId, setWithdrawId] = useState("");
  const [finishConfirmation, setFinishConfirmation] = useState(false);
  const [broadcastSelectionOpen, setBroadcastSelectionOpen] = useState(false);
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
      if (isRejectedFprCommand(response)) clearPending();
      if (response.status == null || response.status < 200 || response.status >= 300) throw new Error(response.error?.message || "Сохранение не подтверждено. Повторите эту команду или проверьте сервер.");
      const next = response.data?.params?.fpr6x25;
      validateFprState(next);
      if (next.tournamentId !== data.tournamentId || !next.audit.some(a => a.id === command.id)
        || next.revision <= command.expectedRevision) throw new Error("Сервер вернул протокол без подтверждения этой команды. Проверьте актуальный протокол перед повтором.");
      applyResponse(next); clearPending(); setReason(""); setFinishConfirmation(false);
      if (command.action === "score" && command.autoCloseRound === true) {
        const scoredAttempt = next.attempts.find(a => a.matches.some(m => m.id === command.matchId));
        if (scoredAttempt?.status === "running" && scoredAttempt.matches.every(m => m.confirmed1 && m.confirmed2)) {
          setError("Счёт сохранён, но автоматически закрыть раунд не удалось. Обновите протокол с сервера.");
        }
      }
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
  const supplementaryControls = <>
    {state && <button type="button" onClick={() => download({ kind: "fpr6x25-protocol", state, pendingCommand: pending, standings: fprStandings(state) }, `${data.tournamentId}-protocol.json`)}>Скачать протокол и таблицу JSON</button>}
    <button type="button" disabled={busy} onClick={() => void reload()}>{busy ? "Проверяем…" : "Прочитать актуальный протокол с сервера"}</button>
    <TournamentBroadcastControl key={data.tournamentId} tournamentId={data.tournamentId} stationId={data.params?.stationId} initialState={data.params?.broadcast} onDialogChange={setBroadcastSelectionOpen} />
  </>;
  return <Modal isOpen onClose={() => { if (!broadcastSelectionOpen) onClose(); }} title={`ФПР 6×25${state?.testMode ? " · тестовое проведение" : ""}`} variant="fullscreen" bodyClassName="tournament-settings-modal-body"
    headerAction={state && onEditSettings ? <button type="button" className="modal-close fpr-settings-button" disabled={disabled} onClick={onEditSettings} aria-label="Настройки турнира" title="Настройки турнира">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button> : undefined}>
    <div className="tournament-manager fpr-panel">
      {!state ? <p role="alert">Протокол ФПР повреждён или имеет другую версию. Загрузите его с сервера.</p> : <>
        <div className="tournament-manager-meta"><span className="tournament-manager-chip strong">ФПР 6×25</span><span className="tournament-manager-chip">25 очков на матч</span><span className="tournament-manager-chip">{state.players.length} игроков</span><span className="tournament-manager-chip">Кортов: {state.courts.length}</span></div>
        {!finished && Date.parse(now) >= Date.parse(state.endsAt) - 180_000 && <p role="alert" className="fpr-error">Время турнира закончилось. Сохраните сыгранные результаты и завершите турнир.</p>}
        <div className="tournament-tabs" role="group" aria-label="Раздел протокола">
          {([["round", "Турнир"], ["table", "Таблица"], ["protocol", "Протокол"]] as const).map(([key, label]) => <button className={`tournament-tab${tab === key ? " active" : ""}`} type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        {tab === "round" && <>
          {state.attempts.filter(a => a.id !== current?.id).map(a => <details aria-label={`Раунд ${a.round} · попытка ${a.attempt}`} className={`tournament-round ${a.status === "closed" ? "saved" : "unsaved"}`} key={a.id}>
            <summary className="tournament-round-header"><span className="tournament-round-title">Раунд {a.round} · попытка {a.attempt}</span><span className="tournament-round-status">{a.status === "closed" ? "Сохранено" : "Отменён"}</span></summary>
            <div className="tournament-round-body"><p>Отдых: {a.byes.map(name).join(", ") || "нет"}. {a.reason}</p>{a.matches.map(m => a.status === "closed"
              ? <MatchEditor key={`${m.id}:${m.score1}:${m.score2}:${m.confirmed1}:${m.confirmed2}`} match={m} state={state} closed disabled={disabled} onSave={act} />
              : <section className="tournament-match fpr-match" key={m.id}><MatchHeader match={m} state={state} /><p>{m.pair1.map(name).join(" + ")} — {m.pair2.map(name).join(" + ")}: {m.score1 ?? "—"}:{m.score2 ?? "—"}</p></section>)}</div>
          </details>)}
          {current ? <div className="tournament-rounds"><section aria-label={`Раунд ${current.round} · попытка ${current.attempt}`} className="tournament-round unsaved">
            <div className="tournament-round-header"><div className="tournament-round-heading"><span className="tournament-round-title">Раунд {current.round}{current.round >= 7 ? " · запасной" : ""}</span><span className="tournament-round-meta-text">Попытка {current.attempt}</span></div><span className="tournament-round-status">{current.status === "scheduled" ? "Готов к старту" : "В игре"}</span></div>
            <div className="tournament-round-body">
            <p>Отдых: {current.byes.length ? current.byes.map(name).join(", ") : "нет"}.</p>
            {current.matches.map(m => <MatchEditor key={`${m.id}:${m.score1}:${m.score2}:${m.confirmed1}:${m.confirmed2}`} match={m} state={state} closed={false} disabled={disabled} onSave={act}
              autoCloseRound={!current.matches.some(other => other.id !== m.id && dirtyMatches[other.id])} onDirtyChange={handleDirtyChange} />)}
            </div>
          </section></div> : !finished && state.attempts.length < 100 && completed < 8 && Date.parse(now) < Date.parse(state.endsAt) - 180_000 ? <>
            <p>{completed >= 6 ? `Запасной раунд: нужно не меньше ${Math.ceil((threshold?.requiredMs ?? 0) / 60_000)} мин до конца события; осталось ${Math.max(0, Math.floor((threshold?.remainingMs ?? 0) / 60_000))} мин.` : "Предыдущая попытка отменена. Можно подготовить повтор с тем же номером зачётного раунда."}</p>
            <button type="button" disabled={disabled || (completed >= 6 && !threshold?.allowed)} onClick={() => act({ action: "prepare_round" })}>Подготовить {completed + 1}-й раунд</button>
          </> : null}
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
          <div className="fpr-scroll"><table><thead><tr><th>Место</th><th>Участник</th><th>Победы</th><th>Очки</th><th>Матчи</th><th>Отдых</th><th>Очные серии</th><th>Лига до старта</th><th>Статус</th></tr></thead>
            <tbody>{fprStandings(state).map(p => <tr key={p.id}><td>{p.rank ?? "—"}</td><th scope="row">{p.name}</th><td>{p.wins}</td><td>{p.totalPoints}</td><td>{p.matchesPlayed}</td><td>{p.byeCount}</td><td>{p.headToHead ?? "не применялись"}</td><td>{p.leaguePoints}</td><td>{p.status === "DNF" ? "DNF" : p.status === "no_matches" ? "нет матчей" : "в зачёте"}</td></tr>)}</tbody>
          </table></div>
        </>}
        {tab === "protocol" && <>
          <p>Алгоритм: {state.version}. Источник: {state.leagueSource}. Снимок: {new Date(state.leagueSnapshotAt).toLocaleString("ru-RU")}.</p>
          <div className="fpr-scroll"><table><thead><tr><th>Посев</th><th>Участник</th><th>Уровень</th><th>Место Лиги</th><th>Очки Лиги</th><th>Жребий отдыха</th></tr></thead><tbody>{state.players.map(p => <tr key={p.id}><td>{p.seed}</td><th scope="row">{p.name}</th><td>{p.level}</td><td>{p.leaguePlace ?? "без очков"}</td><td>{p.leaguePoints}</td><td>{p.restLot}</td></tr>)}</tbody></table></div>
          <h3>Попытки и исправления</h3>
          {state.attempts.map(a => <details key={a.id}><summary>Раунд {a.round} · попытка {a.attempt} · {a.status === "closed" ? "зачтён" : a.status === "cancelled" ? "отменён" : a.status === "running" ? "идёт" : "подготовлен"}</summary>
            <p>{a.startedAt ? new Date(a.startedAt).toLocaleString("ru-RU") : "Не стартовал"}{a.finishedAt ? ` → ${new Date(a.finishedAt).toLocaleTimeString("ru-RU")}` : ""}. {a.reason}</p>
            <p>Отдых: {a.byes.map(name).join(", ") || "нет"}. Окно: {a.window ?? "первый посев / один корт"}.</p>
            {a.matches.map(m => a.status === "closed" ? <MatchEditor key={`${m.id}:${m.score1}:${m.score2}:${m.confirmed1}:${m.confirmed2}`} match={m} state={state} closed disabled={disabled} onSave={act} /> : <p key={m.id}>{m.pair1.map(name).join(" + ")} — {m.pair2.map(name).join(" + ")}: {m.score1 ?? "—"}:{m.score2 ?? "—"}</p>)}
          </details>)}
          <ol>{state.audit.map(a => <li key={a.id}>{new Date(a.at).toLocaleTimeString("ru-RU")} · {a.action}{a.detail ? ` · ${a.detail}` : ""}</li>)}</ol>
        </>}
      </>}
      {pending && <div role="status"><p>Есть команда без подтверждённого ответа сервера. Новые действия временно заблокированы.</p><button type="button" disabled={busy} onClick={() => void send(pending)}>Повторить ту же команду</button></div>}
      {error && <p role="alert" className="fpr-error">{error}</p>}
      {tab === "table" && state ? <details className="fpr-more">
        <summary>Подробнее</summary>
        <div className="fpr-more-content">
          <HeadToHeadDetails state={state} />
          <p>Таблица учитывает только закрытые общие раунды. {state.testMode ? "Это тестовый протокол без начислений." : "Очки сообщества рассчитываются по обычным правилам опубликованных турниров после полного завершения."} Уровень игрока рассчитывается по обычным правилам завершённого турнира.</p>
          {supplementaryControls}
        </div>
      </details> : supplementaryControls}
    </div>
  </Modal>;
}
