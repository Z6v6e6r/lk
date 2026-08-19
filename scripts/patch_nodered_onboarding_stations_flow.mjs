import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;

if (!sourcePath || !outputPath) {
  throw new Error(
    'Usage: node scripts/patch_nodered_onboarding_stations_flow.mjs <fresh-live-flow.json> <candidate-flow.json>',
  );
}
if (sourcePath === outputPath) {
  throw new Error('Candidate output must differ from the fresh live source path');
}

const flow = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
if (!Array.isArray(flow)) {
  throw new Error(`Node-RED flow must be an array: ${sourcePath}`);
}

const routeNodes = flow.filter(
  (node) => node?.type === 'http in' && String(node.url || '').trim() === '/lk/onboarding/stations',
);
if (routeNodes.length !== 1) {
  throw new Error(`Expected exactly one /lk/onboarding/stations route, found ${routeNodes.length}`);
}

const routeNode = routeNodes[0];
const directlyWiredIds = new Set(
  (Array.isArray(routeNode.wires) ? routeNode.wires : [])
    .flatMap((group) => (Array.isArray(group) ? group : []))
    .filter(Boolean),
);
const functionNodes = flow.filter(
  (node) => node?.type === 'function' && directlyWiredIds.has(node.id),
);
if (functionNodes.length !== 1) {
  throw new Error(
    `Expected exactly one function directly wired from /lk/onboarding/stations, found ${functionNodes.length}`,
  );
}

const functionSourcePath = path.resolve(
  process.cwd(),
  'scripts/nodered_onboarding_nodes/fn_onboarding_stations.js',
);
const functionSource = fs.readFileSync(functionSourcePath, 'utf8');
functionNodes[0].func = functionSource;

fs.writeFileSync(outputPath, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true,
  sourcePath,
  outputPath,
  routeNodeId: routeNode.id,
  functionNodeId: functionNodes[0].id,
  nodesCount: flow.length,
}));
