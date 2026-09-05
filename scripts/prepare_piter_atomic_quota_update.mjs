#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { verifyWorkspace, assertFlowArray } from "./verify_nodered_source_origin.mjs";
import { sha256, buildExactGraphContract, validateExactGraphContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { assertNoEnabledLegacyPiterSalesTab, assertPiterAtomicTopology } from "./lib/piterAtomicTopologyContract.mjs";
import { PITER_QUOTA_UPDATE } from "./lib/piterAtomicQuotaUpdateContract.mjs";

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "nodered_games_nodes");
const fail = (message) => { throw new Error(`Piter quota update blocked: ${message}`); };

// expected is injectable only in pure fixture tests. The CLI always uses the
// checked-in exact production tuple and accepts no hash/target overrides.
export function buildPiterQuotaUpdate({ liveBytes, sourceTexts, expected = PITER_QUOTA_UPDATE }) {
  if (sha256(liveBytes) !== expected.sourceSha256) fail("source digest drift; refresh and review");
  const live = JSON.parse(Buffer.from(liveBytes).toString("utf8"));
  assertFlowArray(live);
  if (live.length !== expected.sourceNodeCount
    || live.filter((node) => node.type === "http in").length !== expected.httpInputCount) fail("source counts drift");
  const candidate = structuredClone(live);
  const tab = candidate.find((node) => node.id === "f9575c8726e29196");
  if (tab?.type !== "tab" || tab.label !== "LK Tournaments" || tab.disabled !== false) fail("tournament tab identity drift");
  for (const target of expected.targets) {
    const node = candidate.find((item) => item.id === target.id);
    if (node?.type !== "function" || node.z !== tab.id || node.name !== target.name
      || node.outputs !== target.outputs || !Array.isArray(node.wires)
      || node.wires.length !== target.outputs) fail(`target identity drift: ${target.id}`);
    if (sha256(String(node.func || "")) !== target.sourceSha256) fail(`target preimage drift: ${target.id}`);
    const replacement = sourceTexts[target.file];
    if (typeof replacement !== "string" || sha256(replacement) !== target.candidateSha256) fail(`replacement digest drift: ${target.id}`);
    new vm.Script(`(function(msg,node,context,flow,global,env){\n${replacement}\n})`);
    node.func = replacement;
  }
  assertPiterAtomicTopology(candidate);
  assertNoEnabledLegacyPiterSalesTab(candidate);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  if (candidate.length !== expected.candidateNodeCount
    || sha256(candidateBytes) !== expected.candidateSha256) fail("candidate digest/count drift");
  const allowedChanges = expected.targets.map(({ id }) => ({ id, fields: ["func"] }));
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: expected.deploymentId, allowedChanges, allowedAdditionIds: [] });
  validateExactGraphContract({ liveBytes, candidateBytes, contract });
  // Structural recovery rehearsal only. The bytes to restore are this fresh
  // source, never the pre-install flow. This does not authorize a live rollback.
  const reverse = buildExactGraphContract({ liveBytes: candidateBytes, candidateBytes: liveBytes,
    deploymentId: expected.deploymentId, allowedChanges, allowedAdditionIds: [] });
  validateExactGraphContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });
  const report = {
    ok: true, deploymentId: expected.deploymentId, updateKind: expected.updateKind,
    launchQuotaSchemaVersion: 2, sourceSha256: contract.sourceSha256,
    candidateSha256: contract.candidateSha256, sourceNodeCount: contract.sourceNodeCount,
    candidateNodeCount: contract.candidateNodeCount, httpInputCount: contract.httpInputCount,
    changedNodeIds: expected.targets.map(({ id }) => id), addedNodeCount: 0, removedNodeCount: 0,
    contractSha256: sha256(`${JSON.stringify(contract, null, 2)}\n`),
    rollbackSourceSha256: expected.sourceSha256, structuralReverseCheckPassed: true,
    rollbackRequiresDataPrecheck: true, rollbackAuthorized: false,
    ledgerActivationRequired: true, deploymentPerformed: false, activationPerformed: false,
  };
  return { candidateBytes, contract, report };
}

export function preparePiterQuotaUpdate(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") fail("Usage: --workspace /absolute/fresh-private-workspace");
  const verified = verifyWorkspace(argv[1], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(liveBytes) !== verified.sourceSha256) fail("source changed after origin verification");
  const sourceTexts = Object.fromEntries(PITER_QUOTA_UPDATE.targets.map(({ file }) =>
    [file, fs.readFileSync(path.join(SOURCE_DIR, file), "utf8")]));
  const built = buildPiterQuotaUpdate({ liveBytes, sourceTexts });
  const output = path.join(verified.workspace, "build-piter-quota-update");
  // mkdir without recursive and wx writes reject existing directories/symlinks.
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, "candidate.flow.json"), built.candidateBytes, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(output, "reviewed-flow.contract.json"), `${JSON.stringify(built.contract, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(built.report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return built.report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(preparePiterQuotaUpdate(process.argv.slice(2)))}\n`); }
  catch { process.stderr.write("Piter quota update preparation failed; no deployment performed.\n"); process.exitCode = 1; }
}
