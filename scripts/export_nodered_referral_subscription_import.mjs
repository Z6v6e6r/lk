import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_FLOW_PATH = path.resolve(
  ROOT,
  process.env.NODERED_SOURCE_PATH || "node-red/modular/source.flow.json",
);
const OUTPUT_IMPORT_PATH = path.resolve(
  ROOT,
  process.env.NODERED_REFERRAL_IMPORT_PATH
    || "node-red/modular/imports/lk_referral_subscription.import.json",
);

const ID_MAP = {
  f6a7b8c9d0e64001: "b7c8d9e0f1a26001",
  f6a7b8c9d0e64002: "b7c8d9e0f1a26002",
  mongo4_adapt_f6a7b8c9d0e64003: "mongo4_adapt_b7c8d9e0f1a26003",
  f6a7b8c9d0e64003: "b7c8d9e0f1a26003",
  f6a7b8c9d0e64004: "b7c8d9e0f1a26004",
  f6a7b8c9d0e64005: "b7c8d9e0f1a26005",
  f6a7b8c9d0e64006: "b7c8d9e0f1a26006",
  f6a7b8c9d0e64101: "b7c8d9e0f1a26101",
  f6a7b8c9d0e64102: "b7c8d9e0f1a26102",
  f6a7b8c9d0e64103: "b7c8d9e0f1a26103",
  f6a7b8c9d0e64104: "b7c8d9e0f1a26104",
  f6a7b8c9d0e64105: "b7c8d9e0f1a26105",
  f6a7b8c9d0e64106: "b7c8d9e0f1a26106",
  f6a7b8c9d0e64107: "b7c8d9e0f1a26107",
  f6a7b8c9d0e64108: "b7c8d9e0f1a26108",
  f6a7b8c9d0e64109: "b7c8d9e0f1a26109",
  f6a7b8c9d0e64201: "b7c8d9e0f1a26201",
  f6a7b8c9d0e64202: "b7c8d9e0f1a26202",
  f6a7b8c9d0e64203: "b7c8d9e0f1a26203",
  f6a7b8c9d0e64204: "b7c8d9e0f1a26204",
  f6a7b8c9d0e64212: "b7c8d9e0f1a26212",
  f6a7b8c9d0e64205: "b7c8d9e0f1a26205",
  f6a7b8c9d0e64206: "b7c8d9e0f1a26206",
  f6a7b8c9d0e64207: "b7c8d9e0f1a26207",
  f6a7b8c9d0e64208: "b7c8d9e0f1a26208",
  mongo4_adapt_f6a7b8c9d0e64209: "mongo4_adapt_b7c8d9e0f1a26209",
  f6a7b8c9d0e64209: "b7c8d9e0f1a26209",
  f6a7b8c9d0e64210: "b7c8d9e0f1a26210",
  f6a7b8c9d0e64211: "b7c8d9e0f1a26211",
  f6a7b8c9d0e64301: "b7c8d9e0f1a26301",
  f6a7b8c9d0e64302: "b7c8d9e0f1a26302",
  f6a7b8c9d0e64303: "b7c8d9e0f1a26303",
  f6a7b8c9d0e64304: "b7c8d9e0f1a26304",
  f6a7b8c9d0e64305: "b7c8d9e0f1a26305",
  mongo4_adapt_f6a7b8c9d0e64306: "mongo4_adapt_b7c8d9e0f1a26306",
  f6a7b8c9d0e64306: "b7c8d9e0f1a26306",
  f6a7b8c9d0e64307: "b7c8d9e0f1a26307",
  f6a7b8c9d0e64308: "b7c8d9e0f1a26308",
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function remapNode(node, sourceTabId) {
  const next = clone(node);
  next.id = ID_MAP[node.id];
  if (next.z) {
    next.z = sourceTabId;
  }
  if (Array.isArray(next.wires)) {
    next.wires = next.wires.map((output) => (
      Array.isArray(output)
        ? output.map((targetId) => ID_MAP[targetId] || targetId)
        : output
    ));
  }
  if (Array.isArray(next.links)) {
    next.links = next.links.map((targetId) => ID_MAP[targetId] || targetId);
  }
  return next;
}

function resolveSourceTab(flow, sourceNodes) {
  const sourceTabIds = new Set(sourceNodes.map((node) => node.z).filter(Boolean));
  if (sourceTabIds.size !== 1) {
    throw new Error(`Expected one referral source tab, found ${sourceTabIds.size}`);
  }

  const [sourceTabId] = sourceTabIds;
  const sourceTab = flow.find((node) => (
    node.id === sourceTabId
    && node.type === "tab"
    && node.label === "LK Referral Subscriptions"
    && node.disabled !== true
  ));
  if (!sourceTab) {
    throw new Error(`Enabled LK Referral Subscriptions tab not found: ${sourceTabId}`);
  }

  return { sourceTabId, sourceTab };
}

function resolveSourceConfigId(flow, sourceNodes) {
  const referencedClientIds = new Set(
    sourceNodes
      .filter((node) => node.type === "mongodb4" && node.clientNode)
      .map((node) => node.clientNode),
  );

  if (referencedClientIds.size !== 1) {
    throw new Error(
      `Expected one referral Mongo config reference, found ${referencedClientIds.size}`,
    );
  }

  const [sourceConfigId] = referencedClientIds;
  const sourceConfig = flow.find(
    (node) => node.id === sourceConfigId && node.type === "mongodb4-client",
  );
  if (!sourceConfig) {
    throw new Error(`Mongo config node not found: ${sourceConfigId}`);
  }

  return { sourceConfigId, sourceConfig };
}

function validateImportFlow(importFlow, sourceTabId, sourceConfigId) {
  const ids = new Set();
  for (const node of importFlow) {
    if (ids.has(node.id)) throw new Error(`Duplicate referral import node id: ${node.id}`);
    ids.add(node.id);
  }

  const tabs = importFlow.filter((node) => node.type === "tab");
  if (tabs.length !== 1 || tabs[0].id !== sourceTabId) {
    throw new Error("Referral replacement import must preserve the active source tab id");
  }
  if (importFlow.some((node) => node.type === "mongodb4-client")) {
    throw new Error("Referral replacement import must not embed Mongo config or credentials");
  }
  const wrongMongoRefs = importFlow.filter((node) => (
    node.type === "mongodb4" && node.clientNode !== sourceConfigId
  ));
  if (wrongMongoRefs.length > 0) {
    throw new Error("Referral replacement import uses an unexpected Mongo config reference");
  }

  for (const node of importFlow) {
    for (const output of node.wires || []) {
      for (const targetId of output || []) {
        if (!ids.has(targetId)) {
          throw new Error(`Referral import node ${node.id} has dangling wire to ${targetId}`);
        }
      }
    }
  }

  const purchasePrepare = importFlow.find(
    (node) => node.name === "Prepare referral subscription purchase",
  );
  const purchaseLookup = importFlow.find(
    (node) => node.name === "Find referral subscription invite for purchase",
  );
  const purchaseOwnerResolve = importFlow.find(
    (node) => node.name === "Resolve referral subscription owner purchase",
  );
  if (!purchasePrepare || !purchaseLookup || !purchaseOwnerResolve) {
    throw new Error("Referral import purchase invite path is incomplete");
  }
  if (JSON.stringify(purchasePrepare.wires?.[3]) !== JSON.stringify([purchaseLookup.id])) {
    throw new Error("Referral import purchase output 4 is not wired to invite lookup");
  }
  if (JSON.stringify(purchaseLookup.wires?.[0]) !== JSON.stringify([purchaseOwnerResolve.id])) {
    throw new Error("Referral import purchase lookup is not wired to owner resolver");
  }
}

function main() {
  const flow = readJson(SOURCE_FLOW_PATH);
  if (!Array.isArray(flow)) {
    throw new Error("source.flow.json must contain an array");
  }

  const sourceNodes = flow.filter((node) => Object.prototype.hasOwnProperty.call(ID_MAP, node.id));
  if (sourceNodes.length !== Object.keys(ID_MAP).length) {
    throw new Error(`Expected ${Object.keys(ID_MAP).length} referral nodes, found ${sourceNodes.length}`);
  }

  const { sourceTabId, sourceTab } = resolveSourceTab(flow, sourceNodes);
  const { sourceConfigId } = resolveSourceConfigId(flow, sourceNodes);

  const importFlow = [
    clone(sourceTab),
    ...sourceNodes.map((node) => remapNode(node, sourceTabId)),
  ];

  validateImportFlow(importFlow, sourceTabId, sourceConfigId);
  writeJson(OUTPUT_IMPORT_PATH, importFlow);
  console.log(`Wrote ${OUTPUT_IMPORT_PATH}`);
}

main();
