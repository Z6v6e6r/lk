import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildCandidate } from "../patch_live_split_lifecycle_v2_cutoff_hotfix.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const beforeQuery = "before query";
const afterQuery = "after query";
const beforePrepare = "before prepare";
const afterPrepare = "after prepare";

const contract = {
  flowSha256: "flow-preimage",
  nodeCount: 5,
  httpRouteCount: 1,
  schedulerId: "scheduler",
  targets: [
    { id: "query", name: "Query", beforeFuncSha256: sha256(beforeQuery), afterFuncSha256: sha256(afterQuery) },
    { id: "prepare", name: "Prepare", beforeFuncSha256: sha256(beforePrepare), afterFuncSha256: sha256(afterPrepare) },
  ],
};

const flow = () => [
  { id: "tab", type: "tab", wires: [] },
  { id: "http", type: "http in", z: "tab", method: "get", url: "/x", wires: [["query"]] },
  { id: "query", type: "function", name: "Query", z: "tab", func: beforeQuery, wires: [["prepare"]] },
  { id: "prepare", type: "function", name: "Prepare", z: "tab", func: beforePrepare, wires: [[]] },
  { id: "scheduler", type: "inject", z: "tab", wires: [["query"]] },
];
const options = { contract, sources: { query: afterQuery, prepare: afterPrepare } };

test("cutoff hotfix builder changes only the reviewed query and prepare functions", () => {
  const result = buildCandidate(flow(), "flow-preimage", options);
  assert.equal(result.candidate[2].func, afterQuery);
  assert.equal(result.candidate[3].func, afterPrepare);
  assert.deepEqual(result.report.changedNodes.map((item) => item.id), ["query", "prepare"]);
  assert.equal(result.report.brokenWires, 0);
  assert.equal(result.report.brokenLinks, 0);
});

test("cutoff hotfix builder rejects flow, function, source, topology and scheduler drift", () => {
  assert.throws(() => buildCandidate(flow(), "other-flow", options), /Whole-flow preimage/);
  const functionDrift = flow(); functionDrift[2].func = "drift";
  assert.throws(() => buildCandidate(functionDrift, "flow-preimage", options), /function preimage/);
  assert.throws(() => buildCandidate(flow(), "flow-preimage", {
    contract,
    sources: { query: "unreviewed", prepare: afterPrepare },
  }), /source postimage/);
  const noScheduler = flow().filter((node) => node.id !== "scheduler");
  assert.throws(() => buildCandidate(noScheduler, "flow-preimage", {
    contract: { ...contract, nodeCount: 4 },
    sources: options.sources,
  }), /scheduler contract/);
  const broken = flow(); broken[2].wires = [["missing"]];
  assert.throws(() => buildCandidate(broken, "flow-preimage", options), /broken references/);
});
