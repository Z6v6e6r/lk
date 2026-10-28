#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { buildFprNodeFunction, FPR_PREFIX_END } from "./nodered_fpr6x25.mjs";

export const fprSha256 = value => crypto.createHash("sha256").update(value).digest("hex");
export function patchFprFlow(inputBytes, contract) {
  if (fprSha256(inputBytes) !== contract.flowSha256) throw new Error("Flow preimage mismatch");
  if (!Array.isArray(contract.nodes) || contract.nodes.length !== 3
    || new Set(contract.nodes.map(n => n.kind)).size !== 3) throw new Error("Exactly prepare/recalculate/history_guard nodes required");
  const flow = JSON.parse(inputBytes.toString("utf8")), before = structuredClone(flow);
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error("Invalid flow IDs");
  const changes = [];
  for (const expected of contract.nodes) {
    const matches = flow.filter(n => n.id === expected.id);
    if (matches.length !== 1 || matches[0].type !== "function" || matches[0].name !== expected.name
      || fprSha256(matches[0].func) !== expected.sha256) throw new Error("Node preimage mismatch: " + expected.id);
    const node = matches[0], legacy = node.func;
    node.func = buildFprNodeFunction(legacy, expected.kind);
    new Function("msg", node.func);
    if (node.func.slice(node.func.indexOf(FPR_PREFIX_END) + FPR_PREFIX_END.length) !== legacy) throw new Error("Legacy suffix changed");
    changes.push({ id: node.id, name: node.name, kind: expected.kind, beforeSha256: expected.sha256, afterSha256: fprSha256(node.func) });
  }
  const changed = flow.filter((node, i) => !isDeepStrictEqual(node, before[i]));
  if (changed.length !== 3 || changed.some(node => {
    const original = before.find(n => n.id === node.id);
    return !isDeepStrictEqual({ ...node, func: original.func }, original);
  })) throw new Error("Unexpected flow/wiring/endpoint change");
  const output = JSON.stringify(flow, null, 2) + "\n";
  return { output, report: { ok: true, beforeFlowSha256: contract.flowSha256, afterFlowSha256: fprSha256(output), changes,
    nodeIdsUnchanged: true, wiresUnchanged: true, routesUnchanged: true, legacySuffixesUnchanged: true } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, contractPath, output, reportPath] = process.argv.slice(2);
  if (!input || !contractPath || !output || !reportPath) throw new Error("Usage: node scripts/patch_live_fpr6x25.mjs input.json contract.json output.json report.json");
  if (new Set([input, contractPath, output, reportPath]).size !== 4 || fs.existsSync(output) || fs.existsSync(reportPath)) throw new Error("Use distinct new output/report paths");
  const result = patchFprFlow(fs.readFileSync(input), JSON.parse(fs.readFileSync(contractPath, "utf8")));
  fs.writeFileSync(output, result.output, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(reportPath, JSON.stringify(result.report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result.report));
}
