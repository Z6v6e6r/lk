import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  canOfferTournamentRegistration,
  isTournamentRegistrationLookupUnavailable,
} from "../../src/utils/tournamentSignupAvailability.ts";
import type { TournamentRegistrationState } from "../../src/utils/tournamentSignupApi.ts";

const tournamentSignupPageSource = fs.readFileSync(
  "src/components/tournament-signup/TournamentSignupPage.tsx",
  "utf8",
);
const tournamentSignupApiSource = fs.readFileSync(
  "src/utils/tournamentSignupApi.ts",
  "utf8",
);

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

test("registration endpoint phone lookup wording also keeps signup available", () => {
  const unavailableLookup = registration({
    message: "Не удалось определить номер телефона для записи.",
  });

  assert.equal(isTournamentRegistrationLookupUnavailable(unavailableLookup), true);
  assert.equal(canOfferTournamentRegistration("AVAILABLE", unavailableLookup), true);
});

test("live phone lookup wording keeps signup available", () => {
  const liveWordings = [
    "Не удалось определить телефон для записи.",
    "Невозможно проверить номер телефона.",
    "Phone lookup is unavailable.",
  ];

  liveWordings.forEach((message) => {
    const unavailableLookup = registration({ message });
    assert.equal(isTournamentRegistrationLookupUnavailable(unavailableLookup), true);
    assert.equal(canOfferTournamentRegistration("AVAILABLE", unavailableLookup), true);
  });
});

test("personal registration lookup bypasses browser cache", () => {
  const lookupSource = tournamentSignupApiSource.match(
    /export async function apiFetchTournamentMyRegistration[\s\S]*?\n}/,
  )?.[0];

  assert.ok(lookupSource, "registration lookup source must exist");
  assert.match(lookupSource, /cache: "no-store"/);
});

test("phone lookup failure does not render a warning in tournament detail", () => {
  assert.doesNotMatch(
    tournamentSignupPageSource,
    /Не удалось проверить текущую запись по номеру телефона/,
  );
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
