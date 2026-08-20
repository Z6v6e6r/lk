#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildFunctionOnlyContract } from "./runtime_contract.mjs";

const values = new Map();
const allowedNodeIds = [];
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Invalid arguments");
  if (key === "--allow-node") allowedNodeIds.push(value);
  else if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
  else values.set(key, value);
}
const allowed = new Set(["--live", "--candidate", "--output", "--deployment-id"]);
if ([...values.keys()].some((key) => !allowed.has(key)) || [...allowed].some((key) => !values.has(key))) {
  throw new Error("Usage: --live <flow> --candidate <flow> --output <contract> --deployment-id <id> --allow-node <id> [...]");
}
if (!allowedNodeIds.length) throw new Error("At least one --allow-node is required");
const livePath = path.resolve(values.get("--live"));
const candidatePath = path.resolve(values.get("--candidate"));
const outputPath = path.resolve(values.get("--output"));
if (fs.existsSync(outputPath)) throw new Error("Refusing to overwrite contract output");
const contract = buildFunctionOnlyContract({
  liveBytes: fs.readFileSync(livePath),
  candidateBytes: fs.readFileSync(candidatePath),
  deploymentId: values.get("--deployment-id"),
  allowedNodeIds,
});
fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  deploymentId: contract.deploymentId,
  sourceSha256: contract.sourceSha256,
  candidateSha256: contract.candidateSha256,
  nodeCount: contract.nodeCount,
  httpInputCount: contract.httpInputCount,
  changedNodeCount: contract.allowedChanges.length,
})}\n`);
