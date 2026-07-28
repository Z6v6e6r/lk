import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const basePath = getArg('--base');
const patchedPath = getArg('--patched');
const outPath = getArg('--out');
const manifestPath = getArg('--manifest');
if (!basePath || !patchedPath || !outPath || !manifestPath) {
  throw new Error('Usage: node scripts/build_rating_rollout_flow.mjs --base live.json --patched source.flow.json --out rollout.json --manifest manifest.json');
}

const readFlow = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const baseFlow = readFlow(basePath);
const patchedFlow = readFlow(patchedPath);
const baseById = new Map(baseFlow.map((node) => [node.id, node]));
const patchedById = new Map(patchedFlow.map((node) => [node.id, node]));
const replacementSpecs = [
  { id: '4ba07d3d50014066', fromId: '4ba07d3d50014066', fields: ['func'] },
  { id: 'c67e08684d1e4fe9', fromId: 'c67e08684d1e4fe9', fields: ['func'] },
  { id: 'cb002a5dcea9ce51', fromId: 'result_confirm_route_after_cas_002', fields: ['func'] },
  { id: 'cbc3af09f9e929f4', fromId: 'cbc3af09f9e929f4', fields: ['func', 'wires'] },
  { id: '1dd46edba0d97ab8', fromId: '1dd46edba0d97ab8', fields: ['func'] },
  { id: '127cf4d595cc30bc', fromId: '127cf4d595cc30bc', fields: ['wires'] },
  { id: 'c831f19741603796', fromId: 'c831f19741603796', fields: ['func'] },
  { id: 'c31e652a121e5b41', fromId: 'c31e652a121e5b41', fields: ['func'] },
  { id: '9793d68822613891', fromId: '9793d68822613891', fields: ['wires'] },
  { id: '14601d3a912ff692', fromId: '14601d3a912ff692', fields: ['func'] },
];
const addedSpecs = [
  {
    id: 'result_rating_ledger_append_001',
    mutate: (node) => Object.assign(node, {
      z: baseById.get('127cf4d595cc30bc').z,
      clientNode: baseById.get('127cf4d595cc30bc').clientNode,
      wires: [['1dd46edba0d97ab8']],
    }),
  },
  {
    id: 'result_rating_ledger_projection_001',
    mutate: (node) => Object.assign(node, {
      z: baseById.get('127cf4d595cc30bc').z,
      wires: [['6c5512b06d079e30', '0dafa71f5e7361d2']],
    }),
  },
  {
    id: 'onboarding_level_capture_viva_result_001',
    mutate: (node) => Object.assign(node, {
      z: baseById.get('9793d68822613891').z,
      wires: [['83cdc134bc890c26']],
    }),
  },
];

for (const spec of replacementSpecs) {
  if (!baseById.has(spec.id)) throw new Error(`Live base node missing: ${spec.id}`);
  if (!patchedById.has(spec.fromId)) throw new Error(`Patched source node missing: ${spec.fromId}`);
}
for (const spec of addedSpecs) {
  if (baseById.has(spec.id)) throw new Error(`Add-only node already exists in live base: ${spec.id}`);
  if (!patchedById.has(spec.id)) throw new Error(`Patched add node missing: ${spec.id}`);
}

const replacementById = new Map(replacementSpecs.map((spec) => [spec.id, spec]));
const result = baseFlow.map((node) => {
  const spec = replacementById.get(node.id);
  if (!spec) return node;
  const next = JSON.parse(JSON.stringify(node));
  const source = patchedById.get(spec.fromId);
  for (const field of spec.fields) next[field] = JSON.parse(JSON.stringify(source[field]));
  return next;
});
const resultIds = new Set(result.map((node) => node.id));
for (const spec of addedSpecs) {
  const node = JSON.parse(JSON.stringify(patchedById.get(spec.id)));
  result.push(spec.mutate(node));
  resultIds.add(spec.id);
}
if (resultIds.size !== result.length) throw new Error('Duplicate node ids in focused rollout flow');

const missingWires = [];
for (const node of result) {
  for (const group of node.wires || []) {
    for (const target of group) {
      if (!resultIds.has(target)) missingWires.push({ nodeId: node.id, target });
    }
  }
}
if (missingWires.length > 0) throw new Error(`Focused rollout has missing wires: ${JSON.stringify(missingWires.slice(0, 10))}`);

const activeResultWrite = result.find((node) => node.id === '369f559dc4665319');
if (activeResultWrite?.wires?.[0]?.[0] !== 'cb002a5dcea9ce51') {
  throw new Error('Active result CAS route does not point to the live route node');
}
const eventWriter = result.find((node) => node.id === 'result_rating_ledger_append_001');
if (eventWriter?.collection !== 'rating_events') throw new Error('rating_events writer missing');
const playerStateWriter = result.find((node) => node.id === '127cf4d595cc30bc');
if (playerStateWriter?.wires?.[0]?.[0] !== 'result_rating_ledger_projection_001') {
  throw new Error('Viva projection is not ordered after player_ratings write');
}
const vivaPut = result.find((node) => node.id === '9793d68822613891');
if (vivaPut?.wires?.[0]?.[0] !== 'onboarding_level_capture_viva_result_001') {
  throw new Error('Truthful Viva PUT capture is not wired');
}

const absoluteOut = path.resolve(outPath);
const absoluteManifest = path.resolve(manifestPath);
fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
fs.mkdirSync(path.dirname(absoluteManifest), { recursive: true });
fs.writeFileSync(absoluteOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifest = {
  generatedAt: new Date().toISOString(),
  base: path.resolve(basePath),
  patched: path.resolve(patchedPath),
  output: absoluteOut,
  baseNodeCount: baseFlow.length,
  outputNodeCount: result.length,
  selectedNodes: [
    ...replacementSpecs.map((spec) => {
      const after = result.find((node) => node.id === spec.id);
      return {
        id: spec.id,
        action: 'replace',
        fields: spec.fields,
        name: after?.name || null,
        beforeSha256: digest(baseById.get(spec.id)),
        afterSha256: digest(after),
      };
    }),
    ...addedSpecs.map((spec) => {
      const after = result.find((node) => node.id === spec.id);
      return {
        id: spec.id,
        action: 'add',
        fields: null,
        name: after?.name || null,
        beforeSha256: null,
        afterSha256: digest(after),
      };
    }),
  ],
  checks: {
    uniqueNodeIds: true,
    allWireTargetsExist: true,
    eventBeforeStateBeforeViva: true,
    truthfulVivaPutStatus: true,
  },
};
fs.writeFileSync(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output: absoluteOut,
  manifest: absoluteManifest,
  baseNodeCount: baseFlow.length,
  outputNodeCount: result.length,
  added: manifest.selectedNodes.filter((item) => item.action === 'add').length,
  replaced: manifest.selectedNodes.filter((item) => item.action === 'replace').length,
  checks: manifest.checks,
}, null, 2));
