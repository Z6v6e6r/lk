import assert from "node:assert/strict";
import test from "node:test";
import {
  canOfferTournamentRegistration,
  isTournamentRegistrationLookupUnavailable,
} from "../../src/utils/tournamentSignupAvailability.ts";
import type { TournamentRegistrationState } from "../../src/utils/tournamentSignupApi.ts";

function registration(
  overrides: Partial<TournamentRegistrationState> = {},
): TournamentRegistrationState {
  return {
    status: "NONE",
    bookingId: null,
    placeNumber: null,
    waitlistNumber: null,
    canRegister: false,
    canCancel: false,
    message: null,
    ...overrides,
  };
}

test("phone lookup failure does not silently hide tournament signup", () => {
  const unavailableLookup = registration({
    message: "Не удалось определить номер телефона для проверки записи.",
  });

  assert.equal(isTournamentRegistrationLookupUnavailable(unavailableLookup), true);
  assert.equal(canOfferTournamentRegistration("AVAILABLE", unavailableLookup), true);
});

test("other explicit registration denials remain fail closed", () => {
  const denied = registration({ message: "Регистрация для этого профиля недоступна." });

  assert.equal(isTournamentRegistrationLookupUnavailable(denied), false);
  assert.equal(canOfferTournamentRegistration("AVAILABLE", denied), false);
});

test("existing registration and closed tournament still hide signup", () => {
  const registered = registration({
    status: "REGISTERED",
    canRegister: false,
    canCancel: true,
  });
  const unavailableLookup = registration({
    message: "Не удалось определить номер телефона для проверки записи.",
  });

  assert.equal(canOfferTournamentRegistration("AVAILABLE", registered), false);
  assert.equal(canOfferTournamentRegistration("CLOSED", unavailableLookup), false);
  assert.equal(canOfferTournamentRegistration("CANCELLED", unavailableLookup), false);
});

test("missing registration state keeps public signup available", () => {
  assert.equal(canOfferTournamentRegistration("AVAILABLE", null), true);
});
