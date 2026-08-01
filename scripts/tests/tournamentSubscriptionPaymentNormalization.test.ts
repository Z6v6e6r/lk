import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function extractFunctionBody(marker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);
  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Cannot find body: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  assert.fail(`Cannot extract body: ${marker}`);
}

const normalizeConfirmResult = new Function(
  "isRecord",
  "pickString",
  "normalizeTournamentSubscriptionPlanTypeToken",
  "extractPaymentUrl",
  `return function(payload) ${extractFunctionBody("function normalizeTournamentSubscriptionConfirmResult")};`,
)(
  (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
  (value: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return null;
  },
  () => null,
  () => null,
) as (payload: Record<string, unknown>) => { paid: boolean; status: string | null };

test("subscription confirm recognizes only exact PAID status", () => {
  assert.equal(normalizeConfirmResult({ status: "PAID" }).paid, true);
  assert.equal(normalizeConfirmResult({ status: "UNPAID" }).paid, false);
  assert.equal(normalizeConfirmResult({ status: "NOT_PAID" }).paid, false);
  assert.equal(normalizeConfirmResult({ status: "PAYMENT_PENDING" }).paid, false);
  assert.equal(normalizeConfirmResult({ status: "UNPAID", paid: true }).paid, true);
});
