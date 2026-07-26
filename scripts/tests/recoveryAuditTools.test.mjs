import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditReleaseArtifacts,
  parseSha256Inventory,
} from "../audit_release_artifacts.mjs";
import { auditNodeRedFlowDrift } from "../audit_nodered_flow_drift.mjs";

test("release audit reports exact matches, mismatches, and missing files", () => {
  const localDir = mkdtempSync(join(tmpdir(), "lk-release-audit-"));
  writeFileSync(join(localDir, "match.js"), "same");
  writeFileSync(join(localDir, "mismatch.js"), "local");

  const inventory = parseSha256Inventory(`
0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5  /remote/match.js
d9298a10d1b0735837dc4bd85dac641b0f66a479054812e449aa139cc1473c40  /remote/mismatch.js
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  /remote/missing.js
`);
  const results = auditReleaseArtifacts(inventory, localDir);

  assert.deepEqual(
    results.map(({ fileName, match, localSha }) => ({
      fileName,
      match,
      exists: Boolean(localSha),
    })),
    [
      { fileName: "match.js", match: true, exists: true },
      { fileName: "mismatch.js", match: false, exists: true },
      { fileName: "missing.js", match: false, exists: false },
    ],
  );
});

test("Node-RED audit reports ID and changed-field drift without function bodies", () => {
  const candidate = [
    { id: "same", type: "function", name: "Same", func: "return msg;" },
    { id: "changed", type: "function", name: "Changed", func: "return msg;" },
    { id: "removed", type: "debug", name: "Removed" },
  ];
  const live = [
    { id: "same", type: "function", name: "Same", func: "return msg;" },
    { id: "changed", type: "function", name: "Changed", func: "return [msg];" },
    { id: "added", type: "http in", name: "Added" },
  ];

  const result = auditNodeRedFlowDrift(candidate, live);

  assert.equal(result.candidateCount, 3);
  assert.equal(result.liveCount, 3);
  assert.deepEqual(result.added.map((node) => node.id), ["added"]);
  assert.deepEqual(result.removed.map((node) => node.id), ["removed"]);
  assert.deepEqual(result.changed, [
    {
      id: "changed",
      type: "function",
      name: "Changed",
      z: "",
      fields: ["func"],
    },
  ]);
  assert.equal(JSON.stringify(result).includes("return [msg]"), false);
});
