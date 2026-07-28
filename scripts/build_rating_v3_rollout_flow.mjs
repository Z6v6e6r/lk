import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const basePath = getArg("--base");
const outPath = getArg("--out");
const manifestPath = getArg("--manifest");
if (!basePath || !outPath || !manifestPath) {
  throw new Error("Usage: node scripts/build_rating_v3_rollout_flow.mjs --base live.json --out rollout.json --manifest manifest.json");
}

const rootDir = process.cwd();
const flow = JSON.parse(fs.readFileSync(path.resolve(basePath), "utf8"));
const onboardingTab = flow.find((node) => node?.type === "tab" && node?.label === "LK Onboarding");
if (!onboardingTab?.id) throw new Error("Live LK Onboarding tab not found");
const buildUpdates = flow.find((node) => (
  node?.z === onboardingTab.id
  && node?.type === "function"
  && node?.name === "Build updates array"
));
if (!buildUpdates) throw new Error("Live Build updates array node not found");

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const before = JSON.parse(JSON.stringify(buildUpdates));
buildUpdates.func = fs.readFileSync(
  path.join(rootDir, "scripts/nodered_onboarding_nodes/fn_onboarding_level_build_updates.js"),
  "utf8",
);
if (!buildUpdates.func.includes("NUM_FIELD_ID") || buildUpdates.func.includes("f9790818")) {
  throw new Error("Numeric-only Viva field projection was not applied");
}

const ids = new Set(flow.map((node) => node.id));
if (ids.size !== flow.length) throw new Error("Duplicate node ids in rollout flow");
const missingWires = [];
for (const node of flow) {
  for (const wireGroup of node.wires || []) {
    for (const target of wireGroup) if (!ids.has(target)) missingWires.push({ nodeId: node.id, target });
  }
}
if (missingWires.length > 0) throw new Error(`Missing wire targets: ${JSON.stringify(missingWires.slice(0, 10))}`);

const absoluteOut = path.resolve(outPath);
const absoluteManifest = path.resolve(manifestPath);
fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
fs.mkdirSync(path.dirname(absoluteManifest), { recursive: true });
fs.writeFileSync(absoluteOut, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
const manifest = {
  generatedAt: new Date().toISOString(),
  base: path.resolve(basePath),
  output: absoluteOut,
  baseNodeCount: flow.length,
  outputNodeCount: flow.length,
  selectedNodes: [{
    id: buildUpdates.id,
    action: "replace",
    name: buildUpdates.name,
    fields: ["func"],
    beforeSha256: digest(before),
    afterSha256: digest(buildUpdates),
  }],
  checks: {
    uniqueNodeIds: true,
    allWireTargetsExist: true,
    numericOnlyVivaProjection: true,
  },
  outputSha256: crypto.createHash("sha256").update(fs.readFileSync(absoluteOut)).digest("hex"),
};
fs.writeFileSync(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
