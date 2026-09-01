import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PARTNER_API_FLOW_NODE_IDS = Object.freeze({
  store: "a6f1000000000001",
  addIn: "a6f1000000000002",
  removeIn: "a6f1000000000003",
  operationIn: "a6f1000000000004",
  handler: "a6f1000000000005",
  response: "a6f1000000000006",
  comment: "a6f1000000000007",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const httpIn = (id, z, name, url, method, y) => ({
  id,
  type: "http in",
  z,
  name,
  url,
  method,
  upload: false,
  swaggerDoc: "",
  x: 210,
  y,
  wires: [[PARTNER_API_FLOW_NODE_IDS.handler]],
});

export function buildPartnerGameMembershipApiCandidate(sourceFlow, options = {}) {
  if (!Array.isArray(sourceFlow)) throw new Error("Node-RED source flow must be an array");
  const tabLabel = String(options.sourceTabLabel || "LK Games").trim();
  const matchingTabs = sourceFlow.filter((node) => node.type === "tab" && node.label === tabLabel);
  if (matchingTabs.length !== 1) throw new Error(`Expected exactly one source tab labelled ${tabLabel}`);
  const ids = new Set(sourceFlow.map((node) => node.id));
  const collisions = Object.values(PARTNER_API_FLOW_NODE_IDS).filter((id) => ids.has(id));
  if (collisions.length) throw new Error(`Partner API node id collision: ${collisions.join(",")}`);
  const conflictingRoutes = sourceFlow.filter((node) => (
    node.type === "http in"
    && String(node.url || "").startsWith("/lk/integrations/v1/")
  ));
  if (conflictingRoutes.length) {
    throw new Error(`Partner API route namespace is already present: ${conflictingRoutes.map((node) => node.id).join(",")}`);
  }
  const z = matchingTabs[0].id;
  const added = [
    {
      id: PARTNER_API_FLOW_NODE_IDS.store,
      type: "padlhub-partner-game-membership-store",
      name: "Partner game membership store (default off)",
      enabledEnv: "LK_PARTNER_GAME_API_ENABLED",
      mongoUriEnv: "LK_PARTNER_GAME_API_MONGO_URI",
      databaseNameEnv: "LK_PARTNER_GAME_API_MONGO_DB",
      keyringEnv: "LK_PARTNER_GAME_API_KEYRING_JSON",
      auditKeyEnv: "LK_PARTNER_GAME_API_AUDIT_HMAC_KEY",
      environmentEnv: "LK_PARTNER_GAME_API_ENVIRONMENT",
      providerModeEnv: "LK_PARTNER_GAME_API_PROVIDER_MODE",
      technicalVivaClientIdEnv: "LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID",
    },
    httpIn(
      PARTNER_API_FLOW_NODE_IDS.addIn,
      z,
      "Partner API: add paid member",
      "/lk/integrations/v1/open-games/:gameId/members",
      "post",
      180,
    ),
    httpIn(
      PARTNER_API_FLOW_NODE_IDS.removeIn,
      z,
      "Partner API: remove owned member",
      "/lk/integrations/v1/open-games/:gameId/members/:membershipId",
      "delete",
      240,
    ),
    httpIn(
      PARTNER_API_FLOW_NODE_IDS.operationIn,
      z,
      "Partner API: operation status",
      "/lk/integrations/v1/operations/:operationId",
      "get",
      300,
    ),
    {
      id: PARTNER_API_FLOW_NODE_IDS.handler,
      type: "padlhub-partner-game-membership-http",
      z,
      name: "Verify proof + owned membership command",
      store: PARTNER_API_FLOW_NODE_IDS.store,
      x: 610,
      y: 240,
      wires: [[PARTNER_API_FLOW_NODE_IDS.response]],
    },
    {
      id: PARTNER_API_FLOW_NODE_IDS.response,
      type: "http response",
      z,
      name: "Partner API response",
      statusCode: "",
      headers: {},
      x: 960,
      y: 240,
      wires: [],
    },
    {
      id: PARTNER_API_FLOW_NODE_IDS.comment,
      type: "comment",
      z,
      name: "Partner API is fail-closed; real Viva provider is intentionally unavailable in v0.1",
      info: "Install only from a fresh LK Games live-flow snapshot. Runtime remains disabled unless the server-only enable flag is exactly true. Synthetic provider is accepted only with loopback Mongo and local/test/dev database naming.",
      x: 590,
      y: 120,
      wires: [],
    },
  ];
  return {
    flow: [...sourceFlow, ...added],
    addedNodeIds: added.map((node) => node.id),
    sourceTabId: z,
    sourceTabLabel: tabLabel,
  };
}

export function parseArgs(argv) {
  const result = { sourceTabLabel: "LK Games" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") result.input = argv[++index];
    else if (token === "--output") result.output = argv[++index];
    else if (token === "--source-sha256") result.sourceSha256 = argv[++index];
    else if (token === "--source-tab-label") result.sourceTabLabel = argv[++index];
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!result.input || !result.output || !/^[a-f0-9]{64}$/.test(result.sourceSha256 || "")) {
    throw new Error("Usage: --input <fresh-live-flow.json> --output <candidate.json> --source-sha256 <sha256> [--source-tab-label <label>]");
  }
  if (path.resolve(result.input) === path.resolve(result.output)) throw new Error("In-place flow mutation is forbidden");
  return result;
}

export function buildCandidateFile(options) {
  const sourceBytes = fs.readFileSync(path.resolve(options.input));
  const actualSourceSha256 = sha256(sourceBytes);
  if (actualSourceSha256 !== options.sourceSha256) {
    throw new Error(`Fresh source SHA-256 mismatch: expected ${options.sourceSha256}, received ${actualSourceSha256}`);
  }
  const sourceFlow = JSON.parse(sourceBytes.toString("utf8"));
  const result = buildPartnerGameMembershipApiCandidate(sourceFlow, options);
  const candidateBytes = Buffer.from(`${JSON.stringify(result.flow, null, 2)}\n`);
  fs.writeFileSync(path.resolve(options.output), candidateBytes, { flag: "wx" });
  const manifest = {
    schemaVersion: 1,
    artifact: "partner-game-membership-api-source-only-candidate",
    deploymentPerformed: false,
    activationPerformed: false,
    source: {
      path: path.resolve(options.input),
      sha256: actualSourceSha256,
      tabId: result.sourceTabId,
      tabLabel: result.sourceTabLabel,
    },
    candidate: {
      path: path.resolve(options.output),
      sha256: sha256(candidateBytes),
      addedNodeIds: result.addedNodeIds,
    },
  };
  fs.writeFileSync(`${path.resolve(options.output)}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(buildCandidateFile(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
