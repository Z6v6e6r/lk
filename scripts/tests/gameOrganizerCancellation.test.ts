import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { collectGameCancellationBookingIds, hasOtherActiveGameMembers } from "../../src/components/games/gameLeaveMembership.ts";

const organizer = { id: "organizer", phone: "70000000001" };
test("solo organizer can reach ordinary cancellation", () => {
  assert.equal(hasOtherActiveGameMembers({ participants: [organizer] }, organizer), false);
});
test("other active participant blocks cancellation", () => {
  assert.equal(hasOtherActiveGameMembers({ participants: [organizer, { id: "player" }] }, organizer), true);
});
test("inactive rows do not require organizer transfer", () => {
  for (const status of ["LEFT", "CANCELLED", "REFUNDED", "DECLINED"]) {
    assert.equal(hasOtherActiveGameMembers({ participants: [{ id: "player", status }] }, organizer), false);
  }
});
test("waitlist and payment membership block when roster is stale", () => {
  assert.equal(hasOtherActiveGameMembers({ waitlist: [{ id: "waiting" }] }, organizer), true);
  assert.equal(hasOtherActiveGameMembers({ metadata: { splitPayment: {
    payments: [{ clientId: "player", status: "PAYMENT_PENDING" }],
  } } }, organizer), true);
});
test("same phone with conflicting client ID is another player", () => {
  assert.equal(hasOtherActiveGameMembers({ participants: [{ id: "other", phone: organizer.phone }] }, organizer), true);
});
test("cancellation button belongs to details rather than the cabinet list", () => {
  const cabinet = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
  const details = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  assert.doesNotMatch(cabinet, /game-created-cancel-row|handleCancelGameBooking/);
  assert.match(details, /<GameBookingCancellation/);
});

test("booking aliases include per-player and legacy payment references", () => {
  assert.deepEqual([...collectGameCancellationBookingIds({ metadata: { splitPayment: {
    payments: [{ bookingId: "PAYMENT" }, { booking_ids: "legacy-a, legacy-b" }],
  } } })], ["payment", "legacy-a", "legacy-b"]);
});
test("unpaid cancellation also checks fresh membership", () => {
  const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const handler = source.slice(source.indexOf("const handleCancelUnpaidGame"), source.indexOf("const toggleDetailsCommunityUnpublishSelection"));
  assert.ok(handler.indexOf("hasOtherActiveGameMembers(fresh.data") < handler.indexOf("apiCleanupPadelGameByOrganizer(gameRecordId"));
  assert.match(handler, /await apiFetchPadelGameRecord\(gameRecordId\)/);
});
