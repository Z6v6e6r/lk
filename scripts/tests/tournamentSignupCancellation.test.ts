import assert from "node:assert/strict";
import test from "node:test";
import {
  isTournamentSignupCancelledStatusValue,
  isTournamentSignupPayloadCancelled,
} from "../../src/utils/tournamentSignupCancellation.ts";

test("reopened tournament stays visible when stale canceledAt markers remain in audit payload", () => {
  const payload = {
    id: "6a4956c5241cf92c08a2e099",
    status: "REGISTRATION",
    statusAudit: {
      canceledAt: "2026-07-04T19:01:28.406Z",
      lastChange: {
        at: "2026-07-04T19:01:57.025Z",
        fromStatus: "CANCELED",
        toStatus: "REGISTRATION",
      },
    },
    details: {
      statusAudit: {
        canceledAt: "2026-07-04T19:01:28.406Z",
      },
      sourceTournamentSnapshot: {
        id: "79e1a50f-84f3-4c1b-b3d3-b3e1fb8862a3",
        status: "REGISTRATION",
      },
    },
  };

  assert.equal(isTournamentSignupPayloadCancelled(payload), false);
});

test("cancelled custom tournament stays hidden even if nested Viva snapshot remains active", () => {
  const payload = {
    id: "custom-tournament",
    status: "CANCELED",
    details: {
      sourceTournamentSnapshot: {
        id: "viva-exercise",
        status: "REGISTRATION",
      },
    },
  };

  assert.equal(isTournamentSignupPayloadCancelled(payload), true);
});

test("timestamp-only cancellation still hides top-level tournament records without a current status", () => {
  const payload = {
    id: "legacy-cancelled-tournament",
    statusAudit: {
      canceledAt: "2026-07-04T18:54:17.619Z",
    },
  };

  assert.equal(isTournamentSignupPayloadCancelled(payload), true);
});

test("explicit reopened status wins over stale cancellation booleans", () => {
  const payload = {
    id: "reopened-tournament",
    status: "REGISTRATION",
    isCancelled: true,
  };

  assert.equal(isTournamentSignupPayloadCancelled(payload), false);
});

test("cancelled status helper matches Viva reopen/cancel status vocabulary", () => {
  assert.equal(isTournamentSignupCancelledStatusValue("CANCELED"), true);
  assert.equal(isTournamentSignupCancelledStatusValue("ОТМЕНЁН"), true);
  assert.equal(isTournamentSignupCancelledStatusValue("REGISTRATION"), false);
});
