import type {
  TournamentBroadcastActiveTarget,
  TournamentBroadcastTarget,
} from "../../utils/apiClient";

export const SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID =
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab";

export const TOURNAMENT_BROADCAST_TARGET_OPTIONS: ReadonlyArray<{
  value: TournamentBroadcastTarget;
  label: string;
}> = [
  { value: "right_arena", label: "Правый манеж" },
  { value: "left_arena", label: "Левый манеж" },
  { value: "both", label: "Оба" },
];

const TOURNAMENT_BROADCAST_TARGET_LABELS = new Map(
  TOURNAMENT_BROADCAST_TARGET_OPTIONS.map((option) => [option.value, option.label]),
);

export function isSkolkovoTournamentBroadcastStation(stationId: unknown): boolean {
  return String(stationId ?? "").trim() === SKOLKOVO_TOURNAMENT_BROADCAST_STATION_ID;
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

export function formatTournamentBroadcastTargets(value: unknown): string | null {
  const labels = normalizeTournamentBroadcastTargets(value)
    .map((target) => TOURNAMENT_BROADCAST_TARGET_LABELS.get(target))
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(", ") : null;
}
