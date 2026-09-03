#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import {
  deriveDevWholeFlowIsolation,
  hasUniqueFlowIds,
  hasSafeDevHttpSemantics,
} from "./lk1_subscription_dev_execution_contract.mjs";

const [sourcePath, metaPath, credentialStorePath] = process.argv.slice(2);
if (!sourcePath || !metaPath) {
  throw new Error("Usage: inspect_lk1_subscription_dev_snapshot.mjs <source> <metadata> [credentials]");
}
const raw = fs.readFileSync(sourcePath);
const flow = JSON.parse(raw.toString("utf8"));
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const provisioning = JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_provisioning_contract.json", import.meta.url),
  "utf8",
));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const allowedEndpointOrigins = new Set([
  `http://${provisioning.fixtureDependencies.cup.listener}`,
  `http://${provisioning.fixtureDependencies.provider.listener}`,
  `http://${provisioning.fixtureDependencies.identity.listener}`,
]);
const endpointInventory = [];
const collectEndpointLiterals = (value, pathPrefix = "$") => {
  if (typeof value === "string") {
    for (const literal of value.match(/https?:\/\/[^\s"'`]+/g) || []) {
      const normalized = literal.replace(/[),;]+$/, "");
      let parsed = null;
      try {
        parsed = new URL(normalized);
      } catch {
        // A malformed endpoint literal is cross-environment evidence.
      }
      endpointInventory.push({ path: pathPrefix, literal: normalized, origin: parsed?.origin || null });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectEndpointLiterals(entry, `${pathPrefix}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "func" && value.type === "function") continue;
    collectEndpointLiterals(entry, `${pathPrefix}.${key}`);
  }
};
collectEndpointLiterals(flow);
const crossEnvironmentEndpoints = endpointInventory.filter((entry) => (
  !entry.origin || !allowedEndpointOrigins.has(entry.origin)
));
const ids = new Set(flow.map((node) => node?.id));
const tabs = new Map(flow.filter((node) => node?.type === "tab").map((node) => [node.id, node]));
let brokenWires = 0;
let brokenLinks = 0;
for (const node of flow) {
  for (const target of (Array.isArray(node?.wires) ? node.wires : []).flat()) {
    if (!ids.has(target)) brokenWires += 1;
  }
  if (["link in", "link out"].includes(node?.type) && Array.isArray(node.links)) {
    for (const target of node.links) if (!ids.has(target)) brokenLinks += 1;
  }
}

const targetSpec = {
  tabLabel: "LK Games",
  routerNodeId: "lk_subscription_booking_router_20260804",
  routerNodeName: "Route atomic subscription booking",
  prepareNodeId: "lk_subscription_booking_prepare_20260804",
  prepareNodeName: "Prepare subscription booking",
  splitRouterNodeId: "8f7bd5b482fe9763",
  splitRouterNodeName: "Route Viva split payment",
  splitCreatePrepareNodeId: "f3f9a60354d394da",
  splitCreatePrepareNodeName: "Prepare split game payment",
  splitJoinPrepareNodeId: "e92e68bf3f08a70c",
  splitJoinPrepareNodeName: "Prepare split join payment",
  finalizeNodeId: "lk_subscription_booking_finalize_20260804",
  finalizeNodeName: "Finalize subscription booking response",
};
const targetNode = (id) => flow.filter((node) => node?.id === id);
const semanticCount = (name) => flow.filter((node) => (
  node?.type === "function"
  && node.name === name
  && tabs.get(node.z)?.label === targetSpec.tabLabel
  && tabs.get(node.z)?.disabled !== true
)).length;
const router = targetNode(targetSpec.routerNodeId);
const prepare = targetNode(targetSpec.prepareNodeId);
const splitRouter = targetNode(targetSpec.splitRouterNodeId);
const splitCreatePrepare = targetNode(targetSpec.splitCreatePrepareNodeId);
const splitJoinPrepare = targetNode(targetSpec.splitJoinPrepareNodeId);
const finalize = targetNode(targetSpec.finalizeNodeId);
const httpRequests = flow.filter((node) => node?.id === "lk_subscription_booking_http_20260804");
const splitCreateHttpRequests = flow.filter((node) => node?.id === "ee7ba8cdd68bdf74");
const allHttpRequests = flow.filter((node) => node?.type === "http request");
const legacyMongoConfigs = flow.filter((node) => node?.type === "mongodb");
const mongo4Clients = flow.filter((node) => node?.type === "mongodb4-client");
const mongo4Nodes = flow.filter((node) => node?.type === "mongodb4");
const expectedMongo = provisioning.fixtureDependencies.mongo;
const effectiveMongoIdentity = (node) => {
  const uri = String(node?.uri || "").trim();
  if (uri && uri !== "__MONGODB_URI_REQUIRED__") {
    try {
      const parsed = new URL(uri);
      const advanced = JSON.parse(String(node?.advanced ?? "{}"));
      if (!advanced || typeof advanced !== "object" || Array.isArray(advanced)) return null;
      const serializedCredentialFields = [
        node?.username, node?.password, node?.authSource, node?.authMechanism,
        node?.tlsCAFile, node?.tlsCertificateKeyFile,
      ].some((value) => String(value || "").trim());
      return {
        mode: "uri",
        protocol: parsed.protocol.replace(/:$/, ""),
        host: parsed.hostname,
        port: Number(parsed.port || 27017),
        database: parsed.pathname.replace(/^\//, ""),
        credentialsPresent: Boolean(parsed.username || parsed.password || serializedCredentialFields),
        optionsPresent: Boolean(parsed.search || parsed.hash
          || Object.keys(advanced || {}).length
          || node?.tls === true || node?.tlsInsecure === true),
        uriTabActive: String(node?.uriTabActive || ""),
      };
    } catch {
      return null;
    }
  }
  return null;
};
const fixtureOnlyMongoIdentity = (identity) => Boolean(identity
  && identity.protocol === "mongodb"
  && identity.host === expectedMongo.host
  && identity.port === expectedMongo.port
  && identity.database === expectedMongo.database
  && identity.credentialsPresent === false
  && identity.optionsPresent === false
  && identity.uriTabActive === "tab-uri-advanced");
const crossEnvironmentLegacyMongoConfigs = legacyMongoConfigs.filter((node) => {
  const host = String(node.hostname || node.url || node.uri || "").toLowerCase();
  return host && !/(^|\/\/)(127\.0\.0\.1|localhost)([:/]|$)/.test(host);
});
const crossEnvironmentMongo4Clients = mongo4Clients.filter((node) => (
  !fixtureOnlyMongoIdentity(effectiveMongoIdentity(node))
));
const managedMongoSpecs = [
  { id: "lk_subscription_booking_find_20260804", operation: "find", routerOutputIndex: 1 },
  { id: "lk_subscription_booking_insert_20260804", operation: "insertOne", routerOutputIndex: 2 },
  { id: "lk_subscription_booking_update_20260804", operation: "updateOne", routerOutputIndex: 3 },
];
const managedMongoNodes = managedMongoSpecs.map((spec) => {
  const matches = mongo4Nodes.filter((node) => node.id === spec.id);
  const node = matches.length === 1 ? matches[0] : null;
  return {
    ...spec,
    present: Boolean(node),
    clientNode: node?.clientNode || null,
    collection: node?.collection || null,
    actualOperation: node?.operation ?? null,
    mode: node?.mode ?? null,
    output: node?.output ?? null,
    maxTimeMS: node?.maxTimeMS ?? null,
    handleDocId: node?.handleDocId ?? null,
    returnsToRouter: Boolean(node
      && JSON.stringify(node.wires) === JSON.stringify([[targetSpec.routerNodeId]])),
    wiredFromRouter: Boolean(router.length === 1
      && JSON.stringify(router[0].wires?.[spec.routerOutputIndex]) === JSON.stringify([spec.id])),
    preimageSha256: node ? sha256(JSON.stringify(node)) : null,
  };
});
const referencedClientIds = [...new Set(managedMongoNodes.map((node) => node.clientNode).filter(Boolean))];
const managedMongoClient = referencedClientIds.length === 1
  ? mongo4Clients.filter((node) => node.id === referencedClientIds[0])
  : [];
const managedMongoIdentity = managedMongoClient.length === 1
  ? effectiveMongoIdentity(managedMongoClient[0])
  : null;
const targetPresent = router.length === 1 && prepare.length === 1
  && splitRouter.length === 1 && splitCreatePrepare.length === 1
  && splitJoinPrepare.length === 1 && finalize.length === 1;
const expectedHttpInboundEdges = [
  `${targetSpec.prepareNodeId}:0:lk_subscription_booking_http_20260804`,
  `${targetSpec.routerNodeId}:0:lk_subscription_booking_http_20260804`,
  `${targetSpec.splitRouterNodeId}:0:ee7ba8cdd68bdf74`,
  `${targetSpec.splitRouterNodeId}:3:lk_subscription_booking_http_20260804`,
  `${targetSpec.splitCreatePrepareNodeId}:0:ee7ba8cdd68bdf74`,
  `${targetSpec.splitJoinPrepareNodeId}:0:ee7ba8cdd68bdf74`,
].sort();
const actualHttpInboundEdges = flow.flatMap((node) => (
  (Array.isArray(node?.wires) ? node.wires : []).flatMap((targets, outputIndex) => (
    (Array.isArray(targets) ? targets : [])
      .filter((target) => [
        "lk_subscription_booking_http_20260804", "ee7ba8cdd68bdf74",
      ].includes(target))
      .map((target) => `${node.id}:${outputIndex}:${target}`)
  ))
)).sort();
const httpRequestBindingVerified = hasUniqueFlowIds(flow) && targetPresent
  && JSON.stringify(allHttpRequests.map((node) => node.id).sort())
    === JSON.stringify(["ee7ba8cdd68bdf74", "lk_subscription_booking_http_20260804"])
  && JSON.stringify(actualHttpInboundEdges) === JSON.stringify(expectedHttpInboundEdges)
  && httpRequests.length === 1
  && hasSafeDevHttpSemantics(httpRequests[0])
  && JSON.stringify(httpRequests[0].wires) === JSON.stringify([[targetSpec.routerNodeId]])
  && JSON.stringify(router[0].wires?.[0]) === JSON.stringify([httpRequests[0].id])
  && JSON.stringify(prepare[0].wires?.[0]) === JSON.stringify([httpRequests[0].id])
  && JSON.stringify(splitRouter[0].wires?.[0]) === JSON.stringify([splitCreateHttpRequests[0].id])
  && JSON.stringify(splitRouter[0].wires?.[3]) === JSON.stringify([httpRequests[0].id])
  && splitCreateHttpRequests.length === 1
  && hasSafeDevHttpSemantics(splitCreateHttpRequests[0])
  && JSON.stringify(splitCreatePrepare[0].wires?.[0])
    === JSON.stringify([splitCreateHttpRequests[0].id])
  && JSON.stringify(splitCreatePrepare[0].wires?.[3])
    === JSON.stringify([targetSpec.splitRouterNodeId])
  && JSON.stringify(splitJoinPrepare[0].wires?.[0])
    === JSON.stringify([splitCreateHttpRequests[0].id])
  && JSON.stringify(splitJoinPrepare[0].wires?.[3])
    === JSON.stringify([targetSpec.splitRouterNodeId])
  && JSON.stringify(splitCreateHttpRequests[0].wires)
    === JSON.stringify([[targetSpec.splitRouterNodeId]]);
const wholeFlowIsolation = deriveDevWholeFlowIsolation(flow, targetSpec);
let mongoCredentialStoreVerifiedEmpty = false;
let mongoCredentialStorePreimageSha256 = null;
if (credentialStorePath) {
  try {
    const credentialStoreBytes = fs.readFileSync(credentialStorePath);
    const credentialStore = JSON.parse(credentialStoreBytes.toString("utf8"));
    mongoCredentialStoreVerifiedEmpty = Boolean(
      credentialStore && typeof credentialStore === "object"
      && !Array.isArray(credentialStore) && Object.keys(credentialStore).length === 0
    );
    mongoCredentialStorePreimageSha256 = mongoCredentialStoreVerifiedEmpty
      ? sha256(credentialStoreBytes) : null;
  } catch {
    mongoCredentialStoreVerifiedEmpty = false;
    mongoCredentialStorePreimageSha256 = null;
  }
}
const expectedMongoEdges = managedMongoSpecs.map((spec) => (
  `${targetSpec.routerNodeId}:${spec.routerOutputIndex}:${spec.id}`
)).sort();
const actualMongoEdges = flow.flatMap((node) => (node.wires || []).flatMap((targets, index) => (
  targets.filter((id) => managedMongoSpecs.some((spec) => spec.id === id))
    .map((id) => `${node.id}:${index}:${id}`)
))).sort();
const mongoBindingVerifiedDevOnly = targetPresent
  && mongo4Clients.length === 1 && legacyMongoConfigs.length === 0
  && mongo4Nodes.length === managedMongoSpecs.length
  && JSON.stringify(actualMongoEdges) === JSON.stringify(expectedMongoEdges)
  && managedMongoNodes.every((node) => node.present
    && node.collection === "lk_subscription_daily_booking_ops"
    && node.actualOperation === node.operation
    && node.mode === "collection" && node.output === "toArray"
    && node.maxTimeMS === "5000" && node.handleDocId === false
    && node.clientNode === referencedClientIds[0]
    && node.wiredFromRouter
    && node.returnsToRouter)
  && managedMongoClient.length === 1
  && fixtureOnlyMongoIdentity(managedMongoIdentity)
  && mongoCredentialStoreVerifiedEmpty;

const audit = {
  ...meta,
  sourceSha256: sha256(raw),
  nodeCount: flow.length,
  httpRouteCount: flow.filter((node) => node?.type === "http in").length,
  tabCount: flow.filter((node) => node?.type === "tab").length,
  brokenWires,
  brokenLinks,
  target: {
    ...targetSpec,
    present: targetPresent,
    enabledDuplicateCount: Math.max(
      semanticCount(targetSpec.routerNodeName),
      semanticCount(targetSpec.prepareNodeName),
      semanticCount(targetSpec.splitRouterNodeName),
      semanticCount(targetSpec.splitCreatePrepareNodeName),
      semanticCount(targetSpec.splitJoinPrepareNodeName),
      semanticCount(targetSpec.finalizeNodeName),
    ),
    routerPreimageSha256: router.length === 1 ? sha256(String(router[0].func || "")) : null,
    routerNodePreimageSha256: router.length === 1 ? sha256(JSON.stringify(router[0])) : null,
    preparePreimageSha256: prepare.length === 1 ? sha256(String(prepare[0].func || "")) : null,
    prepareNodePreimageSha256: prepare.length === 1 ? sha256(JSON.stringify(prepare[0])) : null,
    splitRouterPreimageSha256: splitRouter.length === 1 ? sha256(String(splitRouter[0].func || "")) : null,
    splitRouterNodePreimageSha256: splitRouter.length === 1 ? sha256(JSON.stringify(splitRouter[0])) : null,
    splitCreatePreparePreimageSha256: splitCreatePrepare.length === 1
      ? sha256(String(splitCreatePrepare[0].func || "")) : null,
    splitCreatePrepareNodePreimageSha256: splitCreatePrepare.length === 1
      ? sha256(JSON.stringify(splitCreatePrepare[0])) : null,
    splitJoinPreparePreimageSha256: splitJoinPrepare.length === 1
      ? sha256(String(splitJoinPrepare[0].func || "")) : null,
    splitJoinPrepareNodePreimageSha256: splitJoinPrepare.length === 1
      ? sha256(JSON.stringify(splitJoinPrepare[0])) : null,
    finalizePreimageSha256: finalize.length === 1 ? sha256(String(finalize[0].func || "")) : null,
    finalizeNodePreimageSha256: finalize.length === 1 ? sha256(JSON.stringify(finalize[0])) : null,
  },
  dependencies: {
    wholeFlowIsolationVerified: wholeFlowIsolation.verified,
    wholeFlowIsolationViolations: wholeFlowIsolation.violations,
    executionFunctionPreimages: (wholeFlowIsolation.reachableFunctionIds || []).map((id) => ({
      id,
      nodeSha256: sha256(JSON.stringify(flow.find((node) => node?.id === id))),
    })),
    httpRequestBindingVerified,
    httpRequestPreimageSha256: httpRequests.length === 1
      ? sha256(JSON.stringify(httpRequests[0])) : null,
    splitCreateHttpRequestPreimageSha256: splitCreateHttpRequests.length === 1
      ? sha256(JSON.stringify(splitCreateHttpRequests[0])) : null,
    httpRequestNodeIds: allHttpRequests.map((node) => node.id).sort(),
    httpRequestInboundEdges: actualHttpInboundEdges,
    mongoCredentialStoreVerifiedEmpty,
    mongoCredentialStorePreimageSha256,
    mongoBindingVerifiedDevOnly,
    crossEnvironmentMongoConfigCount:
      crossEnvironmentLegacyMongoConfigs.length + crossEnvironmentMongo4Clients.length,
    legacyMongoConfigPreimages: legacyMongoConfigs.map((node) => ({
      id: node.id,
      sha256: sha256(JSON.stringify(node)),
    })),
    mongodb4ClientPreimages: mongo4Clients.map((node) => ({
      id: node.id,
      sha256: sha256(JSON.stringify(node)),
    })),
    managedMongoClient: managedMongoClient.length === 1 ? {
      id: managedMongoClient[0].id,
      preimageSha256: sha256(JSON.stringify(managedMongoClient[0])),
      effectiveIdentity: managedMongoIdentity,
      fixtureOnly: fixtureOnlyMongoIdentity(managedMongoIdentity),
    } : null,
    managedMongoNodes,
  },
  endpointAudit: {
    verifiedDevOnly: crossEnvironmentEndpoints.length === 0,
    crossEnvironmentEndpointCount: crossEnvironmentEndpoints.length,
    endpointInventorySha256: sha256(JSON.stringify(endpointInventory)),
  },
  environmentIdentityVerified: false,
};
fs.writeFileSync(metaPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`sourceSha256=${audit.sourceSha256}\n`);
process.stdout.write(`targetPresent=${audit.target.present}\n`);
process.stdout.write(`crossEnvironmentMongoConfigCount=${audit.dependencies.crossEnvironmentMongoConfigCount}\n`);
process.stdout.write(`crossEnvironmentEndpointCount=${audit.endpointAudit.crossEnvironmentEndpointCount}\n`);
