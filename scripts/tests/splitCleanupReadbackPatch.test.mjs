import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { buildSplitCleanupReadbackCandidate } from "../patch_live_split_cleanup_readback.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sha256Json = (value) => sha256(Buffer.from(JSON.stringify(value), "utf8"));

function fixture({ brokenWire = false } = {}) {
  const flow = [
    {
      id: "route-1",
      type: "http in",
      z: "tab-1",
      name: "Route",
      method: "post",
      url: "/test",
      wires: [["fn-1"]],
    },
    {
      id: "fn-1",
      type: "function",
      z: "tab-1",
      name: "Query",
      func: "return 'old-query';",
      wires: [["fn-2"]],
    },
    {
      id: "fn-2",
      type: "function",
      z: "tab-1",
      name: "Prepare",
      func: "return 'old-prepare';",
      wires: [["fn-3"]],
    },
    {
      id: "fn-3",
      type: "function",
      z: "tab-1",
      name: "Router",
      func: "return 'old-router';",
      wires: brokenWire ? [["missing-node"]] : [[]],
    },
  ];
  const sourcesById = {
    "fn-1": "return 'new-query';",
    "fn-2": "return 'new-prepare';",
    "fn-3": "return 'new-router';",
  };
  const targets = flow.slice(1).map((node) => ({
    id: node.id,
    name: node.name,
    source: `${node.id}.js`,
    nodeSha256: sha256Json(node),
    funcSha256: sha256(node.func),
    postFuncSha256: sha256(sourcesById[node.id]),
  }));
  return {
    flow,
    sourcesById,
    contract: {
      wholeFlowSha256: "fixture-flow-sha",
      nodeCount: flow.length,
      httpRouteCount: 1,
      targets,
    },
  };
}

test("readback patch changes only guarded function bodies", () => {
  const value = fixture();
  const beforeRoute = structuredClone(value.flow[0]);
  const result = buildSplitCleanupReadbackCandidate(
    structuredClone(value.flow),
    "fixture-flow-sha",
    value.contract,
    value.sourcesById,
  );

  assert.deepEqual(result.candidate[0], beforeRoute);
  assert.deepEqual(
    result.candidate.slice(1).map((node) => node.func),
    Object.values(value.sourcesById),
  );
  assert.equal(result.report.httpRouteCount, 1);
  assert.equal(result.report.brokenWires, 0);
  assert.equal(result.report.brokenLinks, 0);
});

test("readback patch rejects a stale whole-flow preimage", () => {
  const value = fixture();
  assert.throws(() => buildSplitCleanupReadbackCandidate(
    structuredClone(value.flow),
    "stale-flow-sha",
    value.contract,
    value.sourcesById,
  ), /preimage SHA mismatch/);
});

test("readback patch rejects an unreviewed source postimage", () => {
  const value = fixture();
  assert.throws(() => buildSplitCleanupReadbackCandidate(
    structuredClone(value.flow),
    "fixture-flow-sha",
    value.contract,
    {
      ...value.sourcesById,
      "fn-2": "return 'unreviewed-change';",
    },
  ), /source postimage mismatch/);
});

test("readback patch rejects broken wire references", () => {
  const value = fixture({ brokenWire: true });
  assert.throws(() => buildSplitCleanupReadbackCandidate(
    structuredClone(value.flow),
    "fixture-flow-sha",
    value.contract,
    value.sourcesById,
  ), /broken references/);
});
