import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  COLLECTION,
  NODE_IDS,
  ROUTES,
  TAB_ID,
  TAB_LABEL,
  buildReceiverCandidate,
} from "../patch_nodered_booked_operation_receiver_flow.mjs";

const patcher = "scripts/patch_nodered_booked_operation_receiver_flow.mjs";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const makeFlow = () => [
  { id: "tab-games", type: "tab", label: "LK Games", disabled: false },
  { id: "mongo-client", type: "mongodb4-client", name: "games" },
  {
    id: "daily-op-find",
    type: "mongodb4",
    z: "tab-games",
    name: "Find daily subscription operation",
    collection: COLLECTION,
    operation: "find",
    clientNode: "mongo-client",
    wires: [[]],
  },
  {
    id: "existing-route",
    type: "http in",
    z: "tab-games",
    name: "LK subscription booking",
    url: "/lk/subscription-bookings",
    method: "post",
    wires: [[]],
  },
  { id: "existing-response", type: "http response", z: "tab-games", name: "", wires: [] },
];

const run = (flow, expectedBody = null) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "booked-operation-receiver-"));
  const input = path.join(tempDir, "flow.json");
  const output = path.join(tempDir, "candidate.json");
  const report = path.join(tempDir, "report.json");
  const body = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(input, body);
  const result = spawnSync(process.execPath, [
    patcher,
    "--input", input,
    "--output", output,
    "--report", report,
    "--expected-flow-sha256", sha256(expectedBody ?? body),
  ], { encoding: "utf8" });
  return { tempDir, input, output, report, body, result };
};

test("adds one isolated booked-operation receiver tab without touching the preimage", (t) => {
  const runResult = run(makeFlow());
  t.after(() => fs.rmSync(runResult.tempDir, { recursive: true, force: true }));
  assert.equal(runResult.result.status, 0, runResult.result.stderr);
  assert.equal(fs.readFileSync(runResult.input, "utf8"), runResult.body);
  assert.equal(fs.statSync(runResult.output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runResult.report).mode & 0o777, 0o600);

  const candidate = JSON.parse(fs.readFileSync(runResult.output, "utf8"));
  const report = JSON.parse(fs.readFileSync(runResult.report, "utf8"));
  const source = makeFlow();
  assert.equal(report.ok, true);
  assert.equal(report.addedTabId, TAB_ID);
  assert.equal(report.addedTabLabel, TAB_LABEL);
  assert.equal(report.mode, "PENDING_ONLY_FAIL_CLOSED");
  assert.equal(report.providerCallsOnAdmission, 0);
  assert.equal(report.invariants.sourceNodeCount, source.length);
  assert.equal(report.invariants.brokenWireCount, 0);
  assert.equal(report.invariants.addedHttpInRouteCount, 2);
  assert.equal(report.invariants.addedProviderWriteNodeCount, 0);
  for (let index = 0; index < source.length; index += 1) {
    assert.deepEqual(candidate[index], source[index], `source node ${source[index].id} changed`);
  }
  const tab = candidate.find((node) => node.type === "tab" && node.label === TAB_LABEL);
  assert.ok(tab);
  assert.equal(tab.id, TAB_ID);
  const added = candidate.filter((node) => node.z === TAB_ID || node.id === TAB_ID);
  const routes = added.filter((node) => node.type === "http in");
  assert.deepEqual(
    routes.map((node) => `${node.method}:${node.url}`).sort(),
    ["get:/lk/integrations/v1/booked-operations/:operationId", "post:/lk/integrations/v1/booked-operation-admissions"].sort(),
  );
  const mongoNodes = added.filter((node) => node.type === "mongodb4");
  assert.equal(mongoNodes.length, 2);
  for (const node of mongoNodes) {
    assert.equal(node.collection, COLLECTION);
    assert.equal(node.clientNode, "mongo-client");
  }
  const verifyNodes = added.filter((node) => (
    node.id === NODE_IDS.admissionVerify || node.id === NODE_IDS.readVerify
  ));
  assert.equal(verifyNodes.length, 2);
  for (const node of verifyNodes) {
    assert.deepEqual(node.libs, [{ var: "nodeCrypto", module: "crypto" }]);
    assert.match(node.func, /functionExternalModules/i);
    assert.match(node.func, /BOOKED_OP_ADMISSION_PREFIX/);
  }
  assert.ok(report.runtimePrerequisites.some((entry) => /functionExternalModules/.test(entry)));
  assert.ok(
    report.runtimePrerequisites.some((entry) => /service-impersonation/.test(entry)),
    "handoff must record the missing LK2 execution contract",
  );
});

test("rejects a drifted preimage before writing any artifact", (t) => {
  const baseline = makeFlow();
  const baselineBody = `${JSON.stringify(baseline, null, 2)}\n`;
  const drifted = makeFlow();
  drifted[2].name = "drifted";
  const runResult = run(drifted, baselineBody);
  t.after(() => fs.rmSync(runResult.tempDir, { recursive: true, force: true }));
  assert.notEqual(runResult.result.status, 0);
  assert.match(runResult.result.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(runResult.output), false);
  assert.equal(fs.existsSync(runResult.report), false);
});

test("refuses an already installed receiver, an overlapping route and ambiguous storage", (t) => {
  const installed = run(makeFlow());
  t.after(() => fs.rmSync(installed.tempDir, { recursive: true, force: true }));
  assert.equal(installed.result.status, 0, installed.result.stderr);
  const candidate = JSON.parse(fs.readFileSync(installed.output, "utf8"));
  const rerun = run(candidate);
  t.after(() => fs.rmSync(rerun.tempDir, { recursive: true, force: true }));
  assert.notEqual(rerun.result.status, 0);
  assert.match(rerun.result.stderr, /already exists/);
  assert.equal(fs.existsSync(rerun.output), false);

  const overlapping = makeFlow();
  overlapping.push({
    id: "other-integration-route",
    type: "http in",
    z: "tab-games",
    url: ROUTES.readPrefix + "other",
    method: "get",
    wires: [[]],
  });
  const overlapRun = run(overlapping);
  t.after(() => fs.rmSync(overlapRun.tempDir, { recursive: true, force: true }));
  assert.notEqual(overlapRun.result.status, 0);
  assert.match(overlapRun.result.stderr, /overlaps existing/);
  assert.equal(fs.existsSync(overlapRun.output), false);

  const ambiguous = makeFlow();
  ambiguous.push(
    { id: "second-mongo-client", type: "mongodb4-client", name: "other" },
    {
      id: "second-daily-op-find",
      type: "mongodb4",
      z: "tab-games",
      collection: COLLECTION,
      operation: "find",
      clientNode: "second-mongo-client",
      wires: [[]],
    },
  );
  const ambiguousRun = run(ambiguous);
  t.after(() => fs.rmSync(ambiguousRun.tempDir, { recursive: true, force: true }));
  assert.notEqual(ambiguousRun.result.status, 0);
  assert.match(ambiguousRun.result.stderr, /ambiguous|Expected one Mongo client/);
});

test("composition is pure and reuses the existing collection client", () => {
  const source = makeFlow();
  const snapshot = structuredClone(source);
  const { candidate, report } = buildReceiverCandidate(source);
  assert.deepEqual(source, snapshot, "composition must not mutate the preimage");
  assert.equal(report.mongoClientNodeId, "mongo-client");
  assert.equal(report.collection, COLLECTION);
  assert.deepEqual(report.routes, [
    ROUTES.admission,
    `${ROUTES.readPrefix}:operationId`,
  ]);
  const ids = candidate.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  const known = new Set(ids);
  for (const node of candidate) {
    for (const row of node.wires || []) {
      for (const target of row) assert.ok(known.has(target), `dangling wire ${node.id}->${target}`);
    }
  }
  assert.equal(
    candidate.filter((node) => node.type === "http in" && node.url === ROUTES.admission).length,
    1,
  );
});
