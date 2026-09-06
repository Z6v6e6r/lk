#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildExactGraphContract } from "./runtime_contract.mjs";

const values = new Map();
const allowedChanges = [];
const allowedAdditionIds = [];
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Invalid arguments");
  if (key === "--allow-change") {
    const separator = value.indexOf(":");
    const id = separator >= 0 ? value.slice(0, separator) : "";
    const fields = separator >= 0 ? value.slice(separator + 1).split(",") : [];
    allowedChanges.push({ id, fields });
  } else if (key === "--allow-add") {
    allowedAdditionIds.push(value);
  } else if (values.has(key)) {
    throw new Error(`Duplicate argument: ${key}`);
  } else {
    values.set(key, value);
  }
}

const allowed = new Set([
  "--live",
  "--candidate",
  "--output",
  "--deployment-id",
  "--activation-node",
  "--activation-not-before",
]);
const required = ["--live", "--candidate", "--output", "--deployment-id"];
const hasActivationNode = values.has("--activation-node");
const hasActivationTime = values.has("--activation-not-before");
if (
  [...values.keys()].some((key) => !allowed.has(key))
  || required.some((key) => !values.has(key))
  || hasActivationNode !== hasActivationTime
) {
  throw new Error(
    "Usage: --live <flow> --candidate <flow> --output <contract> --deployment-id <id> "
      + "--allow-change <id:field,field> [...] --allow-add <id> [...] "
      + "[--activation-node <id> --activation-not-before <canonical UTC>]",
  );
}
if (!allowedChanges.length && !allowedAdditionIds.length) {
  throw new Error("At least one exact changed or added node is required");
}

const livePath = path.resolve(values.get("--live"));
const candidatePath = path.resolve(values.get("--candidate"));
const outputPath = path.resolve(values.get("--output"));
if (fs.existsSync(outputPath)) throw new Error("Refusing to overwrite contract output");
const contract = buildExactGraphContract({
  liveBytes: fs.readFileSync(livePath),
  candidateBytes: fs.readFileSync(candidatePath),
  deploymentId: values.get("--deployment-id"),
  allowedChanges,
  allowedAdditionIds,
  activationBoundary: hasActivationNode ? {
    nodeId: values.get("--activation-node"),
    notBefore: values.get("--activation-not-before"),
  } : null,
});
fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  deploymentId: contract.deploymentId,
  sourceSha256: contract.sourceSha256,
  candidateSha256: contract.candidateSha256,
  sourceNodeCount: contract.sourceNodeCount,
  candidateNodeCount: contract.candidateNodeCount,
  httpInputCount: contract.httpInputCount,
  changedNodeCount: contract.allowedChanges.length,
  addedNodeCount: contract.allowedAdditions.length,
  activationBoundary: contract.activationBoundary ?? null,
})}\n`);
