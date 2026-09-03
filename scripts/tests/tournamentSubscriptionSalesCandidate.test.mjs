import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER = path.join(REPO_ROOT, "scripts/prepare_tournament_subscription_sales_candidate.mjs");
const RETIRED_ERROR = /Legacy tournament subscription sales builder is retired; use scripts\/prepare_piter_atomic_sales_candidate\.mjs\. No candidate was written\./;
const roots = [];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function createWorkspace({ sourceHost = "lk-primary-147" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "subscription-sales-candidate-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);

  const sourcePath = path.join(input, "source.flow.json");
  const metaPath = path.join(input, "source.flow.meta.json");
  const sourceText = "[]\n";
  fs.writeFileSync(sourcePath, sourceText, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: "live-147",
    sourceHost,
    sourceUser: "root",
    sourcePort: "22",
    remoteFlowPath: "/root/.node-red/flows.json",
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: sha256(sourceText),
    nodeCount: 0,
  }, null, 2)}\n`, { mode: 0o600 });
  return workspace;
}

function runBuilder(workspace) {
  return spawnSync(process.execPath, [BUILDER, "--workspace", workspace], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test("legacy sales builder refuses a valid live snapshot and points to the atomic builder", () => {
  const workspace = createWorkspace();
  const result = runBuilder(workspace);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, RETIRED_ERROR);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
  assert.equal(fs.existsSync(path.join(workspace, "build-piter-atomic")), false);
});

test("legacy sales builder still rejects invalid source provenance before its retirement guard", () => {
  const workspace = createWorkspace({ sourceHost: "untrusted-host" });
  const result = runBuilder(workspace);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node-RED source metadata mismatch for sourceHost/);
  assert.doesNotMatch(result.stderr, RETIRED_ERROR);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
  assert.equal(fs.existsSync(path.join(workspace, "build-piter-atomic")), false);
});
