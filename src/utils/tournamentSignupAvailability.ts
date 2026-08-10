import type {
  TournamentRegistrationState,
  TournamentSignupStatus,
} from "./tournamentSignupApi";

const PHONE_LOOKUP_UNAVAILABLE_PATTERN = /(?:номер )?телефон|\bphone\b/i;

export function isTournamentRegistrationLookupUnavailable(
  registration: TournamentRegistrationState | null | undefined,
) {
  return Boolean(
    registration
    && registration.status === "NONE"
    && registration.canRegister === false
    && registration.canCancel === false
    && PHONE_LOOKUP_UNAVAILABLE_PATTERN.test(registration.message || ""),
  );
}

export function canOfferTournamentRegistration(
  tournamentStatus: TournamentSignupStatus | null | undefined,
  registration: TournamentRegistrationState | null | undefined,
) {
  const canCancel = Boolean(registration?.canCancel && registration.status !== "NONE");
  if (canCancel || tournamentStatus === "CANCELLED" || tournamentStatus === "CLOSED") {
    return false;
  }

  return registration?.canRegister !== false
    || isTournamentRegistrationLookupUnavailable(registration);
}
