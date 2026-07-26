#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const functionPath = path.join(
  rootDir,
  "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
);
const expectedCandidateSha256 =
  "b46468ecffddd481bd4eed456c665b51226e156be34df93a4fa6a01a2747ddc6";

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const inputPath = getArg("--input");
const outputPath = getArg("--output");
const reportPath = getArg("--report");
const expectedNodeId = getArg("--expected-node-id");
const expectedNodeType = getArg("--expected-node-type");
const expectedNodeName = getArg("--expected-node-name");
const expectedSha256 = getArg("--expected-sha256");
const expectedFlowSha256 = getArg("--expected-flow-sha256");

if (
  !inputPath
  || !outputPath
  || !reportPath
  || !expectedNodeId
  || !expectedNodeType
  || !expectedNodeName
  || !expectedSha256
  || !expectedFlowSha256
) {
  throw new Error(
    "Usage: node scripts/patch_live_tournament_finished_at_idempotency.mjs "
    + "--input <preimage-flow.json> --output <candidate-flow.json> "
    + "--report <report.json> --expected-node-id <id> "
    + "--expected-node-type <type> --expected-node-name <name> "
    + "--expected-sha256 <sha256> --expected-flow-sha256 <sha256>",
  );
}

const resolvedInputPath = path.resolve(inputPath);
const resolvedOutputPath = path.resolve(outputPath);
const resolvedReportPath = path.resolve(reportPath);
for (const [name, value] of [
  ["--expected-sha256", expectedSha256],
  ["--expected-flow-sha256", expectedFlowSha256],
]) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 64-character hexadecimal digest`);
  }
}

const sha256Bytes = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sha256 = (value) => sha256Bytes(Buffer.from(String(value ?? ""), "utf8"));
const sha256Json = (value) => sha256(JSON.stringify(value));

const canonicalizePath = (filePath) => {
  const absolutePath = path.resolve(filePath);
  if (fs.existsSync(absolutePath)) return fs.realpathSync(absolutePath);
  const parentPath = fs.realpathSync(path.dirname(absolutePath));
  return path.join(parentPath, path.basename(absolutePath));
};

const sameInode = (leftPath, rightPath) => {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const left = fs.statSync(leftPath);
  const right = fs.statSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
};

const canonicalInputPath = canonicalizePath(resolvedInputPath);
const canonicalOutputPath = canonicalizePath(resolvedOutputPath);
const canonicalReportPath = canonicalizePath(resolvedReportPath);
if (
  canonicalInputPath === canonicalOutputPath
  || canonicalInputPath === canonicalReportPath
  || canonicalOutputPath === canonicalReportPath
  || sameInode(resolvedInputPath, resolvedOutputPath)
  || sameInode(resolvedInputPath, resolvedReportPath)
  || sameInode(resolvedOutputPath, resolvedReportPath)
) {
  throw new Error(
    "Input, output, and report paths must not resolve to the same file or inode",
  );
}
if (fs.existsSync(resolvedOutputPath) || fs.existsSync(resolvedReportPath)) {
  throw new Error("Output and report destinations must not already exist");
}

const inputBytes = fs.readFileSync(canonicalInputPath);
const flowSha256 = sha256Bytes(inputBytes);
if (flowSha256 !== expectedFlowSha256.toLowerCase()) {
  throw new Error(
    `Flow preimage mismatch: expected ${expectedFlowSha256.toLowerCase()}, got ${flowSha256}`,
  );
}

const inputFlow = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(inputFlow)) throw new Error("Flow must be a JSON array");

const snapshotInvariants = (flow) => {
  const ids = flow.map((node, index) => {
    const id = String(node?.id || "");
    if (!id) throw new Error(`Node at index ${index} has no id`);
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Flow contains duplicate node IDs");
  }

  const wires = flow.map((node) => ({
    id: node.id,
    wires: Object.hasOwn(node, "wires") ? node.wires : null,
  }));
  const httpRoutes = flow
    .filter((node) => node?.type === "http in")
    .map((node) => ({
      id: node.id,
      z: node.z || "",
      method: node.method || "",
      url: node.url || "",
      name: node.name || "",
    }));

  return {
    ids,
    wires,
    httpRoutes,
    hashes: {
      idsSha256: sha256Json(ids),
      wiresSha256: sha256Json(wires),
      httpRoutesSha256: sha256Json(httpRoutes),
    },
  };
};

const beforeFlow = structuredClone(inputFlow);
const beforeInvariants = snapshotInvariants(beforeFlow);
const matchingNodes = inputFlow.filter((item) => item?.id === expectedNodeId);
if (matchingNodes.length !== 1) {
  throw new Error(
    `Expected exactly one node ${expectedNodeId}, found ${matchingNodes.length}`,
  );
}

const node = matchingNodes[0];
if (node.type !== expectedNodeType || node.name !== expectedNodeName) {
  throw new Error(
    `Node identity mismatch for ${expectedNodeId}: `
    + `expected ${expectedNodeType}/${expectedNodeName}, `
    + `got ${String(node.type)}/${String(node.name)}`,
  );
}

const beforeSha256 = sha256(node.func);
if (beforeSha256 !== expectedSha256.toLowerCase()) {
  throw new Error(
    `Preimage mismatch for ${expectedNodeId}: `
    + `expected ${expectedSha256.toLowerCase()}, got ${beforeSha256}`,
  );
}

const nextFunction = fs.readFileSync(functionPath, "utf8");
const afterSha256 = sha256(nextFunction);
if (afterSha256 !== expectedCandidateSha256) {
  throw new Error(
    `Candidate source mismatch: expected ${expectedCandidateSha256}, got ${afterSha256}`,
  );
}
if (afterSha256 === beforeSha256) {
  throw new Error("Candidate function is identical to the supplied preimage");
}

node.func = nextFunction;

const changed = inputFlow.flatMap((candidateNode, index) => {
  const beforeNode = beforeFlow[index];
  if (isDeepStrictEqual(candidateNode, beforeNode)) return [];
  const fields = [...new Set([
    ...Object.keys(beforeNode || {}),
    ...Object.keys(candidateNode || {}),
  ])]
    .filter((field) => !isDeepStrictEqual(beforeNode?.[field], candidateNode?.[field]))
    .sort();
  return [{ id: candidateNode?.id, fields }];
});
if (
  changed.length !== 1
  || changed[0].id !== expectedNodeId
  || !isDeepStrictEqual(changed[0].fields, ["func"])
) {
  throw new Error(
    `Candidate changed unexpected nodes or fields: ${JSON.stringify(changed)}`,
  );
}

const afterInvariants = snapshotInvariants(inputFlow);
const invariantChecks = {
  nodeIdsUnchanged: isDeepStrictEqual(
    beforeInvariants.ids,
    afterInvariants.ids,
  ),
  wiresUnchanged: isDeepStrictEqual(
    beforeInvariants.wires,
    afterInvariants.wires,
  ),
  httpRoutesUnchanged: isDeepStrictEqual(
    beforeInvariants.httpRoutes,
    afterInvariants.httpRoutes,
  ),
};
if (!Object.values(invariantChecks).every(Boolean)) {
  throw new Error(`Flow invariants changed: ${JSON.stringify(invariantChecks)}`);
}

const report = {
  ok: true,
  inputPath: canonicalInputPath,
  outputPath: canonicalOutputPath,
  flowSha256,
  nodeId: node.id,
  nodeType: node.type,
  nodeName: node.name,
  beforeSha256,
  afterSha256,
  changedNodes: changed.length,
  changedFields: changed[0].fields,
  invariants: {
    ...invariantChecks,
    nodeCount: inputFlow.length,
    httpRouteCount: afterInvariants.httpRoutes.length,
    ...afterInvariants.hashes,
  },
};

const temporaryPath = (destinationPath) => (
  path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
);
const outputTempPath = temporaryPath(canonicalOutputPath);
const reportTempPath = temporaryPath(canonicalReportPath);
let reportPublished = false;
let outputPublished = false;

const removeIfPresent = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

try {
  fs.writeFileSync(
    outputTempPath,
    `${JSON.stringify(inputFlow, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  fs.writeFileSync(
    reportTempPath,
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );

  fs.linkSync(reportTempPath, canonicalReportPath);
  reportPublished = true;
  fs.linkSync(outputTempPath, canonicalOutputPath);
  outputPublished = true;
} catch (error) {
  if (outputPublished) removeIfPresent(canonicalOutputPath);
  if (reportPublished) removeIfPresent(canonicalReportPath);
  throw error;
} finally {
  removeIfPresent(outputTempPath);
  removeIfPresent(reportTempPath);
}

console.log(JSON.stringify(report, null, 2));
