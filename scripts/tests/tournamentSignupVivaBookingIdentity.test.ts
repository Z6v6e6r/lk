import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createAvailableTournamentVivaRegistrationState,
  isTournamentVivaBookingInactive,
  selectTournamentVivaBooking,
  selectTournamentVivaOwnBooking,
} from "../../src/utils/tournamentVivaBookingIdentity.ts";

const tournamentSignupApiSource = fs.readFileSync(
  "src/utils/tournamentSignupApi.ts",
  "utf8",
);

const profile = {
  id: "viewer-client-id",
  phone: "+7 900 000-00-01",
};

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-id",
    exerciseId: "exercise-id",
    client: {
      id: "another-client-id",
      phone: "+7 900 000-00-02",
    },
    spot: 4,
    ...overrides,
  };
}

test("does not treat the only exercise booking as the viewer booking", () => {
  const foreignBooking = booking();

  assert.equal(selectTournamentVivaBooking([foreignBooking], profile), null);
});

test("selects a booking with an exact viewer client id", () => {
  const ownBooking = booking({
    client: {
      id: profile.id,
      phone: "+7 900 000-00-02",
    },
  });

  assert.equal(selectTournamentVivaBooking([booking(), ownBooking], profile), ownBooking);
});

test("selects a booking with the normalized viewer phone", () => {
  const ownBooking = booking({
    client: {
      id: "another-client-id",
      phone: "8 (900) 000-00-01",
    },
  });

  assert.equal(selectTournamentVivaBooking([booking(), ownBooking], profile), ownBooking);
});

test("uses place fallback only when a cancellation flow supplies the place", () => {
  const placeBooking = booking({ spot: 7 });

  assert.equal(selectTournamentVivaBooking([placeBooking], profile), null);
  assert.equal(
    selectTournamentVivaBooking([placeBooking], profile, { placeNumber: 7 }),
    placeBooking,
  );
});

test("inactive Viva booking statuses do not block a new registration", () => {
  const inactiveStatuses = [
    "CANCELLED",
    "DECLINED",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
    "REJECTED",
    "VOID",
    "CLOSED",
    "ARCHIVED",
    "REMOVED",
  ];

  inactiveStatuses.forEach((status) => {
    const inactiveBooking = booking({ status });
    assert.equal(isTournamentVivaBookingInactive(inactiveBooking), true, status);
    assert.equal(
      selectTournamentVivaOwnBooking([inactiveBooking], "exercise-id"),
      null,
      status,
    );
  });
});

test("successful own-bookings lookup selects only an active matching exercise", () => {
  const otherExercise = booking({ exerciseId: "other-exercise" });
  const inactiveMatch = booking({ id: "inactive", status: "DECLINED" });
  const activeMatch = booking({ id: "active", status: "CONFIRMED" });

  assert.equal(
    selectTournamentVivaOwnBooking([otherExercise, inactiveMatch, activeMatch], "exercise-id"),
    activeMatch,
  );
  assert.equal(selectTournamentVivaOwnBooking([], "exercise-id"), null);
});

test("resolved empty Viva lookup explicitly keeps registration available", () => {
  assert.deepEqual(createAvailableTournamentVivaRegistrationState(), {
    status: "NONE",
    bookingId: null,
    placeNumber: null,
    waitlistNumber: null,
    canRegister: true,
    canCancel: false,
    message: null,
    paymentUrl: null,
    paymentExpiresAt: null,
  });
});

test("authenticated checkout falls back to public products with the verified profile", () => {
  const checkoutSource = tournamentSignupApiSource.match(
    /export async function apiFetchTournamentVivaCheckout[\s\S]*?\n}\n\nexport async function apiFetchTournamentVivaPublicCheckout/,
  )?.[0];

  assert.ok(checkoutSource, "authenticated checkout source must exist");
  assert.match(checkoutSource, /apiFetchTournamentVivaPublicCheckout\(exerciseId, options\)/);
  assert.match(checkoutSource, /profile: profileResult\.data/);
});
