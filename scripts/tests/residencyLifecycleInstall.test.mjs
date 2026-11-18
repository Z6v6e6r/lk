import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareInstall } from "../prepare_lk_residency_lifecycle_install.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const importFile = path.join(repoRoot, "node-red/imports/lk_residency_lifecycle.import.json");

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "residency-install-"));
  return { dir, preimage: path.join(dir, "flows.json"), candidate: path.join(dir, "candidate.json"), report: path.join(dir, "report.json") };
}

function liveGraph(extra = []) {
  return [
    { id: "tab-existing", type: "tab", label: "Existing" },
    { id: "existing-http", type: "http in", method: "get", url: "/lk/games", name: "games" },
    { id: "existing-fn", type: "function", func: "return msg;" },
    ...extra,
  ];
}

test("an additive candidate adds the reviewed nodes without touching the live graph", () => {
  const ws = workspace();
  fs.writeFileSync(ws.preimage, JSON.stringify(liveGraph()));
  const before = fs.readFileSync(ws.preimage);
  const result = prepareInstall({ preimage: ws.preimage, importFile, candidate: ws.candidate, report: ws.report });
  assert.equal(result.added.httpIn, 15);
  assert.equal(result.untouched.existingNodes, 3);
  assert.equal(result.untouched.replacedNodes, 0);
  assert.deepEqual(fs.readFileSync(ws.preimage), before);
  const merged = JSON.parse(fs.readFileSync(ws.candidate, "utf8"));
  assert.equal(merged.length, 3 + result.import.nodes);
  assert.equal(merged.slice(0, 3).every((node, index) => node.id === liveGraph()[index].id), true);
  const report = JSON.parse(fs.readFileSync(ws.report, "utf8"));
  assert.equal(report.apply.startsWith("Not applied."), true);
  assert.equal(report.candidate.sha256.length, 64);
});

test("an existing node id or route refuses the candidate and writes nothing", () => {
  for (const collision of [
    { id: "lk_residency_lifecycle_in_create_20261118", type: "comment" },
    { id: "other", type: "http in", method: "POST", url: "/lk/residency/orders" },
  ]) {
    const ws = workspace();
    fs.writeFileSync(ws.preimage, JSON.stringify(liveGraph([collision])));
    assert.throws(() => prepareInstall({ preimage: ws.preimage, importFile, candidate: ws.candidate, report: ws.report }),
      /already exists|already contains/);
    assert.equal(fs.existsSync(ws.candidate), false);
    assert.equal(fs.existsSync(ws.report), false);
  }
});

test("a candidate is never overwritten", () => {
  const ws = workspace();
  fs.writeFileSync(ws.preimage, JSON.stringify(liveGraph()));
  fs.writeFileSync(ws.candidate, "existing");
  assert.throws(() => prepareInstall({ preimage: ws.preimage, importFile, candidate: ws.candidate, report: ws.report }),
    /never overwritten/);
  assert.equal(fs.readFileSync(ws.candidate, "utf8"), "existing");
});
