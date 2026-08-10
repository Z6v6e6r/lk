import assert from "node:assert/strict";
import test from "node:test";
import { selectTournamentVivaBooking } from "../../src/utils/tournamentVivaBookingIdentity.ts";

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
