import type { TournamentBroadcastState, TournamentBroadcastStateRequest, TournamentBroadcastTarget } from "../../utils/apiClient";
import { getTournamentBroadcastTargetOptions, isTournamentBroadcastTarget, normalizeTournamentBroadcastTargets, resolveTournamentBroadcastStationId } from "./tournamentBroadcast.ts";

type Reply = { data?: TournamentBroadcastState | null; error?: { message?: string } | null };
type NormalizedState = TournamentBroadcastState & {
  operationInProgress: boolean; recoveryRequired: boolean; needsStop: boolean;
};
export type TournamentBroadcastSnapshot = NormalizedState & {
  loading: boolean; checking: boolean; verified: boolean; online: boolean; error: string | null;
};

function normalize(input: unknown, tournamentId: string, now: number): NormalizedState {
  const raw = input && typeof input === "object" ? input as Partial<TournamentBroadcastState> : {};
  const active = raw.active === true;
  const status = ["active", "inactive", "partial", "starting", "stopping"].includes(String(raw.status))
    ? raw.status! : active ? "active" : "inactive";
  const transition = status === "starting" || status === "stopping";
  const lease = String(raw.operationLeaseUntil ?? "").trim() || null;
  const operationInProgress = transition && raw.operationInProgress !== false && Date.parse(lease || "") > now;
  const recoveryRequired = raw.recoveryRequired === true || (transition && !operationInProgress);
  const partial = raw.partial === true || status === "partial";
  const fallback = transition
    ? operationInProgress ? "Операция выполняется. Дождитесь подтверждения." : "Операция не подтверждена. Остановите трансляцию, чтобы восстановить её состояние."
    : partial ? "Трансляция запущена не на всех выбранных экранах." : null;
  return {
    tournamentId, stationId: String(raw.stationId ?? "").trim() || null, active, status, partial,
    activeTargets: normalizeTournamentBroadcastTargets(raw.activeTargets),
    operationLeaseUntil: lease, operationInProgress, recoveryRequired,
    needsStop: active || transition || partial || recoveryRequired,
    message: transition && !operationInProgress ? fallback : String(raw.message ?? "").trim() || fallback,
    updatedAt: raw.updatedAt ?? null,
  };
}

export function createTournamentBroadcastController(options: {
  tournamentId: string; stationId?: unknown; initialState?: unknown; online?: boolean; now?: () => number;
  read: (tournamentId: string, stationId: string | null) => Promise<Reply>;
  write: (request: TournamentBroadcastStateRequest) => Promise<Reply>;
}) {
  const tournamentId = options.tournamentId.trim();
  const now = options.now ?? Date.now;
  let disposed = false, generation = 0;
  const listeners = new Set<(state: TournamentBroadcastSnapshot) => void>();
  let state: TournamentBroadcastSnapshot = {
    ...normalize(options.initialState, tournamentId, now()),
    loading: false, checking: false, verified: false, online: options.online !== false, error: null,
  };
  const emit = (change: Partial<TournamentBroadcastSnapshot>) => {
    if (disposed) return;
    state = { ...state, ...change };
    for (const listener of listeners) listener(state);
  };
  const current = (version: number) => !disposed && version === generation;
  const station = () => resolveTournamentBroadcastStationId(state.stationId, options.stationId, state.verified || state.needsStop) || null;
  const apply = (reply: Reply) => {
    if (reply.error || !reply.data) throw new Error(reply.error?.message || "Не удалось получить состояние трансляции");
    if (reply.data.tournamentId !== tournamentId) throw new Error("Сервер вернул состояние другого турнира");
    if (typeof reply.data.active !== "boolean" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(String(reply.data.stationId ?? ""))) {
      throw new Error("Сервер не подтвердил клуб и состояние трансляции");
    }
    const status = reply.data.status;
    if ((status != null && !["active", "inactive", "partial", "starting", "stopping"].includes(status))
      || (status === "active" && !reply.data.active) || (status === "inactive" && reply.data.active)
      || ((status === "starting" || status === "stopping") && reply.data.operationInProgress === true
        && !(Date.parse(reply.data.operationLeaseUntil ?? "") > now()))) {
      throw new Error("Сервер вернул несогласованное состояние трансляции");
    }
    emit({ ...normalize(reply.data, tournamentId, now()), verified: true });
  };
  const refresh = async () => {
    if (disposed || state.loading || state.checking || !state.online) return;
    const version = ++generation;
    emit({ checking: true, error: null });
    try {
      const reply = await options.read(tournamentId, station());
      if (current(version)) apply(reply);
    } catch (error) {
      if (current(version)) emit({ verified: false, error: error instanceof Error ? error.message : "Не удалось проверить трансляцию" });
    } finally { if (current(version)) emit({ checking: false }); }
  };
  const command = async (action: "start" | "stop", target?: TournamentBroadcastTarget): Promise<boolean> => {
    if (disposed || state.loading || state.checking || !state.online) return false;
    emit(normalize(state, tournamentId, now()));
    if (state.operationInProgress || (action === "start" ? !state.verified || state.needsStop : !state.needsStop)) return false;
    if (action === "start") {
      const choices = getTournamentBroadcastTargetOptions(station());
      if ((target !== undefined && !isTournamentBroadcastTarget(target)) || (choices.length > 0 && !choices.some(option => option.value === target))) {
        emit({ error: "Выберите экран для трансляции" }); return false;
      }
    }
    const version = ++generation;
    emit({ loading: true, error: null });
    try {
      const reply = await options.write({ tournamentId, stationId: station(), action, ...(action === "start" && target ? { target } : {}) } as TournamentBroadcastStateRequest);
      if (!current(version)) return false;
      apply(reply);
      const confirmed = action === "start" ? state.needsStop : !state.needsStop;
      if (!confirmed) emit({ error: state.message || "Изменение трансляции не подтверждено" });
      return confirmed;
    } catch (error) {
      if (!current(version)) return false;
      try {
        const reply = await options.read(tournamentId, station());
        if (!current(version)) return false;
        apply(reply);
      } catch {
        if (current(version)) emit({
          ...normalize({ ...state, active: true, status: action === "start" ? "starting" : "stopping", operationInProgress: false, recoveryRequired: true }, tournamentId, now()),
          verified: false,
        });
      }
      if (current(version)) emit({ error: error instanceof Error ? error.message : "Не удалось переключить трансляцию" });
      return false;
    } finally { if (current(version)) emit({ loading: false }); }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: (state: TournamentBroadcastSnapshot) => void) => {
      listeners.add(listener); listener(state);
      return () => { listeners.delete(listener); };
    },
    refresh, start: (target?: TournamentBroadcastTarget) => command("start", target), stop: () => command("stop"),
    reconcileLease: () => emit(normalize(state, tournamentId, now())),
    setOnline: (online: boolean) => emit({ online }),
    dispose: () => { disposed = true; generation += 1; listeners.clear(); },
  };
}
