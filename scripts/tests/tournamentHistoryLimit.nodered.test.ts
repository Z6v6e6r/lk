import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const patcherPath = "scripts/patch_live_tournament_history_limit.mjs";
const targetPreimageSha256 =
  "c2fe2964effcf33bfc9e5a3d5a1e29066c758fbf28950f1a28000f2475022d96";
const targetCandidateSha256 =
  "4b13538168725e97f63415ffeb93b71b7c27e14c10dceffd12fdf5ac0be0113c";

const sha256 = (value: string) => (
  crypto.createHash("sha256").update(value, "utf8").digest("hex")
);

const makeFlow = () => ([
  {
    id: "ccd7d6b82f8b90c1",
    type: "http in",
    z: "f9575c8726e29196",
    name: "Americano history",
    url: "/lk/tournaments/americano/history",
    method: "get",
    upload: false,
    swaggerDoc: "",
    x: 210,
    y: 1560,
    wires: [["11b8491cc624fb42", "0299bf5612ade8d5"]],
  },
  {
    id: "11b8491cc624fb42",
    type: "change",
    z: "f9575c8726e29196",
    name: "History by tournamentId",
    rules: [{
      t: "set",
      p: "payload",
      pt: "msg",
      to: '{ "tournamentId": $$.req.query.tournamentId }',
      tot: "jsonata",
    }],
    x: 510,
    y: 1560,
    wires: [["ddc581fde0073e34"]],
  },
  {
    id: "ddc581fde0073e34",
    type: "mongodb4",
    z: "f9575c8726e29196",
    clientNode: "lk_tournament_history_mongo_20260719",
    mode: "collection",
    collection: "tournaments",
    operation: "find",
    output: "toArray",
    maxTimeMS: "5000",
    handleDocId: false,
    name: "Find tournament history",
    x: 790,
    y: 1560,
    wires: [["a57565a6ddbb532f"]],
  },
  {
    id: "a57565a6ddbb532f",
    type: "function",
    z: "f9575c8726e29196",
    name: "History response",
    func: "return msg;",
    wires: [],
  },
  {
    id: "0299bf5612ade8d5",
    type: "debug",
    z: "f9575c8726e29196",
    name: "Americano save payload",
    active: false,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: "true",
    targetType: "full",
    x: 250,
    y: 1500,
    wires: [],
  },
]);

type RunOptions = {
  expectedBody?: string;
  outputPath?: string;
  reportPath?: string;
};

const runPatcher = (
  inputPath: string,
  inputBody: string,
  options: RunOptions = {},
) => {
  const outputPath = options.outputPath
    || path.join(path.dirname(inputPath), "candidate.json");
  const reportPath = options.reportPath
    || path.join(path.dirname(inputPath), "report.json");
  const expectedBody = options.expectedBody ?? inputBody;
  const result = spawnSync(process.execPath, [
    patcherPath,
    "--input", inputPath,
    "--output", outputPath,
    "--report", reportPath,
    "--expected-flow-sha256", sha256(expectedBody),
  ], { encoding: "utf8" });
  return { result, outputPath, reportPath };
};

test("history limit candidate changes exactly one target field", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-limit-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const flow = makeFlow();
  const inputBody = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(inputPath, inputBody);

  const { result, outputPath, reportPath } = runPatcher(inputPath, inputBody);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(inputPath, "utf8"), inputBody);

  const candidate = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const target = candidate.find(
    (node: { id?: string }) => node.id === "ddc581fde0073e34",
  );
  assert.equal(target.limit, "1");
  assert.equal(report.beforeSha256, targetPreimageSha256);
  assert.equal(report.afterSha256, targetCandidateSha256);
  assert.equal(report.changedNodes, 1);
  assert.deepEqual(report.changedFields, ["limit"]);
  assert.equal(report.invariants.nodeIdsUnchanged, true);
  assert.equal(report.invariants.wiresUnchanged, true);
  assert.equal(report.invariants.httpRoutesUnchanged, true);
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
});

test("whole-flow SHA rejects adjacent-node drift", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-flow-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const baselineBody = JSON.stringify(makeFlow());
  const drifted = makeFlow();
  drifted[3].name = "Drifted response";
  const inputBody = JSON.stringify(drifted);
  fs.writeFileSync(inputPath, inputBody);

  const { result, outputPath, reportPath } = runPatcher(
    inputPath,
    inputBody,
    { expectedBody: baselineBody },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Flow preimage mismatch/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});

for (const [label, mutate, expectedError] of [
  [
    "target",
    (flow: ReturnType<typeof makeFlow>) => {
      flow[2].x = 791;
    },
    /Target node preimage mismatch/,
  ],
  [
    "max-time",
    (flow: ReturnType<typeof makeFlow>) => {
      flow[2].maxTimeMS = "0";
    },
    /Target node contract mismatch for maxTimeMS/,
  ],
  [
    "target-wires",
    (flow: ReturnType<typeof makeFlow>) => {
      flow[2].wires = [[]];
    },
    /Target node contract mismatch for wires/,
  ],
  [
    "route",
    (flow: ReturnType<typeof makeFlow>) => {
      flow[0].method = "post";
    },
    /History route contract mismatch/,
  ],
  [
    "query",
    (flow: ReturnType<typeof makeFlow>) => {
      flow[1].rules[0].to = '{ "tournamentId": "wrong" }';
    },
    /History query contract mismatch/,
  ],
  [
    "debug",
    (flow: ReturnType<typeof makeFlow>) => {
      flow[4].active = true;
    },
    /History debug contract mismatch/,
  ],
] as const) {
  test(`${label} contract drift fails closed`, (t) => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `lk-history-${label}-`),
    );
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const inputPath = path.join(tempDir, "preimage.json");
    const flow = makeFlow();
    mutate(flow);
    const inputBody = JSON.stringify(flow);
    fs.writeFileSync(inputPath, inputBody);

    const { result, outputPath, reportPath } = runPatcher(inputPath, inputBody);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.existsSync(reportPath), false);
  });
}

test("preexisting identical limit fails closed", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-limit-set-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const flow = makeFlow();
  Object.assign(flow[2], { limit: "1" });
  const inputBody = JSON.stringify(flow);
  fs.writeFileSync(inputPath, inputBody);

  const { result, outputPath, reportPath } = runPatcher(inputPath, inputBody);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Target limit must be absent/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});

test("preexisting output destination fails closed", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-output-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const inputBody = JSON.stringify(makeFlow());
  fs.writeFileSync(inputPath, inputBody);
  fs.writeFileSync(outputPath, "do not overwrite");

  const { result, reportPath } = runPatcher(
    inputPath,
    inputBody,
    { outputPath },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not already exist/);
  assert.equal(fs.readFileSync(outputPath, "utf8"), "do not overwrite");
  assert.equal(fs.existsSync(reportPath), false);
});

test("symlink alias cannot overwrite input", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-alias-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const inputBody = JSON.stringify(makeFlow());
  fs.writeFileSync(inputPath, inputBody);
  fs.symlinkSync(inputPath, outputPath);

  const { result } = runPatcher(
    inputPath,
    inputBody,
    { outputPath, reportPath },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same file or inode/);
  assert.equal(fs.readFileSync(inputPath, "utf8"), inputBody);
});

test("hardlink alias cannot overwrite input", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-hardlink-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, "report.json");
  const inputBody = JSON.stringify(makeFlow());
  fs.writeFileSync(inputPath, inputBody);
  fs.linkSync(inputPath, outputPath);

  const { result } = runPatcher(
    inputPath,
    inputBody,
    { outputPath, reportPath },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same file or inode/);
  assert.equal(fs.readFileSync(inputPath, "utf8"), inputBody);
  assert.equal(fs.existsSync(reportPath), false);
});

test("report write failure leaves no published candidate", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-history-atomic-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const inputPath = path.join(tempDir, "preimage.json");
  const outputPath = path.join(tempDir, "candidate.json");
  const reportPath = path.join(tempDir, `${"r".repeat(260)}.json`);
  const inputBody = JSON.stringify(makeFlow());
  fs.writeFileSync(inputPath, inputBody);

  const { result } = runPatcher(
    inputPath,
    inputBody,
    { outputPath, reportPath },
  );
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
});
