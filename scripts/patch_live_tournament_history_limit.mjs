#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const targetContract = {
  id: "ddc581fde0073e34",
  type: "mongodb4",
  name: "Find tournament history",
  z: "f9575c8726e29196",
  mode: "collection",
  collection: "tournaments",
  operation: "find",
  output: "toArray",
  maxTimeMS: "5000",
  wires: [["a57565a6ddbb532f"]],
};
const routeContract = {
  id: "ccd7d6b82f8b90c1",
  type: "http in",
  z: "f9575c8726e29196",
  name: "Americano history",
  method: "get",
  url: "/lk/tournaments/americano/history",
  upload: false,
  wires: [["11b8491cc624fb42", "0299bf5612ade8d5"]],
};
const queryContract = {
  id: "11b8491cc624fb42",
  type: "change",
  z: "f9575c8726e29196",
  name: "History by tournamentId",
  rules: [{
    t: "set",
    p: "payload",
    pt: "msg",
    to: '{ "tournamentId": $$.req.query.tournamentId }',
    tot: "jsonata",
  }],
  wires: [["ddc581fde0073e34"]],
};
const debugContract = {
  id: "0299bf5612ade8d5",
  type: "debug",
  z: "f9575c8726e29196",
  name: "Americano save payload",
  active: false,
};
const expectedTargetPreimageSha256 =
  "c2fe2964effcf33bfc9e5a3d5a1e29066c758fbf28950f1a28000f2475022d96";
const expectedTargetCandidateSha256 =
  "4b13538168725e97f63415ffeb93b71b7c27e14c10dceffd12fdf5ac0be0113c";

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const inputPath = getArg("--input");
const outputPath = getArg("--output");
const reportPath = getArg("--report");
const expectedFlowSha256 = getArg("--expected-flow-sha256");
if (!inputPath || !outputPath || !reportPath || !expectedFlowSha256) {
  throw new Error(
    "Usage: node scripts/patch_live_tournament_history_limit.mjs "
    + "--input <post-rating-flow.json> --output <candidate-flow.json> "
    + "--report <report.json> --expected-flow-sha256 <sha256>",
  );
}
if (!/^[a-f0-9]{64}$/i.test(expectedFlowSha256)) {
  throw new Error(
    "--expected-flow-sha256 must be a 64-character hexadecimal digest",
  );
}

const sha256Bytes = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sha256Json = (value) => sha256Bytes(
  Buffer.from(JSON.stringify(value), "utf8"),
);

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

const resolvedInputPath = path.resolve(inputPath);
const resolvedOutputPath = path.resolve(outputPath);
const resolvedReportPath = path.resolve(reportPath);
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

const findExactNode = (id, label) => {
  const matches = inputFlow.filter((node) => node?.id === id);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} node ${id}, found ${matches.length}`);
  }
  return matches[0];
};

const assertFields = (node, contract, label) => {
  for (const [field, expected] of Object.entries(contract)) {
    if (!isDeepStrictEqual(node?.[field], expected)) {
      throw new Error(
        `${label} contract mismatch for ${field}: `
        + `expected ${JSON.stringify(expected)}, got ${JSON.stringify(node?.[field])}`,
      );
    }
  }
};

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
const targetNode = findExactNode(targetContract.id, "target");
assertFields(targetNode, targetContract, "Target node");
if (Object.hasOwn(targetNode, "limit")) {
  throw new Error(
    `Target limit must be absent in the approved preimage, got ${JSON.stringify(targetNode.limit)}`,
  );
}
const targetPreimageSha256 = sha256Json(targetNode);
if (targetPreimageSha256 !== expectedTargetPreimageSha256) {
  throw new Error(
    `Target node preimage mismatch: expected ${expectedTargetPreimageSha256}, `
    + `got ${targetPreimageSha256}`,
  );
}

assertFields(
  findExactNode(routeContract.id, "route"),
  routeContract,
  "History route",
);
assertFields(
  findExactNode(queryContract.id, "query"),
  queryContract,
  "History query",
);
assertFields(
  findExactNode(debugContract.id, "debug"),
  debugContract,
  "History debug",
);

targetNode.limit = "1";
const targetCandidateSha256 = sha256Json(targetNode);
if (targetCandidateSha256 !== expectedTargetCandidateSha256) {
  throw new Error(
    `Target node candidate mismatch: expected ${expectedTargetCandidateSha256}, `
    + `got ${targetCandidateSha256}`,
  );
}

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
  || changed[0].id !== targetContract.id
  || !isDeepStrictEqual(changed[0].fields, ["limit"])
) {
  throw new Error(
    `Candidate changed unexpected nodes or fields: ${JSON.stringify(changed)}`,
  );
}
for (let index = 0; index < inputFlow.length; index += 1) {
  if (inputFlow[index]?.id === targetContract.id) continue;
  if (!isDeepStrictEqual(inputFlow[index], beforeFlow[index])) {
    throw new Error(`Non-target node changed: ${String(inputFlow[index]?.id)}`);
  }
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
  nodeId: targetNode.id,
  nodeType: targetNode.type,
  nodeName: targetNode.name,
  nodeTab: targetNode.z,
  beforeSha256: targetPreimageSha256,
  afterSha256: targetCandidateSha256,
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
