import type {
  TournamentBroadcastActiveTarget,
  TournamentBroadcastTarget,
} from "../../utils/apiClient";

export const SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID =
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab";

export const NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID =
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab";

export const TOURNAMENT_BROADCAST_TARGET_OPTIONS: ReadonlyArray<{
  value: TournamentBroadcastTarget;
  label: string;
}> = [
  { value: "right_arena", label: "Правый манеж" },
  { value: "left_arena", label: "Левый манеж" },
  { value: "both", label: "Оба" },
];

export const NAGATINSKAYA_TOURNAMENT_BROADCAST_TARGET_OPTIONS: ReadonlyArray<{
  value: TournamentBroadcastTarget;
  label: string;
}> = [
  { value: "right_arena", label: "Экран Корт №1" },
  { value: "left_arena", label: "Экран Корт №7" },
  { value: "both", label: "Оба экрана" },
];

const TOURNAMENT_BROADCAST_TARGET_OPTIONS_BY_STATION = new Map<string, ReadonlyArray<{
  value: TournamentBroadcastTarget;
  label: string;
}>>([
  [SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID, TOURNAMENT_BROADCAST_TARGET_OPTIONS],
  [NAGATINSKAYA_TOURNAMENT_BROADCAST_STATION_ID, NAGATINSKAYA_TOURNAMENT_BROADCAST_TARGET_OPTIONS],
]);

const TOURNAMENT_BROADCAST_TARGET_LABELS = new Map(
  TOURNAMENT_BROADCAST_TARGET_OPTIONS.map((option) => [option.value, option.label]),
);

export function isSkolkovoTournamentBroadcastStation(stationId: unknown): boolean {
  return String(stationId ?? "").trim() === SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID;
}

export function resolveTournamentBroadcastStationId(
  serverStationId: unknown,
  payloadStationId: unknown,
  preferServerStation = false,
): string {
  const serverStation = String(serverStationId ?? "").trim();
  const rawPayloadStation = String(payloadStationId ?? "").trim();
  const payloadStation = /^local-studio:/i.test(rawPayloadStation) ? "" : rawPayloadStation;
  return preferServerStation
    ? serverStation || payloadStation
    : payloadStation || serverStation;
}

export function getTournamentBroadcastTargetOptions(stationId: unknown) {
  return TOURNAMENT_BROADCAST_TARGET_OPTIONS_BY_STATION.get(String(stationId ?? "").trim()) ?? [];
}

export function isTournamentBroadcastTargetSelectionStation(stationId: unknown): boolean {
  return getTournamentBroadcastTargetOptions(stationId).length > 0;
}

export function isTournamentBroadcastTarget(value: unknown): value is TournamentBroadcastTarget {
  return typeof value === "string" && TOURNAMENT_BROADCAST_TARGET_LABELS.has(value as TournamentBroadcastTarget);
}

export function normalizeTournamentBroadcastTargets(value: unknown): TournamentBroadcastActiveTarget[] {
  if (!Array.isArray(value)) return [];

  const targets = new Set(value.filter((target): target is TournamentBroadcastActiveTarget => (
    target === "right_arena" || target === "left_arena"
  )));
  const orderedTargets: TournamentBroadcastActiveTarget[] = ["right_arena", "left_arena"];
  return orderedTargets.filter((target) => targets.has(target));
}

export function formatTournamentBroadcastTargets(value: unknown, stationId?: unknown): string | null {
  const options = getTournamentBroadcastTargetOptions(stationId);
  const labelsByTarget = options.length > 0
    ? new Map(options.map((option) => [option.value, option.label]))
    : TOURNAMENT_BROADCAST_TARGET_LABELS;
  const labels = normalizeTournamentBroadcastTargets(value)
    .map((target) => labelsByTarget.get(target))
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(", ") : null;
}
