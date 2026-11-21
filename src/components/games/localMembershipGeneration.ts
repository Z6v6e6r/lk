export function createLocalMembershipId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local:${crypto.randomUUID()}`;
  }

  return `local:${Date.now()}:${Math.random().toString(36).slice(2, 12)}:${Math.random().toString(36).slice(2, 12)}`;
}

// Only use with a new local membership and roster in the same versioned PATCH.
// These arrays block roster sync; the separate operation/audit history is retained.
export function clearPreviousLeaveEventsForLocalJoin(
  metadata: Record<string, unknown>,
  player: { id?: string | null; phone?: string | null },
): Record<string, unknown> {
  const normalizeId = (value: unknown) => typeof value === "string"
    ? value.trim().toLowerCase() || null
    : null;
  const normalizePhone = (value: unknown) => {
    const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
    if (digits.length === 10) return `7${digits}`;
    if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
    return digits || null;
  };
  const playerId = normalizeId(player.id);
  const playerPhone = normalizePhone(player.phone);
  const nextMetadata = { ...metadata };

  for (const key of ["leaveEvents", "playerLeaveEvents", "leftPlayers"]) {
    const events = metadata[key];
    if (!Array.isArray(events)) continue;
    nextMetadata[key] = events.filter((event: unknown) => {
      if (!event || typeof event !== "object" || Array.isArray(event)) return true;
      const row = event as Record<string, unknown>;
      const eventId = normalizeId(row.playerId) ?? normalizeId(row.id);
      // Match server leave identity rules: conflicting IDs never match by phone.
      if (playerId && eventId) return playerId !== eventId;
      const eventPhone = normalizePhone(row.playerPhone) ?? normalizePhone(row.phone);
      return !playerPhone || playerPhone !== eventPhone;
    });
  }
  return nextMetadata;
}
