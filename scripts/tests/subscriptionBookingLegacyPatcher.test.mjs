import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const historicalRouters = [
  ["07bb2e4b4c7a6a0f5720a782a92811e40df14dc7", "d9d6d1f17c12f38b567cf226468caa6780ed3d6e707f55f4af26c066be86b1a4", 3],
  ["c8430b23538340fbdc7d85ce7a37b98855787ed6", "5f380562e98dd2f94a0197c498c94df12eb1797be0c3345bb21d8e4f051de7c9", 5],
];

for (const [commit, expectedHash, outputs] of historicalRouters) {
  test(`patcher rejects deprecated router ${expectedHash.slice(0, 12)} without outputs`, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lk1-legacy-patcher-"));
    try {
      const func = execFileSync("git", ["show", `${commit}:scripts/nodered_games_nodes/fn_split_router.js`], { encoding: "utf8" });
      assert.equal(sha256(func), expectedHash);
      const wires = [["http"], ["success"], ["failure"]];
      if (outputs === 5) wires.push(["managed"], ["canonical"]);
      const flow = [
        { id: "tab", type: "tab", label: "LK Games", disabled: false },
        { id: "8f7bd5b482fe9763", type: "function", z: "tab", name: "Route Viva split payment", outputs, func, wires },
        ...wires.flat().map((id) => ({ id, type: "function", z: "tab", name: `Sink ${id}`, func: "return null;", outputs: 0, wires: [] })),
        { id: "mongo", type: "mongodb4", z: "tab", collection: "lk_games", clientNode: "mongo-client", wires: [] },
        { id: "mongo-client", type: "mongodb4-client", uri: "mongodb://127.0.0.1:1/never_used" },
      ];
      const source = path.join(workspace, "source.flow.json");
      const candidate = path.join(workspace, "candidate.json");
      const importFile = path.join(workspace, "import.json");
      const readyFile = `${candidate}.ready.json`;
      const sourceText = JSON.stringify(flow);
      fs.writeFileSync(source, sourceText, { mode: 0o600 });
      fs.writeFileSync(path.join(workspace, "source.flow.meta.json"), JSON.stringify({
        sourceKind: "live-147", sourceHost: "lk-primary-147", sourceUser: "root", sourcePort: 22,
        remoteFlowPath: "/root/.node-red/flows.json", pulledAt: new Date().toISOString(), sourceSha256: sha256(sourceText),
      }), { mode: 0o600 });
      fs.writeFileSync(candidate, "stale candidate", { mode: 0o600 });
      fs.writeFileSync(importFile, "stale import", { mode: 0o600 });
      fs.writeFileSync(readyFile, "stale readiness", { mode: 0o600 });
      const result = spawnSync(process.execPath,
        ["scripts/patch_nodered_subscription_booking_flow.mjs", source, candidate, importFile],
        { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /deprecated|Pre-PRECREATE|hardened router/i);
      assert.equal(fs.existsSync(candidate), false);
      assert.equal(fs.existsSync(importFile), false);
      assert.equal(fs.existsSync(readyFile), false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}
