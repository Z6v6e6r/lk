import type { PadelGamePlayer } from "../../utils/apiClient";

type ComparableRosterPlayer = Pick<PadelGamePlayer, "id" | "phone" | "name"> | null | undefined;

export type RosterSyncLeaveEvent = {
  playerId: string | null;
  playerPhone: string | null;
  leftAt: string;
  reason: string | null;
  byId: string | null;
  byPhone: string | null;
  byName: string | null;
  playerName: string | null;
};

export type RosterSyncReconcileResult = {
  mergedCandidates: PadelGamePlayer[];
  nextLeaveEvents: RosterSyncLeaveEvent[];
  staleLeaveEventsRemoved: number;
  filteredSourcePlayersCount: number;
  staleSourcePlayersRemoved: number;
};

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function normalizeComparableId(value: unknown): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.toLowerCase();
}

function normalizeComparableName(value: unknown): string | null {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function isGenericComparableName(value: string | null | undefined): boolean {
  const normalized = normalizeComparableName(value);
  if (!normalized) return true;
  return [
    "игрок",
    "организатор",
    "участник",
    "player",
    "participant",
    "organizer",
  ].includes(normalized);
}

export function playersShareRosterIdentity(
  left: ComparableRosterPlayer,
  right: ComparableRosterPlayer,
): boolean {
  if (!left || !right) return false;

  const leftId = normalizeComparableId(left.id);
  const rightId = normalizeComparableId(right.id);
  if (leftId && rightId && leftId === rightId) return true;

  const leftPhone = normalizePhone(left.phone);
  const rightPhone = normalizePhone(right.phone);
  if (leftPhone && rightPhone && leftPhone === rightPhone) return true;

  const leftName = normalizeComparableName(left.name);
  const rightName = normalizeComparableName(right.name);
  if (!leftName || !rightName || leftName !== rightName) return false;
  if (isGenericComparableName(leftName) || isGenericComparableName(rightName)) return false;

  if (leftId && rightId && leftId !== rightId) return false;
  if (leftPhone && rightPhone && leftPhone !== rightPhone) return false;

  const leftHasStrongIdentity = Boolean(leftId || leftPhone);
  const rightHasStrongIdentity = Boolean(rightId || rightPhone);
  if (!leftHasStrongIdentity || !rightHasStrongIdentity) return true;

  return !leftId || !rightId || !leftPhone || !rightPhone;
}

export function excludePlayersAlreadyInRoster(
  players: PadelGamePlayer[],
  roster: PadelGamePlayer[],
): PadelGamePlayer[] {
  return players.filter((player) => !roster.some((item) => playersShareRosterIdentity(item, player)));
}

function mergePlayer(existing: PadelGamePlayer, incoming: PadelGamePlayer): PadelGamePlayer {
  const existingId = normalizeComparableId(existing.id);
  const incomingId = normalizeComparableId(incoming.id);
  const existingPhone = normalizePhone(existing.phone);
  const incomingPhone = normalizePhone(incoming.phone);
  const sameComparableId = Boolean(existingId && incomingId && existingId === incomingId);

  return {
    id: existing.id || incoming.id || null,
    name: isGenericComparableName(existing.name) && !isGenericComparableName(incoming.name)
      ? incoming.name
      : (existing.name || incoming.name || "Игрок"),
    phone: (
      incomingPhone
      && (!existingPhone || sameComparableId || (!existingId && incomingId))
    ) ? incoming.phone : (existing.phone || incoming.phone || null),
    photo: existing.photo || incoming.photo || null,
    rating: existing.rating || incoming.rating || null,
    ratingNumeric: existing.ratingNumeric ?? incoming.ratingNumeric ?? null,
    source: existing.source || incoming.source,
    status: existing.status || incoming.status,
  };
}

function dedupePlayers(players: PadelGamePlayer[]): PadelGamePlayer[] {
  type PlayerAggregate = {
    player: PadelGamePlayer;
    ids: Set<string>;
    phones: Set<string>;
    names: Set<string>;
  };

  const byId = new Map<string, PlayerAggregate>();
  const byPhone = new Map<string, PlayerAggregate>();
  const byName = new Map<string, PlayerAggregate>();
  const out: PlayerAggregate[] = [];

  players.forEach((player) => {
    const id = normalizeComparableId(player.id);
    const phone = normalizePhone(player.phone);
    const name = normalizeComparableName(player.name);
    const hasStrongIdentity = Boolean(id || phone);

    let aggregate: PlayerAggregate | undefined;
    if (id) aggregate = byId.get(id);
    if (!aggregate && phone) {
      const byPhoneCandidate = byPhone.get(phone);
      const hasConflictingStrongId = Boolean(
        byPhoneCandidate
        && id
        && byPhoneCandidate.ids.size > 0
        && !byPhoneCandidate.ids.has(id),
      );
      if (!hasConflictingStrongId) {
        aggregate = byPhoneCandidate;
      }
    }
    if (!aggregate && name && !isGenericComparableName(name)) {
      const byNameCandidate = byName.get(name);
      if (byNameCandidate) {
        const candidateHasStrongIdentity = byNameCandidate.ids.size > 0 || byNameCandidate.phones.size > 0;
        if (!candidateHasStrongIdentity || !hasStrongIdentity) {
          aggregate = byNameCandidate;
        }
      }
    }
    if (!aggregate) {
      aggregate = out.find((candidate) => playersShareRosterIdentity(candidate.player, player));
    }

    if (!aggregate) {
      aggregate = {
        player,
        ids: new Set<string>(),
        phones: new Set<string>(),
        names: new Set<string>(),
      };
      out.push(aggregate);
    } else {
      aggregate.player = mergePlayer(aggregate.player, player);
    }

    if (id) {
      aggregate.ids.add(id);
      byId.set(id, aggregate);
    }
    if (phone) {
      aggregate.phones.add(phone);
      byPhone.set(phone, aggregate);
    }
    if (name && !isGenericComparableName(name)) {
      aggregate.names.add(name);
      byName.set(name, aggregate);
    }
  });

  return out.map((aggregate) => aggregate.player);
}

export function reconcileRosterWithViva(params: {
  sourceParticipants: PadelGamePlayer[];
  vivaParticipants: PadelGamePlayer[];
  leaveEvents: RosterSyncLeaveEvent[];
  organizerPlayer?: ComparableRosterPlayer;
}): RosterSyncReconcileResult {
  const sourceParticipants = Array.isArray(params.sourceParticipants)
    ? params.sourceParticipants
    : [];
  const vivaParticipants = Array.isArray(params.vivaParticipants)
    ? params.vivaParticipants
    : [];
  const leaveEvents = Array.isArray(params.leaveEvents)
    ? params.leaveEvents
    : [];
  const organizerPlayer = params.organizerPlayer;

  const vivaIds = new Set(
    vivaParticipants
      .map((player) => normalizeComparableId(player.id))
      .filter((value): value is string => Boolean(value)),
  );
  const vivaPhones = new Set(
    vivaParticipants
      .map((player) => normalizePhone(player.phone))
      .filter((value): value is string => Boolean(value)),
  );

  const nextLeaveEvents = leaveEvents.filter((event) => {
    const leftId = normalizeComparableId(event.playerId);
    if (leftId && vivaIds.has(leftId)) return false;
    const leftPhone = normalizePhone(event.playerPhone);
    if (leftPhone && vivaPhones.has(leftPhone)) return false;
    return true;
  });

  const staleLeaveEventsRemoved = Math.max(0, leaveEvents.length - nextLeaveEvents.length);
  const activeLeaveIds = new Set(
    nextLeaveEvents
      .map((event) => normalizeComparableId(event.playerId))
      .filter((value): value is string => Boolean(value)),
  );
  const activeLeavePhones = new Set(
    nextLeaveEvents
      .map((event) => normalizePhone(event.playerPhone))
      .filter((value): value is string => Boolean(value)),
  );

  const filteredSourceParticipants = sourceParticipants.filter((player) => {
    const playerId = normalizeComparableId(player.id);
    if (playerId && activeLeaveIds.has(playerId)) return false;
    const playerPhone = normalizePhone(player.phone);
    if (playerPhone && activeLeavePhones.has(playerPhone)) return false;
    return true;
  });
  const nextSourceParticipants = filteredSourceParticipants.filter((player) => {
    const presentInViva = vivaParticipants.some((vivaPlayer) => playersShareRosterIdentity(vivaPlayer, player));
    if (presentInViva) return true;

    const source = String(player.source || "").trim().toUpperCase();
    // ADMIN players are imported from live Viva roster. If they disappeared from Viva and
    // there is no active leave-event for them, keeping them in LK creates a stale extra slot.
    if (source === "ADMIN") return false;
    if (source === "ORGANIZER" && organizerPlayer) {
      return playersShareRosterIdentity(organizerPlayer, player);
    }
    return true;
  });
  const staleSourcePlayersRemoved = Math.max(0, filteredSourceParticipants.length - nextSourceParticipants.length);

  return {
    mergedCandidates: dedupePlayers([...nextSourceParticipants, ...vivaParticipants]),
    nextLeaveEvents,
    staleLeaveEventsRemoved,
    filteredSourcePlayersCount: Math.max(0, sourceParticipants.length - filteredSourceParticipants.length),
    staleSourcePlayersRemoved,
  };
}
