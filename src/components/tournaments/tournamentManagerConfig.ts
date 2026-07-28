import type { PairedMexicanoPairAssignment } from "./americanoLab";

export type TournamentStandingsSortMode = "point_diff" | "total_points";

export type TournamentPairStandingsGroup<T> = {
  pairKey: string;
  rank: number;
  members: T[];
};

function normalizeText(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

export function resolveTournamentStandingsSortModeValue(value: unknown): TournamentStandingsSortMode | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  if (
    normalized === "total_points"
    || normalized === "points"
    || normalized === "points_for"
    || normalized === "pointsfor"
    || normalized === "по_очкам"
    || normalized === "набранные_очки"
    || normalized === "набранныеочки"
  ) {
    return "total_points";
  }

  if (
    normalized === "point_diff"
    || normalized === "points_diff"
    || normalized === "difference"
    || normalized === "diff"
    || normalized === "по_разнице"
    || normalized === "разница"
    || normalized === "разница_очков"
  ) {
    return "point_diff";
  }

  return null;
}

export function parseAmericanoStandingsSortMode(
  params: Record<string, unknown> | null | undefined,
  fallback: TournamentStandingsSortMode = "point_diff",
): TournamentStandingsSortMode {
  if (!params) return fallback;

  const keys = [
    "americanoStandingsSortMode",
    "standingsSortMode",
    "winnerSortMode",
    "sortMode",
    "rankBy",
  ];

  for (const key of keys) {
    const resolved = resolveTournamentStandingsSortModeValue(params[key]);
    if (resolved) return resolved;
  }

  return fallback;
}

export function resolveTournamentParticipantEntries<T>(
  activeParticipantBaseEntries: T[],
  organizerSlotParticipant?: T | null,
) {
  if (!organizerSlotParticipant) {
    return [...activeParticipantBaseEntries];
  }

  // Organizer is informational only and must join through the same roster flow as everyone else.
  return [...activeParticipantBaseEntries];
}

export function buildPairedTournamentStandingsGroups<T extends { id: string; rank: number }>(
  rows: T[],
  pairAssignments: PairedMexicanoPairAssignment[] | null | undefined,
): TournamentPairStandingsGroup<T>[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const rowOrderById = new Map(rows.map((row, index) => [row.id, index]));
  const groups: TournamentPairStandingsGroup<T>[] = [];
  const groupedIds = new Set<string>();
  const seenPairKeys = new Set<string>();

  if (Array.isArray(pairAssignments)) {
    pairAssignments.forEach((pair) => {
      const leftId = String(pair?.[0] ?? "").trim();
      const rightId = String(pair?.[1] ?? "").trim();
      if (!leftId || !rightId || leftId === rightId) return;

      const pairKey = [leftId, rightId].sort().join("::");
      if (seenPairKeys.has(pairKey)) return;
      seenPairKeys.add(pairKey);

      const members = [leftId, rightId]
        .map((playerId) => rowById.get(playerId))
        .filter((row): row is T => Boolean(row))
        .sort((left, right) => (
          (rowOrderById.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (rowOrderById.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        ));

      if (members.length === 0) return;

      members.forEach((member) => groupedIds.add(member.id));
      groups.push({
        pairKey,
        rank: members[0]?.rank ?? 0,
        members,
      });
    });
  }

  rows.forEach((row) => {
    if (groupedIds.has(row.id)) return;
    groups.push({
      pairKey: row.id,
      rank: row.rank,
      members: [row],
    });
  });

  return groups.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    const leftOrder = rowOrderById.get(left.members[0]?.id ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = rowOrderById.get(right.members[0]?.id ?? "") ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}
