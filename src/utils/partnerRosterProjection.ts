import type { PadelGamePlayer } from "./apiClient";

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function isNamedPartner(player: PadelGamePlayer): boolean {
  const membershipId = text(player.membershipId);
  return Boolean(membershipId
    && player.id === `partner:${membershipId}`
    && player.source === "PARTNER_API"
    && player.status === "CONFIRMED");
}

// Older roster PATCH clients discard booking fields. Recover only a unique,
// consistent binding from the server response; never expose payment details.
export function restorePartnerBookingBindings(
  participants: PadelGamePlayer[],
  rawPayments: unknown,
): PadelGamePlayer[] {
  const payments = Array.isArray(rawPayments) ? rawPayments.filter(record) : [];
  return participants.map((player) => {
    if (!isNamedPartner(player)) return player;
    const matching = payments.filter((payment) =>
      payment.membershipId === player.membershipId
      && payment.playerId === player.id
      && payment.settlementSource === "EXTERNAL_PARTNER"
      && payment.status === "PAID");
    if (matching.length === 0) return player;
    if (matching.length !== 1) return { ...player, vivaBookingId: null };
    const payment = matching[0];
    const bookingId = text(payment.bookingId);
    const conflicts = !bookingId
      || (player.vivaBookingId && player.vivaBookingId !== bookingId)
      || (player.membershipGeneration != null
        && player.membershipGeneration !== payment.membershipGeneration);
    return conflicts
      ? { ...player, vivaBookingId: null }
      : { ...player, vivaBookingId: bookingId };
  });
}

export function projectPartnerVivaRoster(
  sourceParticipants: PadelGamePlayer[],
  vivaParticipants: PadelGamePlayer[],
): {
  sourceParticipants: PadelGamePlayer[];
  vivaParticipants: PadelGamePlayer[];
  removedTechnicalDuplicates: number;
  canSync: boolean;
} {
  const byBooking = new Map<string, PadelGamePlayer[]>();
  sourceParticipants.forEach((player) => {
    if (!isNamedPartner(player)) return;
    const bookingId = text(player.vivaBookingId);
    if (bookingId) byBooking.set(bookingId, [...(byBooking.get(bookingId) ?? []), player]);
  });
  const providerBookingIds = vivaParticipants.map((player) => text(player.vivaBookingId));
  const hasPartner = sourceParticipants.some((player) => player.source === "PARTNER_API");
  const completeBookingIdentity = !hasPartner || providerBookingIds.every((id) => Boolean(id))
    && new Set(providerBookingIds).size === providerBookingIds.length;
  const canSync = completeBookingIdentity && sourceParticipants.every((player) => player.source !== "PARTNER_API"
    || (isNamedPartner(player) && Boolean(text(player.vivaBookingId))
      && byBooking.get(text(player.vivaBookingId))?.length === 1));
  if (!canSync) return { sourceParticipants, vivaParticipants: sourceParticipants, removedTechnicalDuplicates: 0, canSync };
  const replacements = new Map<PadelGamePlayer, PadelGamePlayer>();
  const replacedClientIds = new Set<string>();
  const unboundClientIds = new Set<string>();
  vivaParticipants.forEach((player) => {
    const matches = byBooking.get(text(player.vivaBookingId));
    // A booking must have exactly one named owner and one provider row.
    const uniqueProviderRow = vivaParticipants.filter((other) =>
      text(other.vivaBookingId) === text(player.vivaBookingId)).length === 1;
    if (matches?.length === 1 && uniqueProviderRow) {
      replacements.set(player, matches[0]);
      if (player.id) replacedClientIds.add(player.id);
    } else if (player.id) {
      unboundClientIds.add(player.id);
    }
  });
  const nextSource = sourceParticipants.filter((player) => {
    if (player.membershipId || !player.id
      || (player.source !== "ADMIN" && String(player.source) !== "VIVA")) return true;
    if (!replacedClientIds.has(player.id) || unboundClientIds.has(player.id)) return true;
    // Cached provider projections can omit bookings for a shared client.
    // Legacy rows without booking identity require a separate guarded repair.
    if (!player.vivaBookingId || !byBooking.has(player.vivaBookingId)) return true;
    return false;
  });
  return {
    sourceParticipants: nextSource,
    vivaParticipants: vivaParticipants.map((player) => replacements.get(player) ?? player),
    removedTechnicalDuplicates: sourceParticipants.length - nextSource.length,
    canSync,
  };
}
