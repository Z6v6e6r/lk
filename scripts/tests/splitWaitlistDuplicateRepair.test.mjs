import test from "node:test";
import assert from "node:assert/strict";
import { buildSplitWaitlistDuplicateRepair } from "../repair_split_waitlist_duplicates.mjs";

test("repair removes only waitlist rows already confirmed in split roster", () => {
  const game = {
    id: "pay_test", status: "PAID", archived: false, booking: { date: "2026-08-12" }, settings: { payMode: "split" },
    participants: [{ id: "p-1", phone: "79990000001" }, { id: "p-2", phone: null }],
    waitlist: [{ id: "p-1", phone: null }, { id: "p-2", phone: "79990000002" }, { id: "p-3", phone: "79990000003" }],
    metadata: { splitPayment: { enabled: true, payments: [{ clientId: "p-1", status: "WAITLIST" }] }, waitlistPhones: ["79990000001"] },
  };
  const repair = buildSplitWaitlistDuplicateRepair(game, "2026-08-11T10:00:00.000Z");
  assert.equal(repair.removedWaitlistRows, 2);
  assert.deepEqual(repair.update.$set.waitlist.map((item) => item.id), ["p-3"]);
  assert.deepEqual(repair.update.$set.metadata.splitPayment, game.metadata.splitPayment);
  assert.deepEqual(repair.update.$set.waitlistPhones, ["79990000003"]);
});

test("repair ignores cancelled, past-scope-agnostic, and non-split records", () => {
  assert.equal(buildSplitWaitlistDuplicateRepair({ id: "x", status: "CANCELLED", settings: { payMode: "split" } }, "2026-08-11T10:00:00.000Z"), null);
  assert.equal(buildSplitWaitlistDuplicateRepair({ id: "x", status: "PAID", settings: { payMode: "self" } }, "2026-08-11T10:00:00.000Z"), null);
});
