import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeReferralAttribution,
  readReferralAttribution,
} from "../../src/utils/referralAttribution.ts";

test("reads a paired opaque referral token and visit id", () => {
  assert.deepEqual(
    readReferralAttribution("?ref=abcdefghijklmnopqrstuvwx&ref_visit=visit-12345678"),
    { referralToken: "abcdefghijklmnopqrstuvwx", referralVisitId: "visit-12345678" },
  );
});

test("fails attribution closed when either identifier is malformed or missing", () => {
  assert.equal(normalizeReferralAttribution("short", "visit-12345678"), null);
  assert.equal(normalizeReferralAttribution("abcdefghijklmnopqrstuvwx", "bad visit"), null);
  assert.equal(readReferralAttribution("?ref=abcdefghijklmnopqrstuvwx"), null);
});
