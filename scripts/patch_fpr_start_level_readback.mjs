import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PADLHUB_VIVA_USER_AGENT } from './lib/vivaUserAgent.mjs';

const PUT = '9793d68822613891';
const CAPTURE = 'onboarding_level_capture_viva_result_001';
const JOIN = '83cdc134bc890c26';
const RESPONSE = '14601d3a912ff692';
const PREPARE = 'fpr_start_level_readback_prepare_001';
const PROFILE = 'fpr_start_level_readback_profile_001';
const AUTHORIZE = 'fpr_start_level_readback_authorize_001';
const REQUEST = 'fpr_start_level_readback_http_001';
const RESULT = 'fpr_start_level_readback_result_001';
const readFunction = name => fs.readFileSync(
  new URL(`./nodered_onboarding_nodes/${name}.js`, import.meta.url), 'utf8',
);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function patchFprStartLevelReadback(source, sourceSha256) {
  assert.equal(sha256(source), sourceSha256, 'Flow source hash mismatch');
  const flow = JSON.parse(source);
  const byId = new Map(flow.map(node => [node.id, node]));
  assert.equal(byId.size, flow.length, 'Duplicate flow node IDs');
  const put = byId.get(PUT);
  const capture = byId.get(CAPTURE);
  const join = byId.get(JOIN);
  const response = byId.get(RESPONSE);
  assert.equal(put?.type, 'http request', 'Viva PUT node missing');
  assert.equal(put.method, 'use');
  assert.equal(put.ret, 'obj');
  assert.deepEqual(put.wires, [[CAPTURE]]);
  assert.equal(capture?.type, 'function');
  assert.equal(capture.z, put.z);
  assert.equal(capture.outputs, 1);
  assert.equal(capture.func, readFunction('fn_onboarding_level_capture_viva_result'), 'Viva PUT capture changed');
  assert.deepEqual(capture.wires, [[JOIN]]);
  assert.equal(join?.type, 'join');
  assert.equal(join.z, put.z);
  assert.equal(join.mode, 'auto');
  assert.deepEqual(join.wires, [[RESPONSE]]);
  assert.equal(response?.func, readFunction('fn_onboarding_level_build_response'), 'Onboarding response changed');
  assert.equal(response.z, put.z);

  const added = [PREPARE, PROFILE, AUTHORIZE, REQUEST, RESULT];
  for (const id of added) assert(!byId.has(id), `Readback node already exists: ${id}`);
  capture.wires = [[PREPARE]];
  const functionNode = (id, name, file, wires, x, y) => ({
    id, z: put.z, type: 'function', name, func: readFunction(file),
    outputs: wires.length, timeout: '', noerr: 0, initialize: '', finalize: '', libs: [], x, y, wires,
  });
  const httpGet = (id, name, next, x, y) => ({
    id, z: put.z, type: 'http request', name, method: 'GET', ret: 'obj', paytoqs: 'ignore',
    // The HTTP node sends transport failures on its output when senderr is false.
    url: '', senderr: false,
    headers: [{ keyType: 'other', keyValue: 'User-Agent', valueType: 'other', valueValue: PADLHUB_VIVA_USER_AGENT }],
    x, y, wires: [[next]],
  });
  flow.push(
    functionNode(PREPARE, 'Check empty Viva level PUT', 'fn_tournament_level_readback_prepare',
      [[JOIN], [PROFILE]], 1700, 240),
    httpGet(PROFILE, 'Verify tournament organizer', AUTHORIZE, 1930, 280),
    functionNode(AUTHORIZE, 'Authorize Viva level readback', 'fn_tournament_level_readback_authorize',
      [[RESULT], [REQUEST]], 2180, 280),
    httpGet(REQUEST, 'Read back Viva tournament level', RESULT, 2430, 320),
    functionNode(RESULT, 'Confirm exact Viva numeric level', 'fn_tournament_level_readback_result',
      [[JOIN]], 2200, 240),
  );
  return {
    output: JSON.stringify(flow, null, 2) + '\n',
    changed: [CAPTURE],
    added,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, sourceSha256, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? '') || !outputPath || extra.length) {
    throw new Error('Usage: node scripts/patch_fpr_start_level_readback.mjs INPUT SOURCE_SHA256 NEW_OUTPUT');
  }
  const { output, ...changes } = patchFprStartLevelReadback(fs.readFileSync(inputPath, 'utf8'), sourceSha256);
  fs.writeFileSync(outputPath, output, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256, candidateSha256: sha256(output), ...changes }));
}
