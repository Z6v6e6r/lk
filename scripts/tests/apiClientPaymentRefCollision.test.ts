import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("payment lookup envelopes preserve every distinct game for collision detection", () => {
  const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const start = source.indexOf("export async function apiFetchPadelGameByPaymentRef");
  const end = source.indexOf("export async function", start + 20);
  const lookup = source.slice(start, end);
  const extract = lookup.indexOf("const records = extractPadelGameRecordList(response.data)");
  const collision = lookup.indexOf("if (records.length > 1)");
  const singleFallback = lookup.indexOf("normalizePadelGameRecord(response.data)");
  assert.ok(extract >= 0);
  assert.ok(collision > extract);
  assert.ok(singleFallback > collision);
  assert.doesNotMatch(lookup, /const records = single \? \[single\]/);
});
