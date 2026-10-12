import test from "node:test";
import assert from "node:assert/strict";
import type { PadelGamePlayer } from "../../src/utils/apiClient.ts";
import { restorePartnerBookingBindings, projectPartnerVivaRoster } from "../../src/utils/partnerRosterProjection.ts";
import { reconcileRosterWithViva } from "../../src/components/games/rosterSyncReconcile.ts";

const partner = (member = "member-a", booking = "booking-a"): PadelGamePlayer => ({
  id: `partner:${member}`, membershipId: member, membershipGeneration: 1, vivaBookingId: booking,
  name: `Named ${member}`, phone: null, photo: null, rating: null, ratingNumeric: null, source: "PARTNER_API", status: "CONFIRMED",
});
const technical = (booking = "booking-a"): PadelGamePlayer => ({
  id: "technical-client", name: "Partner application", phone: null,
  vivaBookingId: booking, source: "ADMIN", status: "CONFIRMED",
});
const ordinary: PadelGamePlayer = { id: "ordinary", name: "Ordinary", phone: null, source: "ADMIN", status: "CONFIRMED" };
const payment = { playerId: "partner:member-a", membershipId: "member-a", bookingId: "booking-a", membershipGeneration: 1, status: "PAID", settlementSource: "EXTERNAL_PARTNER" };

test("one Partner booking projects one named participant and removes the stored technical duplicate", () => {
  const named = partner();
  const storedTechnical = technical();
  const result = reconcileRosterWithViva({
    sourceParticipants: [ordinary, named, storedTechnical],
    vivaParticipants: [{ ...ordinary, vivaBookingId: "ordinary-booking" }, technical()], leaveEvents: [],
  });
  assert.equal(result.canSync, true);
  assert.deepEqual(result.mergedCandidates.map((p) => p.id), ["ordinary", named.id]);
  assert.deepEqual(result.mergedCandidates[1], named);
  assert.equal(result.staleSourcePlayersRemoved, 1);
});

test("different booking under the same technical client remains a separate seat", () => {
  const result = projectPartnerVivaRoster([partner(), technical()], [technical(), technical("booking-other")]);
  assert.equal(result.removedTechnicalDuplicates, 0);
  assert.deepEqual(result.vivaParticipants.map((p) => p.id), ["partner:member-a", "technical-client"]);
});

test("two named members with separate bookings sharing a technical client remain two people", () => {
  const a = partner(); const b = partner("member-b", "booking-b");
  const result = reconcileRosterWithViva({ sourceParticipants: [a, b, technical()], vivaParticipants: [technical(), technical("booking-b")], leaveEvents: [] });
  assert.equal(result.canSync, true);
  assert.deepEqual(result.mergedCandidates.map((p) => p.id), [a.id, b.id]);
});

test("legacy member binding is restored from one matching server payment without copying money fields", () => {
  const named = { ...partner(), vivaBookingId: undefined };
  const restored = restorePartnerBookingBindings([named], [payment]);
  assert.deepEqual(restored, [partner()]);
  assert.equal("settlementSource" in restored[0], false);
  assert.equal("bookingId" in restored[0], false);
});

test("ambiguous, conflicting and foreign payment bindings disable automatic roster writes", () => {
  for (const payments of [
    [payment, payment],
    [{ ...payment, bookingId: "wrong-booking" }],
    [{ ...payment, membershipId: "foreign-member" }],
    [{ ...payment, playerId: "foreign-player" }],
    [{ ...payment, status: "LEFT" }],
  ]) {
    const named = { ...partner(), vivaBookingId: undefined };
    if (payments[0]?.bookingId === "wrong-booking") named.vivaBookingId = "booking-a";
    const source = restorePartnerBookingBindings([named], payments);
    assert.equal(projectPartnerVivaRoster(source, [technical()]).canSync, false);
  }
});

test("generation mismatch and multiple named owners of one booking fail closed", () => {
  const source = restorePartnerBookingBindings([{ ...partner(), membershipGeneration: 2 }], [payment]);
  assert.equal(projectPartnerVivaRoster(source, [technical()]).canSync, false);
  assert.equal(projectPartnerVivaRoster([partner(), partner("member-b")], [technical()]).canSync, false);
});

test("missing booking identity never suppresses a real Viva participant", () => {
  const result = projectPartnerVivaRoster([partner()], [{ ...technical(), vivaBookingId: undefined }]);
  assert.equal(result.removedTechnicalDuplicates, 0);
  assert.equal(result.canSync, false);
  assert.equal(result.sourceParticipants[0].id, "partner:member-a");
});

test("inactive or malformed Partner membership disables automatic reconciliation", () => {
  for (const named of [{ ...partner(), status: "PENDING" as const }, { ...partner(), id: "wrong-player" }]) {
    assert.equal(projectPartnerVivaRoster([named], [technical()]).canSync, false);
  }
});

test("ordinary games and mismatching stored booking IDs retain their roster", () => {
  const ordinaryResult = projectPartnerVivaRoster([ordinary], [ordinary]);
  assert.equal(ordinaryResult.canSync, true);
  assert.deepEqual(ordinaryResult.sourceParticipants, [ordinary]);
  const unrelated = technical("unrelated-booking");
  const result = projectPartnerVivaRoster([partner(), unrelated], [technical()]);
  assert.equal(result.removedTechnicalDuplicates, 0);
});

test("named member does not take the technical client identity or leave state", () => {
  const named = { ...partner(), phone: "named-phone", memberKey: "opaque-member", membershipGeneration: 1 };
  const result = reconcileRosterWithViva({ sourceParticipants: [named], vivaParticipants: [{ ...technical(), phone: "technical-phone" }], leaveEvents: [] });
  assert.deepEqual(result.mergedCandidates, [named]);
});


test("legacy technical row without booking identity is preserved by cached reconciliation", () => {
  const legacy = { ...technical(), vivaBookingId: undefined };
  const result = projectPartnerVivaRoster([partner(), legacy], [technical()]);
  assert.equal(result.removedTechnicalDuplicates, 0);
  assert.deepEqual(result.sourceParticipants, [partner(), legacy]);
});

test("duplicated provider booking IDs disable automatic reconciliation", () => {
  assert.equal(projectPartnerVivaRoster([partner()], [technical(), technical()]).canSync, false);
});
