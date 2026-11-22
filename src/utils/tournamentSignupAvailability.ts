import type {
  TournamentRegistrationState,
  TournamentSignupStatus,
} from "./tournamentSignupApi";
import type { ApiError } from "./apiClient";

const PHONE_LOOKUP_UNAVAILABLE_PATTERN = /(?:номер )?телефон|\bphone\b/i;

export function getTournamentBookingLevelDenial(
  error: ApiError | null | undefined,
): TournamentRegistrationState | null {
  if (error?.status !== 403 || !error.raw || typeof error.raw !== "object") return null;
  const { details } = error.raw as { details?: { code?: unknown } };
  const code = details?.code;
  if (code !== "LEVEL_NOT_ALLOWED" && code !== "PLAYER_LEVEL_REQUIRED"
    && code !== "PLAYER_LEVEL_UNKNOWN" && code !== "ACTIVITY_LEVEL_INVALID") return null;
  const message = error.message || "Не удалось подтвердить допуск по игровому уровню.";
  return {
    status: "NONE",
    placeNumber: null,
    waitlistNumber: null,
    canRegister: false,
    canCancel: false,
    levelDenialReason: message,
    message,
  };
}

export function preserveTournamentLevelDenial(
  ownerRegistration: TournamentRegistrationState | null | undefined,
  registration: TournamentRegistrationState | null,
): TournamentRegistrationState | null {
  if (ownerRegistration?.levelDenialReason && (!registration || registration.status === "NONE")) {
    return ownerRegistration;
  }
  return registration;
}

export function isTournamentRegistrationLookupUnavailable(
  registration: TournamentRegistrationState | null | undefined,
) {
  const message = registration?.message?.trim() || "";
  return Boolean(
    registration
    && registration.status === "NONE"
    && registration.canRegister === false
    && registration.canCancel === false
    && (!message || PHONE_LOOKUP_UNAVAILABLE_PATTERN.test(message)),
  );
}

export function canOfferTournamentRegistration(
  tournamentStatus: TournamentSignupStatus | null | undefined,
  registration: TournamentRegistrationState | null | undefined,
) {
  const canCancel = Boolean(registration?.canCancel && registration.status !== "NONE");
  if (registration?.levelDenialReason || canCancel || tournamentStatus === "CANCELLED" || tournamentStatus === "CLOSED") {
    return false;
  }

  return registration?.canRegister !== false
    || isTournamentRegistrationLookupUnavailable(registration);
}
