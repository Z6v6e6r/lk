import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const patcher = "scripts/patch_live_community_media_responses.mjs";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const targets = [
  ["b274fa471d4654a3", "tab-communities", "Build community logo asset response", 4],
  ["9fa15a3c8d86528a", "tab-communities", "Build community logo thumb response", 4],
  ["75cd8607d472a975", "tab-communities", "Build legacy community logo response", 3],
  ["ea4db740fdcd920c", "tab-communities", "Build legacy community logo thumb response", 3],
  ["4573edfe3e109f3a", "tab-media", "Build community logo asset response", 4],
  ["87fc796ba5710287", "tab-media", "Build community logo thumb response", 4],
  ["335e7e97639670f2", "tab-media", "Build legacy community logo response", 3],
  ["4ec662e1ded03673", "tab-media", "Build legacy community logo thumb response", 3],
];

const makeFlow = () => {
  const nodes = [];
  for (const [id, tab, name, errorReturns] of targets) {
    const httpId = `${id}-http`;
    const debugId = `${id}-debug`;
    nodes.push(
      {
        id, type: "function", z: tab, name, outputs: 2,
        func: `${"return [null, errorMsg, errorMsg];\n".repeat(errorReturns)}return [msg, msg];`,
        wires: [[httpId], [debugId]],
      },
      { id: httpId, type: "http response", z: tab, wires: [] },
      { id: debugId, type: "debug", z: tab, wires: [] },
    );
  }
  nodes.push({ id: "route", type: "http in", z: "tab-media", url: "/lk/media/example", wires: [[]] });
  return nodes;
};

const run = (flow, expectedBody = null) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "community-media-response-patch-"));
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

test("live media patcher repairs both duplicate route sets without changing topology", (t) => {
  const runResult = run(makeFlow());
  t.after(() => fs.rmSync(runResult.tempDir, { recursive: true, force: true }));
  assert.equal(runResult.result.status, 0, runResult.result.stderr);
  assert.equal(fs.readFileSync(runResult.input, "utf8"), runResult.body);
  const candidate = JSON.parse(fs.readFileSync(runResult.output, "utf8"));
  const report = JSON.parse(fs.readFileSync(runResult.report, "utf8"));
  for (const [id] of targets) {
    const node = candidate.find((item) => item.id === id);
    assert.doesNotMatch(node.func, /return \[null, errorMsg, errorMsg\]/);
    assert.match(node.func, /return \[errorMsg, errorMsg\]/);
    assert.equal(node.outputs, 2);
  }
  assert.equal(report.invariants.changedNodeCount, 8);
  assert.equal(report.invariants.httpInputRoutesUnchanged, true);
  assert.equal(report.invariants.brokenWireCount, 0);
  assert.equal(fs.statSync(runResult.output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(runResult.report).mode & 0o777, 0o600);
});

test("live media patcher rejects whole-flow drift before writing artifacts", (t) => {
  const baseline = makeFlow();
  const baselineBody = `${JSON.stringify(baseline, null, 2)}\n`;
  const drifted = makeFlow();
  drifted.at(-1).url = "/drifted";
  const runResult = run(drifted, baselineBody);
  t.after(() => fs.rmSync(runResult.tempDir, { recursive: true, force: true }));
  assert.notEqual(runResult.result.status, 0);
  assert.match(runResult.result.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(runResult.output), false);
  assert.equal(fs.existsSync(runResult.report), false);
});

test("live media patcher rejects missing copies and unexpected wiring", (t) => {
  const missing = makeFlow().filter((node) => node.id !== "4ec662e1ded03673");
  const missingResult = run(missing);
  t.after(() => fs.rmSync(missingResult.tempDir, { recursive: true, force: true }));
  assert.notEqual(missingResult.result.status, 0);
  assert.match(missingResult.result.stderr, /Node identity mismatch/);
  assert.equal(fs.existsSync(missingResult.output), false);

  const wrongWiring = makeFlow();
  wrongWiring.find((node) => node.id === "b274fa471d4654a3").wires = [["b274fa471d4654a3-debug"], ["b274fa471d4654a3-http"]];
  const wiringResult = run(wrongWiring);
  t.after(() => fs.rmSync(wiringResult.tempDir, { recursive: true, force: true }));
  assert.notEqual(wiringResult.result.status, 0);
  assert.match(wiringResult.result.stderr, /wiring target mismatch/);
  assert.equal(fs.existsSync(wiringResult.output), false);
});
