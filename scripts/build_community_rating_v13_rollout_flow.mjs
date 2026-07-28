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
  throw new Error(
    "Usage: node scripts/build_community_rating_v13_rollout_flow.mjs --base live.json --out rollout.json --manifest manifest.json",
  );
}

const absoluteBase = path.resolve(basePath);
const absoluteOut = path.resolve(outPath);
const absoluteManifest = path.resolve(manifestPath);
const baseRaw = fs.readFileSync(absoluteBase);
const baseFlow = JSON.parse(baseRaw.toString("utf8"));
const flow = JSON.parse(baseRaw.toString("utf8"));
const byId = new Map(flow.map((node) => [node.id, node]));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const digestNode = (node) => digest(JSON.stringify(node));
const selected = [];

const targetNodes = [
  { id: "d76eb463cd34bdef", name: "Build ranking query" },
  { id: "c33fafb4f5484966", name: "Use rating snapshot or fallback" },
];

targetNodes.forEach(({ id, name }) => {
  const node = byId.get(id);
  if (!node) throw new Error(`Live node missing: ${id}`);
  if (node.name !== name) throw new Error(`Unexpected live node name for ${id}: ${node.name}`);
  const before = JSON.parse(JSON.stringify(node));
  const source = String(node.func || "");
  const markers = source.match(/community-rating-v1\.2\.0/g) || [];
  if (markers.length !== 1) {
    throw new Error(`Expected exactly one v1.2 marker in ${id}, found ${markers.length}`);
  }
  if (source.includes("community-rating-v1.3.0")) {
    throw new Error(`Node ${id} already contains a v1.3 marker`);
  }
  const weightReplacements = [
    ["(toNum(gamesNormalized) || 0) * 0.55", "(toNum(gamesNormalized) || 0) * 0.2"],
    ["(toNum(tournamentNormalized) || 0) * 0.35", "(toNum(tournamentNormalized) || 0) * 0.6"],
    ["(toNum(activityScore) || 0) * 0.1", "(toNum(activityScore) || 0) * 0.2"],
  ];
  let nextSource = source.replace("community-rating-v1.2.0", "community-rating-v1.3.0");
  weightReplacements.forEach(([beforeWeight, afterWeight]) => {
    const occurrences = nextSource.split(beforeWeight).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one ${beforeWeight} marker in ${id}, found ${occurrences}`);
    }
    nextSource = nextSource.replace(beforeWeight, afterWeight);
  });
  node.func = nextSource;
  selected.push({
    id,
    name,
    beforeSha256: digestNode(before),
    afterSha256: digestNode(node),
  });
});

const changedNodeIds = flow
  .filter((node, index) => digestNode(node) !== digestNode(baseFlow[index]))
  .map((node) => node.id)
  .sort();
const expectedIds = targetNodes.map((node) => node.id).sort();
if (JSON.stringify(changedNodeIds) !== JSON.stringify(expectedIds)) {
  throw new Error(`Unexpected changed nodes: ${JSON.stringify(changedNodeIds)}`);
}
if (new Set(flow.map((node) => node.id)).size !== flow.length) {
  throw new Error("Duplicate node ids");
}

fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
fs.mkdirSync(path.dirname(absoluteManifest), { recursive: true });
fs.writeFileSync(absoluteOut, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
const outputRaw = fs.readFileSync(absoluteOut);
const manifest = {
  generatedAt: new Date().toISOString(),
  base: absoluteBase,
  output: absoluteOut,
  nodeCount: flow.length,
  baseSha256: digest(baseRaw),
  outputSha256: digest(outputRaw),
  selectedNodes: selected,
  checks: {
    exactTargetNodesChanged: true,
    uniqueNodeIds: true,
    calculationVersion: "community-rating-v1.3.0",
    overallWeights: { games: 0.2, tournaments: 0.6, activity: 0.2 },
  },
};
fs.writeFileSync(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
