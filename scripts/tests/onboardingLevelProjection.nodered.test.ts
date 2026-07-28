import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("Viva projection writes only the supported numeric rating field", () => {
  const out = runNodeRedFunction("scripts/nodered_onboarding_nodes/fn_onboarding_level_build_updates.js", {
    levelLetter: "C+",
    levelNumeric: "3.50000",
  }) as any;

  assert.deepEqual(out.payload, [{
    fieldId: "eabfe27b-3f72-4496-9185-1a2ec6e6465e",
    value: ["3.50000"],
  }]);
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

test("onboarding rating patch inserts capture between Viva PUT and join", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-rating-flow-"));
  const tempSource = path.join(tempDir, "source.flow.json");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(tempSource, `${JSON.stringify([
    { id: "onboarding-tab", type: "tab", label: "LK Onboarding" },
    {
      id: "validate",
      type: "function",
      z: "onboarding-tab",
      name: "Validate + normalize",
      func: "return msg;",
      wires: [["updates"]],
    },
    {
      id: "updates",
      type: "function",
      z: "onboarding-tab",
      name: "Build updates array",
      func: "return msg;",
      wires: [["build-put"]],
    },
    {
      id: "build-put",
      type: "function",
      z: "onboarding-tab",
      name: "Build PUT custom field",
      func: "return msg;",
      wires: [["put"]],
    },
    {
      id: "put",
      type: "http request",
      z: "onboarding-tab",
      name: "PUT custom field",
      x: 1690,
      y: 160,
      wires: [["join"]],
    },
    {
      id: "join",
      type: "join",
      z: "onboarding-tab",
      name: "Join results",
      wires: [["response"]],
    },
    {
      id: "response",
      type: "function",
      z: "onboarding-tab",
      name: "Build response + log",
      func: "return msg;",
      wires: [],
    },
  ], null, 2)}\n`, "utf8");

  execFileSync(process.execPath, ["scripts/patch_nodered_onboarding_rating_flow.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, NODERED_SOURCE_PATH: tempSource },
    stdio: "pipe",
  });

  const flow = JSON.parse(fs.readFileSync(tempSource, "utf8"));
  const put = flow.find((node: any) => node.name === "PUT custom field");
  const updates = flow.find((node: any) => node.name === "Build updates array");
  const capture = flow.find((node: any) => node.name === "Capture Viva level PUT result");
  const join = flow.find((node: any) => node.name === "Join results");
  const response = flow.find((node: any) => node.name === "Build response + log");

  assert.deepEqual(put.wires[0], [capture.id]);
  assert.deepEqual(capture.wires[0], [join.id]);
  assert.match(updates.func, /NUM_FIELD_ID/);
  assert.doesNotMatch(updates.func, /f9790818/);
  assert.match(response.func, /projectionStatus/);
  assert.match(response.func, /statusCode: ok \? 200 : 502/);
});
