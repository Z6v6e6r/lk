import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildCandidate } from "../patch_live_split_lifecycle_v2_followup.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const beforePrepare = "before prepare";
const afterPrepare = "after prepare";
const beforeRouter = "before router";
const afterRouter = "after router";

const contract = {
  flowSha256: "flow-preimage",
  nodeCount: 5,
  httpRouteCount: 1,
  schedulerId: "scheduler",
  targets: [
    { id: "prepare", name: "Prepare", beforeFuncSha256: sha256(beforePrepare), afterFuncSha256: sha256(afterPrepare) },
    { id: "router", name: "Router", beforeFuncSha256: sha256(beforeRouter), afterFuncSha256: sha256(afterRouter) },
  ],
};

const flow = () => [
  { id: "tab", type: "tab", wires: [] },
  { id: "http", type: "http in", z: "tab", method: "get", url: "/x", wires: [["prepare"]] },
  { id: "prepare", type: "function", name: "Prepare", z: "tab", func: beforePrepare, wires: [["router"]] },
  { id: "router", type: "function", name: "Router", z: "tab", func: beforeRouter, wires: [[]] },
  { id: "scheduler", type: "inject", z: "tab", wires: [["prepare"]] },
];
const options = { contract, sources: { prepare: afterPrepare, router: afterRouter } };

test("follow-up builder changes only the two reviewed function bodies", () => {
  const result = buildCandidate(flow(), "flow-preimage", options);
  assert.equal(result.candidate[2].func, afterPrepare);
  assert.equal(result.candidate[3].func, afterRouter);
  assert.deepEqual(result.report.changedNodes.map((item) => item.id), ["prepare", "router"]);
  assert.equal(result.report.brokenWires, 0);
});

test("follow-up builder rejects flow, function, source and scheduler drift", () => {
  assert.throws(() => buildCandidate(flow(), "other-flow", options), /Whole-flow preimage/);
  const functionDrift = flow(); functionDrift[2].func = "drift";
  assert.throws(() => buildCandidate(functionDrift, "flow-preimage", options), /function preimage/);
  assert.throws(() => buildCandidate(flow(), "flow-preimage", {
    contract,
    sources: { prepare: "unreviewed", router: afterRouter },
  }), /source postimage/);
  const noScheduler = flow().filter((node) => node.id !== "scheduler");
  assert.throws(() => buildCandidate(noScheduler, "flow-preimage", {
    contract: { ...contract, nodeCount: 4 },
    sources: options.sources,
  }), /scheduler contract/);
});
