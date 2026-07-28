import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = process.env.NODERED_REPO_ROOT
  ? path.resolve(process.env.NODERED_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = process.env.NODERED_SOURCE_PATH
  ? path.resolve(process.env.NODERED_SOURCE_PATH)
  : path.join(rootDir, 'node-red/modular/source.flow.json');
const fnDir = path.join(rootDir, 'scripts/nodered_onboarding_nodes');
const readFn = (name) => fs.readFileSync(path.join(fnDir, name), 'utf8');

const flow = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const byId = new Map(flow.map((node) => [node.id, node]));
const tab = flow.find((node) => node.type === 'tab' && node.label === 'LK Onboarding');
if (!tab?.id) throw new Error('LK Onboarding tab not found');
const findNode = (predicate, label) => {
  const node = flow.find((item) => item.z === tab.id && predicate(item));
  if (!node) throw new Error(`Onboarding node not found: ${label}`);
  return node;
};
const ensureNode = (node) => {
  const existing = byId.get(node.id);
  if (existing) Object.assign(existing, node);
  else {
    flow.push(node);
    byId.set(node.id, node);
  }
  return byId.get(node.id);
};

const validate = findNode((node) => node.type === 'function' && node.name === 'Validate + normalize', 'Validate + normalize');
const buildUpdates = findNode((node) => node.type === 'function' && node.name === 'Build updates array', 'Build updates array');
const buildPut = findNode((node) => node.type === 'function' && node.name === 'Build PUT custom field', 'Build PUT custom field');
const putRequest = findNode((node) => node.type === 'http request' && node.name === 'PUT custom field', 'PUT custom field');
const joinResults = findNode((node) => node.type === 'join' && node.name === 'Join results', 'Join results');
const buildResponse = findNode((node) => node.type === 'function' && node.name === 'Build response + log', 'Build response + log');

validate.func = readFn('fn_onboarding_level_validate.js');
buildUpdates.func = readFn('fn_onboarding_level_build_updates.js');
buildPut.func = readFn('fn_onboarding_level_build_viva_put.js');
buildResponse.func = readFn('fn_onboarding_level_build_response.js');
const capture = ensureNode({
  id: 'onboarding_level_capture_viva_result_001',
  type: 'function',
  z: tab.id,
  name: 'Capture Viva level PUT result',
  func: readFn('fn_onboarding_level_capture_viva_result.js'),
  outputs: 1,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: Number(putRequest.x || 1690) + 210,
  y: Number(putRequest.y || 160),
  wires: [[joinResults.id]],
});
putRequest.wires = [[capture.id]];

fs.writeFileSync(sourcePath, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
console.log(`Patched truthful onboarding rating projection in ${sourcePath}`);
