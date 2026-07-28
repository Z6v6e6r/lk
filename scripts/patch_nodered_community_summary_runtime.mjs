import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [sourcePathRaw, canonicalPathRaw, outputPathRaw] = process.argv.slice(2);

if (!sourcePathRaw || !canonicalPathRaw || !outputPathRaw) {
  console.error(
    'Usage: node scripts/patch_nodered_community_summary_runtime.mjs '
    + '<live-flow.json> <canonical-community-import.json> <output-flow.json>',
  );
  process.exit(1);
}

const sourcePath = path.resolve(sourcePathRaw);
const canonicalPath = path.resolve(canonicalPathRaw);
const outputPath = path.resolve(outputPathRaw);
const sourceFlow = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const canonicalFlow = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

if (!Array.isArray(sourceFlow) || !Array.isArray(canonicalFlow)) {
  throw new Error('Both flow files must contain Node-RED node arrays');
}

const enabledCommunityTabs = sourceFlow.filter(
  (node) => node?.type === 'tab'
    && node?.label === 'LK Communities'
    && node?.disabled !== true,
);
if (enabledCommunityTabs.length !== 1) {
  throw new Error(`Expected one enabled LK Communities tab, found ${enabledCommunityTabs.length}`);
}

const communityTabId = enabledCommunityTabs[0].id;
const findSingleFunction = (flow, predicate, description) => {
  const matches = flow.filter((node) => node?.type === 'function' && predicate(node));
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description}, found ${matches.length}`);
  }
  return matches[0];
};

const livePrepare = findSingleFunction(
  sourceFlow,
  (node) => node.z === communityTabId && node.name === 'Prepare communities list query',
  'live communities list prepare function',
);
const liveResponse = findSingleFunction(
  sourceFlow,
  (node) => node.z === communityTabId && node.name === 'Build communities list response',
  'live communities list response function',
);
const canonicalPrepare = findSingleFunction(
  canonicalFlow,
  (node) => node.id === 'community_list_fn_prepare_001',
  'canonical communities list prepare function',
);
const canonicalResponse = findSingleFunction(
  canonicalFlow,
  (node) => node.id === 'community_list_fn_response_001',
  'canonical communities list response function',
);

const replaceTail = (liveSource, canonicalSource, marker, description) => {
  const liveIndex = String(liveSource || '').indexOf(marker);
  const canonicalIndex = String(canonicalSource || '').indexOf(marker);
  if (liveIndex < 0 || canonicalIndex < 0) {
    throw new Error(`Cannot locate ${description} marker in live/canonical function`);
  }
  return `${liveSource.slice(0, liveIndex)}${canonicalSource.slice(canonicalIndex)}`;
};

const patchedPrepareFunc = replaceTail(
  livePrepare.func,
  canonicalPrepare.func,
  'const listMode =',
  'communities list prepare',
);
const patchedResponseFunc = replaceTail(
  liveResponse.func,
  canonicalResponse.func,
  'const ctx =',
  'communities list response',
);

if (!patchedPrepareFunc.includes('msg.projection = summaryProjection;')) {
  throw new Error('Patched prepare function does not set msg.projection');
}
if (!patchedResponseFunc.includes('connections: isSummaryMode ? [] : buildConnections(scopedRows)')) {
  throw new Error('Patched response function still builds summary connections');
}

const patchedFlow = sourceFlow.map((node) => {
  if (node?.id === livePrepare.id) return { ...node, func: patchedPrepareFunc };
  if (node?.id === liveResponse.id) return { ...node, func: patchedResponseFunc };
  return node;
});

const sourceById = new Map(sourceFlow.filter((node) => node?.id).map((node) => [node.id, node]));
const patchedById = new Map(patchedFlow.filter((node) => node?.id).map((node) => [node.id, node]));
if (sourceById.size !== patchedById.size || sourceFlow.length !== patchedFlow.length) {
  throw new Error('Node count or node id cardinality changed');
}

const changedNodeIds = [];
for (const [nodeId, sourceNode] of sourceById) {
  const patchedNode = patchedById.get(nodeId);
  if (!patchedNode) throw new Error(`Missing node after patch: ${nodeId}`);
  if (JSON.stringify(sourceNode) === JSON.stringify(patchedNode)) continue;
  const sourceWithoutFunc = { ...sourceNode };
  const patchedWithoutFunc = { ...patchedNode };
  delete sourceWithoutFunc.func;
  delete patchedWithoutFunc.func;
  if (JSON.stringify(sourceWithoutFunc) !== JSON.stringify(patchedWithoutFunc)) {
    throw new Error(`Patch changed fields other than func for node ${nodeId}`);
  }
  changedNodeIds.push(nodeId);
}

const expectedChangedIds = [livePrepare.id, liveResponse.id].sort();
if (JSON.stringify(changedNodeIds.sort()) !== JSON.stringify(expectedChangedIds)) {
  throw new Error(`Unexpected changed nodes: ${changedNodeIds.join(', ')}`);
}

const collectEndpoints = (flow) => flow
  .filter((node) => node?.type === 'http in')
  .map((node) => `${String(node.method || '').toUpperCase()} ${node.url}`)
  .sort();
if (JSON.stringify(collectEndpoints(sourceFlow)) !== JSON.stringify(collectEndpoints(patchedFlow))) {
  throw new Error('HTTP endpoint set changed');
}

const prepareSmokeMsg = { req: { query: { view: 'summary' } } };
new Function('msg', patchedPrepareFunc)(prepareSmokeMsg);
if (
  !prepareSmokeMsg.projection
  || prepareSmokeMsg.projection.members !== undefined
  || prepareSmokeMsg.payload?.archived?.$ne !== true
) {
  throw new Error('Summary prepare runtime smoke-check failed');
}

const responseSmokeMsg = {
  req: { query: { view: 'summary' }, headers: {} },
  _communityList: { listMode: 'SUMMARY', clientId: null, phone: null },
  payload: [],
};
new Function('msg', patchedResponseFunc)(responseSmokeMsg);
if (!Array.isArray(responseSmokeMsg.payload?.connections) || responseSmokeMsg.payload.connections.length !== 0) {
  throw new Error('Summary response runtime smoke-check failed');
}

fs.writeFileSync(outputPath, `${JSON.stringify(patchedFlow, null, 2)}\n`);

const sha256 = (filePath) => crypto
  .createHash('sha256')
  .update(fs.readFileSync(filePath))
  .digest('hex');

console.log(JSON.stringify({
  sourcePath,
  sourceSha256: sha256(sourcePath),
  canonicalPath,
  outputPath,
  outputSha256: sha256(outputPath),
  communityTabId,
  changedNodeIds: expectedChangedIds,
  nodeCount: patchedFlow.length,
  endpointCount: collectEndpoints(patchedFlow).length,
}, null, 2));
