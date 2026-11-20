import { removeImplicitCommunityLevel } from './lib/cupLevelCompatibility.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
/** Offline only: the caller pins the complete fresh source. Raw flows stay outside Git. */
export function patchCupOnlyPlayerLevel(bytes, expectedSha256) {
  if (hash(bytes) !== expectedSha256) throw Error('CUP_LEVEL_FLOW_PREIMAGE');
  const flow = JSON.parse(bytes), before = structuredClone(flow), byId = new Map(flow.map(n => [n.id, n]));
  if (!Array.isArray(flow) || byId.size !== flow.length || byId.has('cup_level_prepare')) throw Error('CUP_LEVEL_FLOW_SHAPE');
  const required = (id, type) => { const n = byId.get(id); if (!n || n.type !== type) throw Error('CUP_LEVEL_NODE_PREIMAGE'); return n; };
  const live = required('60fed6840a99b741', 'http in'), onboarding = required('ad36d8dd848c89dd', 'http in');
  if (live.url !== '/lk/games/ratings/live' || onboarding.url !== '/lk/onboarding/level') throw Error('CUP_LEVEL_ROUTE_PREIMAGE');
  required('4e820638cc39c730', 'mongodb4-client');
  const z = live.z, nodes = [];
  const fn = (id, name, func, outputs, wires, libs = []) => { const n = { id, type: 'function', z, name, func, outputs, timeout: '', noerr: 0, initialize: '', finalize: '', libs, wires, x: 500, y: 3100 }; nodes.push(n); return n; };
  fn('cup_level_self', 'Read own canonical level', "msg._cupLevelOperation = 'self'; return msg;", 1, [['cup_level_prepare']]);
  fn('cup_level_batch', 'Read canonical player levels', "msg._cupLevelOperation = 'batch'; return msg;", 1, [['cup_level_prepare']]);
  fn('cup_level_initial', 'Initialize own canonical level', "msg._cupLevelOperation = 'initialize'; return msg;", 1, [['cup_level_prepare']]);
  fn('cup_level_prepare', 'Authenticate canonical level request', read('./nodered_player_level_nodes/prepare.js'), 2, [['cup_level_profile'], ['cup_level_response']]);
  nodes.push({ id: 'cup_level_profile', type: 'http request', z, name: 'Verify canonical level actor profile', method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', requestTimeout: '10000', wires: [['cup_level_authorize']], x: 700, y: 3100 });
  fn('cup_level_authorize', 'Bind canonical level actor', read('./nodered_player_level_nodes/authorize.js'), 2, [['cup_level_dispatch'], ['cup_level_response']]);
  fn('cup_level_dispatch', 'Run canonical level child', read('./nodered_player_level_nodes/dispatch.js'), 1, [['cup_level_response']], [{ var: 'nodeChildProcess', module: 'child_process' }]);
  fn('cup_level_error', 'Sanitize canonical level failure', "msg.statusCode=503; msg.headers={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}; msg.payload={error:'LEVEL_UNAVAILABLE'}; return msg;", 1, [['cup_level_response']]);
  nodes.push({ id: 'cup_level_catch', type: 'catch', z, name: 'Catch canonical level errors', scope: ['cup_level_prepare','cup_level_profile','cup_level_authorize','cup_level_dispatch'], uncaught: false, wires: [['cup_level_error']], x: 500, y: 3160 });
  nodes.push({ id: 'cup_level_response', type: 'http response', z, name: 'Canonical level response', statusCode: '', headers: {}, wires: [], x: 1000, y: 3100 });
  const route = (id, method, url, target) => {
    if (flow.some(n => n.type === 'http in' && n.method === method && n.url === url)) throw Error('CUP_LEVEL_ROUTE_COLLISION');
    nodes.push({ id, type: 'http in', z, name: id, method, url, upload: false, swaggerDoc: '', wires: [[target]], x: 200, y: 3100 });
  };
  route('cup_level_self_in', 'get', '/lk/games/ratings/me', 'cup_level_self');
  fn('cup_level_cors', 'Canonical level CORS', "msg.statusCode=204; msg.headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store'}; msg.payload=''; return msg;", 1, [['cup_level_response']]);
  route('cup_level_self_options', 'options', '/lk/games/ratings/me', 'cup_level_cors');
  live.wires = [['cup_level_batch']]; onboarding.wires = [['cup_level_initial']];
  const retire = (id, type = 'function') => { const n = required(id, type); n.func = "// Retired by CUP-only level cutover. Historical graph retained.\nreturn null;"; };
  // This independently routed tenant remains outside the PadlHub cutover.
  // Pin the only legacy reference allowed in that overlay so it cannot hide a new reader.
  const primeRoute = byId.get('f17b8f6f69e3bc24');
  const primeReader = byId.get('c94761527a2905c6');
  const primaryReader = required('4401a1baa1a06b81', 'function');
  if (primeRoute || primeReader) {
    if (primeRoute?.type !== 'http in' || primeRoute.method !== 'post'
      || primeRoute.url !== '/pade-prime/lk/games/ratings/live' || primeRoute.z !== '8cb78548819553d0'
      || primeReader?.type !== 'function' || primeReader.z !== primeRoute.z || primeReader.func !== primaryReader.func) {
      throw Error('CUP_LEVEL_OTHER_TENANT_PREIMAGE');
    }
  }
  for (const id of ['74ae1729191fc747', 'b2c3d4e5f6011223', 'd4e5f60112233445', 'bcff3bb938651dc9', '4401a1baa1a06b81']) retire(id);
  for (const [id, file] of [
    ['0dafa71f5e7361d2','fn_result_viva_sync_request_prepare.js'],
    ['fda494e359188dd4','fn_result_viva_sync_handle_response.js'],
    ['6c5512b06d079e30','fn_result_viva_sync_outbox_prepare.js'],
    ['321cfd8582108cc7','fn_result_viva_sync_retry_query.js'],
    ['d0f0fd9ca2dc9f5d','fn_result_viva_sync_finalize_batch.js'],
  ]) required(id, 'function').func = read('./nodered_result_nodes/' + file);
  const fprBootstrap = byId.get('fpr_canonical_bootstrap_20261106');
  if (fprBootstrap) {
    if (fprBootstrap.type !== 'function' || !fprBootstrap.libs?.some(lib => lib.var === 'nodeChildProcess' && lib.module === 'child_process')
      || !fprBootstrap.func.includes('/opt/padlhub-fpr-start/current/bootstrap.mjs')) throw Error('CUP_LEVEL_FPR_BOOTSTRAP_PREIMAGE');
    fprBootstrap.func = read('./nodered_fpr_start_nodes/initialize.js');
  }
  const build = required('21d3e90986ed5b82', 'function'), attach = required('0c63087697cb16c0', 'function');
  build.func = read('./nodered_tournament_participants_nodes/fn_build_client_request_v2.js');
  attach.func = read('./nodered_tournament_participants_nodes/fn_attach_rating_v2.js');
  build.wires = [['22d45839d507e03b'], ['cup_level_participants_find']];
  nodes.push({ id: 'cup_level_participants_find', type: 'mongodb4', z: build.z, name: 'Read canonical participant levels', clientNode: '4e820638cc39c730', mode: 'collection', collection: 'player_rating_state', operation: 'find', output: 'toArray', maxTimeMS: '5000', handleDocId: false, wires: [[attach.id]], x: 800, y: 3200 });
  attach.wires = [['22d45839d507e03b']];
  // Bind compatibility snapshots to current CUP levels before membership mutations.
  const communityMutations = flow.filter(n => n.type === 'http in' && ['post', 'patch'].includes(n.method)
    && /^\/lk\/communities(?:\/[^/]+)?(?:\/(?:join|add-member|members\/manage|invite))?$/.test(n.url || ''));
  for (const route of communityMutations) {
    const id = 'cup_level_snapshot_' + route.id;
    const n = fn(id, 'Refresh CUP community member levels', read('./nodered_player_level_nodes/snapshot.js'), 2,
      [route.wires.flat(), ['cup_level_response']], [{ var: 'nodeChildProcess', module: 'child_process' }]);
    n.z = route.z; route.wires = [[id]];
  }
  const autojoins = flow.filter(n => n.z !== primeRoute?.z && n.type === 'function' && (n.func || '').includes('const sameMemberIdentity =') && (n.func || '').includes('autojoin'));
  for (const target of autojoins) {
    const id = 'cup_level_snapshot_' + target.id;
    const n = fn(id, 'Refresh CUP levels before autojoin', read('./nodered_player_level_nodes/snapshot.js'), 2,
      [[target.id], ['cup_level_response']], [{ var: 'nodeChildProcess', module: 'child_process' }]); n.z = target.z;
    for (const prior of flow) if (prior.wires) prior.wires = prior.wires.map(output => output.map(wire => wire === target.id ? id : wire));
  }
  for (const n of flow) if (n.type === 'function' && n.z !== primeRoute?.z) n.func = removeImplicitCommunityLevel(n.func || '');
  flow.push(...nodes);
  const ids = new Set(flow.map(n => n.id));
  if (ids.size !== flow.length || flow.some(n => (n.wires || []).flat().some(id => !ids.has(id)))) throw Error('CUP_LEVEL_GRAPH_INVALID');
  for (const n of nodes.filter(n => n.type === 'function')) new Function('msg', 'node', n.func);
  if (flow.some(n => n !== primeReader && n.type === 'function' && /eabfe27b|f9790818|9018d922/.test(n.func || ''))) throw Error('CUP_LEVEL_PROVIDER_FIELD_REMAINS');
  const changed = before.filter((n, i) => JSON.stringify(n) !== JSON.stringify(flow[i])).map(n => ({ id: n.id, before: hash(JSON.stringify(n)), after: hash(JSON.stringify(byId.get(n.id))) }));
  return { output: JSON.stringify(flow, null, 2) + '\n', report: { sourceSha256: expectedSha256, changed, added: nodes.map(n => n.id), providerLevelFieldReferences: 0, preservedOtherTenantReaders: primeReader ? [primeReader.id] : [] } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, sha, output, report] = process.argv.slice(2);
  if (!input || !sha || !output || !report || fs.existsSync(output) || fs.existsSync(report)) throw Error('Usage: source.json source-sha NEW-candidate.json NEW-report.json');
  const result = patchCupOnlyPlayerLevel(fs.readFileSync(input), sha);
  fs.writeFileSync(output, result.output, { mode: 0o600 }); fs.writeFileSync(report, JSON.stringify(result.report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ changed: result.report.changed.length, added: result.report.added.length, providerLevelFieldReferences: 0, preservedOtherTenantReaders: result.report.preservedOtherTenantReaders }));
}
