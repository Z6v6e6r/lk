import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");

test("daily limit booking loader merges active and history fail-closed", () => {
  const functionStart = source.indexOf("export async function apiFetchSubscriptionDailyLimitBookings");
  const functionEnd = source.indexOf("export async function apiVerifyBookingCancellation", functionStart);
  const functionSource = source.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0, "daily limit booking loader must exist");
  assert.ok(functionEnd > functionStart, "daily limit booking loader must have a bounded source block");
  assert.match(functionSource, /Promise\.all/);
  assert.match(functionSource, /apiFetchBookings\(false, options\)/);
  assert.match(functionSource, /apiFetchBookings\(true, options\)/);
  assert.match(functionSource, /activeResult\.error/);
  assert.match(functionSource, /historyResult\.error/);
  assert.match(functionSource, /mergedById/);
  assert.match(functionSource, /\.\.\.booking/);
});
