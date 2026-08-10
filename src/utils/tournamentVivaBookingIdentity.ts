export type TournamentVivaProfileIdentity = {
  id: string | null | undefined;
  phone: string | null | undefined;
};

const INACTIVE_TOURNAMENT_VIVA_BOOKING_STATUS_MARKERS = [
  "CANCEL",
  "DECLIN",
  "FAIL",
  "ERROR",
  "EXPIRE",
  "REFUND",
  "REJECT",
  "VOID",
  "CLOSE",
  "ARCHIVE",
  "LEFT",
  "REMOV",
] as const;

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

export function isTournamentVivaBookingInactive(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.isCancelled === true || value.cancelled === true || value.canceled === true) return true;

  const status = String(pickString(value, ["status", "state"]) || "").trim().toUpperCase();
  return INACTIVE_TOURNAMENT_VIVA_BOOKING_STATUS_MARKERS.some((marker) => status.includes(marker));
}

export function isTournamentVivaBookingForExercise(value: unknown, exerciseId: string) {
  if (!isRecord(value)) return false;
  const exercise = isRecord(value.exercise) ? value.exercise : null;
  const nestedExerciseId = pickString(exercise, ["id", "exerciseId", "uuid"]);
  const directExerciseId = pickString(value, ["exerciseId", "vivaExerciseId"]);
  return [nestedExerciseId, directExerciseId].some((id) => id === exerciseId);
}

export function selectTournamentVivaOwnBooking(
  ownBookings: unknown[],
  exerciseId: string,
) {
  return ownBookings.find((item) => (
    isTournamentVivaBookingForExercise(item, exerciseId)
    && !isTournamentVivaBookingInactive(item)
  )) ?? null;
}

export function createAvailableTournamentVivaRegistrationState() {
  return {
    status: "NONE" as const,
    bookingId: null,
    placeNumber: null,
    waitlistNumber: null,
    canRegister: true,
    canCancel: false,
    message: null,
    paymentUrl: null,
    paymentExpiresAt: null,
  };
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
