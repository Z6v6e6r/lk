#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";

const [sourcePath, metaPath] = process.argv.slice(2);
if (!sourcePath || !metaPath) throw new Error("Usage: inspect_lk1_subscription_dev_snapshot.mjs <source> <metadata>");
const raw = fs.readFileSync(sourcePath);
const flow = JSON.parse(raw.toString("utf8"));
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
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
  splitRouterNodeId: "8f7bd5b482fe9763",
  splitRouterNodeName: "Route Viva split payment",
};
const targetNode = (id) => flow.filter((node) => node?.id === id);
const semanticCount = (name) => flow.filter((node) => (
  node?.type === "function"
  && node.name === name
  && tabs.get(node.z)?.label === targetSpec.tabLabel
  && tabs.get(node.z)?.disabled !== true
)).length;
const router = targetNode(targetSpec.routerNodeId);
const splitRouter = targetNode(targetSpec.splitRouterNodeId);
const mongoConfigs = flow.filter((node) => node?.type === "mongodb");
const crossEnvironmentMongoConfigs = mongoConfigs.filter((node) => {
  const host = String(node.hostname || node.url || node.uri || "").toLowerCase();
  return host && !/(^|\/\/)(127\.0\.0\.1|localhost)([:/]|$)/.test(host);
});
const targetPresent = router.length === 1 && splitRouter.length === 1;

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
      semanticCount(targetSpec.splitRouterNodeName),
    ),
    routerPreimageSha256: router.length === 1 ? sha256(String(router[0].func || "")) : null,
    splitRouterPreimageSha256: splitRouter.length === 1 ? sha256(String(splitRouter[0].func || "")) : null,
  },
  dependencies: {
    httpRequestBindingVerified: false,
    // Snapshot shape alone cannot prove effective DB custody, even for loopback.
    mongoBindingVerifiedDevOnly: false,
    crossEnvironmentMongoConfigCount: crossEnvironmentMongoConfigs.length,
    mongoConfigPreimages: mongoConfigs.map((node) => ({ id: node.id, sha256: sha256(JSON.stringify(node)) })),
  },
  environmentIdentityVerified: false,
};
fs.writeFileSync(metaPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`sourceSha256=${audit.sourceSha256}\n`);
process.stdout.write(`targetPresent=${audit.target.present}\n`);
process.stdout.write(`crossEnvironmentMongoConfigCount=${audit.dependencies.crossEnvironmentMongoConfigCount}\n`);
