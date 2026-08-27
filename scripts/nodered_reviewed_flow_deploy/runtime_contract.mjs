import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const CONTRACT_FORMAT_VERSION = 1;
export const EXACT_GRAPH_CONTRACT_FORMAT_VERSION = 2;
export const EXACT_GRAPH_CONTRACT_KIND = "exact-graph";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const exactNodeMap = (flow, label) => {
  if (!Array.isArray(flow)) throw new Error(`${label} must be a Node-RED flow array`);
  const result = new Map();
  for (const node of flow) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`${label} contains a non-object node`);
    }
    const id = typeof node.id === "string" ? node.id.trim() : "";
    if (!id || result.has(id)) throw new Error(`${label} contains a missing or duplicate node ID`);
    result.set(id, node);
  }
  return result;
};

const changedFields = (before, after) => [...new Set([
  ...Object.keys(before),
  ...Object.keys(after),
])].filter((key) => !isDeepStrictEqual(before[key], after[key])).sort();

const nodeSha256 = (node) => sha256(Buffer.from(JSON.stringify(node), "utf8"));

const withoutWires = (node) => {
  const result = { ...node };
  delete result.wires;
  return result;
};

const assertHttpInputsPreservedExceptWires = (liveFlow, candidateFlow) => {
  const liveRoutes = liveFlow.filter((node) => node.type === "http in");
  const candidateRoutes = candidateFlow.filter((node) => node.type === "http in");
  const liveById = new Map(liveRoutes.map((node) => [node.id, node]));
  const candidateById = new Map(candidateRoutes.map((node) => [node.id, node]));
  const liveIds = [...liveById.keys()].sort();
  const candidateIds = [...candidateById.keys()].sort();
  if (!isDeepStrictEqual(liveIds, candidateIds)) throw new Error("Candidate changed HTTP routes");
  for (const id of liveIds) {
    if (!isDeepStrictEqual(withoutWires(liveById.get(id)), withoutWires(candidateById.get(id)))) {
      throw new Error(`Candidate changed HTTP route identity or configuration: ${id}`);
    }
  }
  return liveRoutes.length;
};

const assertDigest = (value, label) => {
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw new Error(`${label} is invalid`);
  return value;
};

const assertDeploymentId = (value) => {
  const normalized = String(value || "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(normalized)) {
    throw new Error("Deployment ID must be a lowercase kebab-case identifier");
  }
  return normalized;
};

export function buildFunctionOnlyContract({ liveBytes, candidateBytes, deploymentId, allowedNodeIds }) {
  const normalizedDeploymentId = assertDeploymentId(deploymentId);
  const allowed = [...new Set((allowedNodeIds || []).map((value) => String(value || "").trim()))];
  if (!allowed.length || allowed.some((id) => !id) || allowed.length !== (allowedNodeIds || []).length) {
    throw new Error("Allowed node IDs must be a non-empty unique list");
  }
  const liveFlow = JSON.parse(Buffer.from(liveBytes).toString("utf8"));
  const candidateFlow = JSON.parse(Buffer.from(candidateBytes).toString("utf8"));
  const liveById = exactNodeMap(liveFlow, "Live flow");
  const candidateById = exactNodeMap(candidateFlow, "Candidate flow");
  if (liveFlow.length !== candidateFlow.length || liveById.size !== candidateById.size) {
    throw new Error("Function-only candidate cannot add or remove nodes");
  }
  for (const id of liveById.keys()) {
    if (!candidateById.has(id)) throw new Error(`Function-only candidate changed node identity: ${id}`);
  }
  const actualChanged = [];
  for (const [id, before] of liveById) {
    const fields = changedFields(before, candidateById.get(id));
    if (fields.length) actualChanged.push({ id, fields });
  }
  const actualIds = actualChanged.map(({ id }) => id).sort();
  const expectedIds = [...allowed].sort();
  if (!isDeepStrictEqual(actualIds, expectedIds)) {
    throw new Error(`Candidate changed-node set mismatch: ${actualIds.join(",")}`);
  }
  for (const change of actualChanged) {
    if (!isDeepStrictEqual(change.fields, ["func"])) {
      throw new Error(`Function-only candidate changed forbidden fields for ${change.id}: ${change.fields.join(",")}`);
    }
    const before = liveById.get(change.id);
    const after = candidateById.get(change.id);
    if (before.type !== "function" || after.type !== "function") {
      throw new Error(`Allowed node is not a function: ${change.id}`);
    }
  }
  const liveRoutes = liveFlow.filter((node) => node.type === "http in");
  const candidateRoutes = candidateFlow.filter((node) => node.type === "http in");
  if (!isDeepStrictEqual(liveRoutes, candidateRoutes)) throw new Error("Candidate changed HTTP routes");

  return {
    formatVersion: CONTRACT_FORMAT_VERSION,
    deploymentId: normalizedDeploymentId,
    sourceSha256: sha256(liveBytes),
    candidateSha256: sha256(candidateBytes),
    nodeCount: liveFlow.length,
    httpInputCount: liveRoutes.length,
    allowedChanges: actualChanged
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id }) => ({
        id,
        fields: ["func"],
        sourceFuncSha256: sha256(Buffer.from(String(liveById.get(id).func || ""), "utf8")),
        candidateFuncSha256: sha256(Buffer.from(String(candidateById.get(id).func || ""), "utf8")),
      })),
  };
}

export function buildExactGraphContract({
  liveBytes,
  candidateBytes,
  deploymentId,
  allowedChanges,
  allowedAdditionIds,
}) {
  const normalizedDeploymentId = assertDeploymentId(deploymentId);
  const normalizedChanges = (allowedChanges || []).map((change) => ({
    id: String(change?.id || "").trim(),
    fields: [...new Set((change?.fields || []).map((field) => String(field || "").trim()))].sort(),
  }));
  const normalizedAdditionIds = [...new Set(
    (allowedAdditionIds || []).map((id) => String(id || "").trim()),
  )].sort();
  if (
    !normalizedChanges.length
    || normalizedChanges.some((change) => !change.id || !change.fields.length || change.fields.some((field) => !field))
    || new Set(normalizedChanges.map((change) => change.id)).size !== normalizedChanges.length
    || !normalizedAdditionIds.length
    || normalizedAdditionIds.some((id) => !id)
    || normalizedAdditionIds.length !== (allowedAdditionIds || []).length
    || normalizedChanges.some((change) => normalizedAdditionIds.includes(change.id))
  ) throw new Error("Exact-graph allowance must contain unique changed and added node contracts");

  const liveFlow = JSON.parse(Buffer.from(liveBytes).toString("utf8"));
  const candidateFlow = JSON.parse(Buffer.from(candidateBytes).toString("utf8"));
  const liveById = exactNodeMap(liveFlow, "Live flow");
  const candidateById = exactNodeMap(candidateFlow, "Candidate flow");
  for (const id of liveById.keys()) {
    if (!candidateById.has(id)) throw new Error(`Exact-graph candidate removed live node: ${id}`);
  }

  const actualChanges = [];
  for (const [id, before] of liveById) {
    const fields = changedFields(before, candidateById.get(id));
    if (fields.length) actualChanges.push({ id, fields });
  }
  actualChanges.sort((left, right) => left.id.localeCompare(right.id));
  normalizedChanges.sort((left, right) => left.id.localeCompare(right.id));
  if (!isDeepStrictEqual(actualChanges, normalizedChanges)) {
    throw new Error(`Exact-graph changed-node contract mismatch: ${actualChanges.map(({ id }) => id).join(",")}`);
  }

  const actualAdditionIds = [...candidateById.keys()]
    .filter((id) => !liveById.has(id))
    .sort();
  if (!isDeepStrictEqual(actualAdditionIds, normalizedAdditionIds)) {
    throw new Error(`Exact-graph added-node contract mismatch: ${actualAdditionIds.join(",")}`);
  }
  const httpInputCount = assertHttpInputsPreservedExceptWires(liveFlow, candidateFlow);

  return {
    formatVersion: EXACT_GRAPH_CONTRACT_FORMAT_VERSION,
    contractKind: EXACT_GRAPH_CONTRACT_KIND,
    deploymentId: normalizedDeploymentId,
    sourceSha256: sha256(liveBytes),
    candidateSha256: sha256(candidateBytes),
    sourceNodeCount: liveFlow.length,
    candidateNodeCount: candidateFlow.length,
    httpInputCount,
    allowedChanges: actualChanges.map(({ id, fields }) => ({
      id,
      fields,
      sourceNodeSha256: nodeSha256(liveById.get(id)),
      candidateNodeSha256: nodeSha256(candidateById.get(id)),
    })),
    allowedAdditions: actualAdditionIds.map((id) => ({
      id,
      type: candidateById.get(id).type,
      candidateNodeSha256: nodeSha256(candidateById.get(id)),
    })),
  };
}

export function validateFunctionOnlyContract({ liveBytes, candidateBytes, contract }) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("Reviewed-flow contract must be an object");
  }
  if (contract.formatVersion !== CONTRACT_FORMAT_VERSION) throw new Error("Reviewed-flow contract version mismatch");
  assertDeploymentId(contract.deploymentId);
  assertDigest(contract.sourceSha256, "Source digest");
  assertDigest(contract.candidateSha256, "Candidate digest");
  if (sha256(liveBytes) !== contract.sourceSha256) throw new Error("Live flow digest differs from reviewed contract");
  if (sha256(candidateBytes) !== contract.candidateSha256) throw new Error("Candidate digest differs from reviewed contract");
  const allowedChanges = Array.isArray(contract.allowedChanges) ? contract.allowedChanges : [];
  const rebuilt = buildFunctionOnlyContract({
    liveBytes,
    candidateBytes,
    deploymentId: contract.deploymentId,
    allowedNodeIds: allowedChanges.map((change) => change?.id),
  });
  if (!isDeepStrictEqual(rebuilt, contract)) throw new Error("Reviewed-flow contract content mismatch");
  return rebuilt;
}

export function validateExactGraphContract({ liveBytes, candidateBytes, contract }) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("Reviewed-flow contract must be an object");
  }
  if (
    contract.formatVersion !== EXACT_GRAPH_CONTRACT_FORMAT_VERSION
    || contract.contractKind !== EXACT_GRAPH_CONTRACT_KIND
  ) throw new Error("Exact-graph contract version mismatch");
  assertDeploymentId(contract.deploymentId);
  assertDigest(contract.sourceSha256, "Source digest");
  assertDigest(contract.candidateSha256, "Candidate digest");
  if (sha256(liveBytes) !== contract.sourceSha256) throw new Error("Live flow digest differs from reviewed contract");
  if (sha256(candidateBytes) !== contract.candidateSha256) throw new Error("Candidate digest differs from reviewed contract");
  const allowedChanges = Array.isArray(contract.allowedChanges) ? contract.allowedChanges : [];
  const allowedAdditions = Array.isArray(contract.allowedAdditions) ? contract.allowedAdditions : [];
  const rebuilt = buildExactGraphContract({
    liveBytes,
    candidateBytes,
    deploymentId: contract.deploymentId,
    allowedChanges: allowedChanges.map((change) => ({ id: change?.id, fields: change?.fields })),
    allowedAdditionIds: allowedAdditions.map((addition) => addition?.id),
  });
  if (!isDeepStrictEqual(rebuilt, contract)) throw new Error("Exact-graph contract content mismatch");
  return rebuilt;
}

export function validateReviewedFlowContract(options) {
  if (options?.contract?.formatVersion === CONTRACT_FORMAT_VERSION) {
    return validateFunctionOnlyContract(options);
  }
  if (options?.contract?.formatVersion === EXACT_GRAPH_CONTRACT_FORMAT_VERSION) {
    return validateExactGraphContract(options);
  }
  throw new Error("Reviewed-flow contract version mismatch");
}

export function assertProtectedFileModes(
  filePath,
  { uid = 0, gid = 0, modes = [0o600] } = {},
) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid) {
    throw new Error(`Protected file contract mismatch: ${filePath}`);
  }
  const actualMode = stat.mode & 0o777;
  if (!modes.includes(actualMode)) throw new Error(`Protected file mode mismatch: ${filePath}`);
  return stat;
}

export function assertProtectedFile(filePath, { uid = 0, gid = 0, mode = 0o600 } = {}) {
  return assertProtectedFileModes(filePath, { uid, gid, modes: [mode] });
}

export function atomicWrite(destination, bytes, { uid = 0, gid = 0 } = {}) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.chownSync(temporary, uid, gid);
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or absent */ }
  }
}
