import { useEffect, useRef, useState } from "react";
import { Modal } from "../UI/Modal";
import { apiFetchTournamentBroadcastState, apiSetTournamentBroadcastState, type TournamentBroadcastTarget } from "../../utils/apiClient";
import { formatTournamentBroadcastTargets, getTournamentBroadcastTargetOptions, resolveTournamentBroadcastStationId } from "./tournamentBroadcast";
import { createTournamentBroadcastController, type TournamentBroadcastSnapshot } from "./tournamentBroadcastController";

export function TournamentBroadcastControl({ tournamentId, stationId, initialState, onDialogChange }: {
  tournamentId: string; stationId?: unknown; initialState?: unknown; onDialogChange?: (open: boolean) => void;
}) {
  const controllerRef = useRef<ReturnType<typeof createTournamentBroadcastController> | null>(null);
  const initialRef = useRef(initialState);
  const [snapshot, setSnapshot] = useState<TournamentBroadcastSnapshot | null>(null);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<TournamentBroadcastTarget | null>(null);
  const payloadStation = String(stationId ?? "").trim();
  useEffect(() => { initialRef.current = initialState; }, [initialState]);
  useEffect(() => { onDialogChange?.(selectionOpen); }, [onDialogChange, selectionOpen]);
  useEffect(() => {
    const controller = createTournamentBroadcastController({
      tournamentId, stationId: payloadStation, initialState: initialRef.current,
      online: navigator.onLine, read: apiFetchTournamentBroadcastState, write: apiSetTournamentBroadcastState,
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    setSelectionOpen(false); setSelectedTarget(null);
    const online = () => { controller.setOnline(navigator.onLine); if (navigator.onLine) void controller.refresh(); };
    window.addEventListener("online", online); window.addEventListener("offline", online);
    void controller.refresh();
    return () => {
      unsubscribe(); controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      window.removeEventListener("online", online); window.removeEventListener("offline", online);
    };
  }, [tournamentId, payloadStation]);
  const state = snapshot?.tournamentId === tournamentId ? snapshot : null;
  useEffect(() => {
    if (!state?.operationInProgress || !state.operationLeaseUntil) return;
    const delay = Math.max(0, Date.parse(state.operationLeaseUntil) - Date.now()) + 50;
    const timer = window.setTimeout(() => controllerRef.current?.reconcileLease(), delay);
    return () => window.clearTimeout(timer);
  }, [state?.operationInProgress, state?.operationLeaseUntil]);
  const resolvedStation = resolveTournamentBroadcastStationId(state?.stationId, payloadStation, true);
  const targets = getTournamentBroadcastTargetOptions(resolvedStation);
  const activeLabel = formatTournamentBroadcastTargets(state?.activeTargets, resolvedStation);
  const blocked = !state || state.loading || state.checking || state.operationInProgress || !state.online;
  const startBlocked = blocked || (!state?.needsStop && !state?.verified);
  const toggle = () => {
    if (state?.needsStop) { void controllerRef.current?.stop(); return; }
    if (targets.length > 0) { setSelectedTarget(null); setSelectionOpen(true); return; }
    void controllerRef.current?.start();
  };
  const title = state?.status === "starting" ? "Запуск трансляции не подтверждён"
    : state?.status === "stopping" ? "Остановка трансляции выполняется"
    : activeLabel ? `Активные экраны: ${activeLabel}` : "Трансляция активна";
  return <div className="tournament-manager-footer">
    {state?.error && <div className="tournaments-error" role="alert">{state.error}</div>}
    {state?.needsStop && <div className={`tournament-manager-broadcast-state${state.recoveryRequired || state.partial || state.operationInProgress ? " is-partial" : ""}`} role={state.recoveryRequired || state.partial ? "alert" : "status"}>
      <div>{title}</div>{state.message && <div className="tournament-manager-broadcast-message">{state.message}</div>}
    </div>}
    {state && !state.online && <p role="status">Трансляция недоступна без соединения с интернетом.</p>}
    <button type="button" className={`section-cta tournament-manager-broadcast${state?.needsStop ? " is-active" : ""}`} disabled={startBlocked} aria-pressed={state?.needsStop === true} onClick={toggle}>
      {state?.loading ? state.needsStop ? "Останавливаем трансляцию..." : "Запускаем трансляцию..."
        : state?.checking || !state ? "Проверяем трансляцию..."
        : state.operationInProgress ? "Операция с трансляцией выполняется..."
        : state.needsStop ? "Остановить трансляцию результатов" : "Трансляция результатов"}
    </button>
    {state?.error && <button type="button" disabled={blocked} onClick={() => void controllerRef.current?.refresh()}>Обновить состояние трансляции</button>}
    <Modal isOpen={selectionOpen} onClose={() => { if (!state?.loading) setSelectionOpen(false); }} title="Где запустить трансляцию?" variant="dialog" bodyClassName="tournament-broadcast-target-dialog">
      <div className="tournament-broadcast-target-options" role="radiogroup" aria-label="Экран для трансляции">
        {targets.map(option => <label key={option.value} className={`tournament-broadcast-target-option${selectedTarget === option.value ? " is-selected" : ""}`}>
          <input type="radio" name="fpr-broadcast-target" value={option.value} checked={selectedTarget === option.value} onChange={() => setSelectedTarget(option.value)} disabled={blocked} />
          <span>{option.label}</span>
        </label>)}
      </div>
      {state?.error && <div className="tournaments-error" role="alert">{state.error}</div>}
      <div className="tournament-broadcast-target-actions">
        <button type="button" className="onboarding-btn onboarding-btn--secondary" disabled={state?.loading} onClick={() => setSelectionOpen(false)}>Отмена</button>
        <button type="button" className="onboarding-btn" disabled={!selectedTarget || startBlocked || state?.needsStop} onClick={() => {
          if (selectedTarget) void controllerRef.current?.start(selectedTarget).then(confirmed => { if (confirmed) setSelectionOpen(false); });
        }}>{state?.loading ? "Запускаем..." : "Запустить"}</button>
      </div>
    </Modal>
  </div>;
}
