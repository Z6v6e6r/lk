export type TournamentVivaProfileIdentity = {
  id: string | null | undefined;
  phone: string | null | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickString(value: Record<string, unknown> | null, keys: string[]) {
  if (!value) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]) {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

export function isTournamentVivaBookingOwnedByProfile(
  value: unknown,
  profile: TournamentVivaProfileIdentity,
) {
  if (!isRecord(value)) return false;
  const client = isRecord(value.client) ? value.client : null;
  const profilePhone = normalizePhone(profile.phone);
  const bookingPhone = normalizePhone(
    pickString(client, ["phone", "phoneNumber"])
    || pickString(value, ["phone", "clientPhone"]),
  );
  const profileId = String(profile.id || "").trim();
  const bookingClientId = pickString(client, ["id", "clientId"])
    || pickString(value, ["clientId"]);

  return Boolean(
    (profileId && bookingClientId && profileId === bookingClientId)
    || (profilePhone && bookingPhone && profilePhone === bookingPhone),
  );
}

export function selectTournamentVivaBooking(
  exerciseBookings: unknown[],
  profile: TournamentVivaProfileIdentity,
  options: {
    placeNumber?: number | null;
  } = {},
) {
  return exerciseBookings.find((item) => isTournamentVivaBookingOwnedByProfile(item, profile))
    ?? (
      options.placeNumber != null
        ? exerciseBookings.find((item) => (
            pickNumber(item, ["spot", "placeNumber", "position"]) === options.placeNumber
          ))
        : null
    )
    ?? null;
}
