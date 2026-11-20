import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

test("onboarding level validation rejects empty and invalid values", () => {
  const empty = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_validate.js", {
    payload: { clientId: "client-1" },
  }) as any[];
  const invalid = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_validate.js", {
    payload: { clientId: "client-1", levelNumeric: "not-a-number" },
  }) as any[];

  assert.equal(empty[0], null);
  assert.equal(empty[1].statusCode, 400);
  assert.equal(empty[1].payload.code, "LEVEL_VALUE_REQUIRED");
  assert.equal(invalid[1].payload.code, "LEVEL_NUMERIC_INVALID");
});

test("retired Viva level writer cannot emit provider updates", () => {
  const out = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_build_updates.js", { levelNumeric: "3.50000" });
  assert.equal(out, null);
});

test("Viva PUT capture keeps an explicit result for every requested field", () => {
  const success = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_capture_viva_result.js", {
    statusCode: 204,
    payload: null,
    _vivaFieldUpdate: { fieldId: "numeric-field", requestedValue: ["3.50000"] },
  }) as any;
  const failure = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_capture_viva_result.js", {
    statusCode: 500,
    payload: { error: "upstream failed" },
    _vivaFieldUpdate: { fieldId: "letter-field", requestedValue: ["C+"] },
  }) as any;

  assert.equal(success.payload.ok, true);
  assert.equal(success.payload.fieldId, "numeric-field");
  assert.equal(failure.payload.ok, false);
  assert.equal(failure.payload.httpStatus, 500);
});

test("onboarding level response is 502 when either Viva field update fails", () => {
  const out = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_build_response.js", {
    clientId: "client-1",
    levelLetter: "C+",
    levelNumeric: "3.50000",
    ratingAudit: { eventId: "rating-event-1", source: "cup_manual" },
    payload: [
      { fieldId: "letter-field", ok: true, httpStatus: 204 },
      { fieldId: "numeric-field", ok: false, httpStatus: 500, error: "upstream failed" },
    ],
  }) as any[];

  assert.equal(out[2].statusCode, 502);
  assert.equal(out[2].payload.ok, false);
  assert.equal(out[2].payload.projectionStatus, "FAILED");
  assert.deepEqual(out[2].payload.updatedFields, ["letter-field"]);
  assert.equal(out[2].payload.failures[0].fieldId, "numeric-field");
  assert.equal(out[0].payload.projectionStatus, "FAILED");
});

test("old Viva projection builder refuses regeneration", () => {
  assert.throws(() => execFileSync(process.execPath, ["scripts/patch_nodered_onboarding_rating_flow.mjs"], { stdio: "pipe" }), /Viva level.*retired/);
});
