import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildExactGraphContract, validateExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { syncPaymentPolling } from './sync_subscription_payment_polling.mjs';
import { assertExternalWorkspace, verifyWorkspace } from './verify_nodered_source_origin.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
export const pollingGeneration = JSON.parse(fs.readFileSync(new URL('./subscription_payment_polling_generation.json', import.meta.url)));
export const pollingTargets = pollingGeneration.targets;
const ids = { query: 'ab1e202650000002', find: 'ab1e202650000003', expand: 'annual_history_expand_20260909',
  split: 'ab1e202650000004', delay: 'ab1e202650000005', record: 'ab1e202650000006',
  resolve: 'ca022fd14027a5b0', response: '10fe94a32b8adc35',
  admit: 'subscription_poll_admit_20260914', ack: 'subscription_poll_ack_20260914',
  cas: 'subscription_poll_cas_20260914', catch: 'subscription_poll_catch_20260914', dispatch: 'subscription_poll_dispatch_20260914' };
export function readPollingSources() {
  return Object.fromEntries([...pollingTargets, ...pollingGeneration.additions].map(t => [t.fileName,
    fs.readFileSync(new URL(`./nodered_games_nodes/${t.fileName}`, import.meta.url), 'utf8')]));
}
export function buildPaymentPollingCandidate({ liveBytes, sourceTexts, generation = pollingGeneration }) {
  const source = JSON.parse(liveBytes), candidate = structuredClone(source);
  if (!Array.isArray(source) || new Set(source.map(n => n.id)).size !== source.length) throw Error('polling graph invalid');
  const node = id => { const value = candidate.find(n => n.id === id); if (!value) throw Error('polling node missing'); return value; };
  const assertWires = (id, wires) => { if (!isDeepStrictEqual(node(id).wires, wires)) throw Error('polling wiring drift'); };
  const tab = node(node(ids.resolve).z);
  if (tab.type !== 'tab' || tab.disabled === true) throw Error('polling tab disabled');
  for (const id of [ids.query, ids.find, ids.expand, ids.split, ids.delay, ids.record]) {
    if (node(id).z !== tab.id) throw Error('polling tab mismatch');
  }
  const assertIncoming = (id, expected) => {
    const incoming = source.filter(n => (n.wires || []).some(w => w.includes(id))).map(n => n.id).sort();
    if (!isDeepStrictEqual(incoming, expected.sort())) throw Error('polling incoming edge drift');
  };
  assertIncoming(ids.split, [ids.expand]); assertIncoming(ids.delay, [ids.split]); assertIncoming(ids.record, [ids.delay]);
  assertWires(ids.query, [[ids.find]]); assertWires(ids.find, [[ids.expand]]);
  assertWires(ids.expand, [[ids.split]]); assertWires(ids.split, [[ids.delay]]);
  assertWires(ids.delay, [[ids.record]]); assertWires(ids.record, [[ids.resolve]]);
  assertWires(ids.resolve, [['fdc3f25f39199546'], [ids.response], ['03cc3ac17f7e154a'], ['piter_atomic_router_20260903']]);
  const db = node(ids.find);
  if (db.type !== 'mongodb4' || db.operation !== 'find' || db.collection !== 'lk_tournament_subscription_sales') throw Error('polling Mongo target drift');
  if (!db.clientNode || node(db.clientNode).type !== 'mongodb4-client') throw Error('polling Mongo client drift');
  const changes = [];
  for (const target of generation.targets) {
    const current = node(target.id), code = sourceTexts[target.fileName];
    if (current.type !== 'function' || sha(current.func.trim()) !== target.preimageSha256
      || sha(code) !== target.candidateSha256) throw Error(`polling source drift: ${target.fileName}`);
    new vm.Script(`(function(msg,node,context,flow,global,env){${code}\n})`);
    current.func = code; changes.push({ id: current.id, fields: ['func'] });
  }
  node(ids.expand).wires = [[ids.dispatch]];
  changes.find(c => c.id === ids.expand).fields.push('wires');
  node(ids.resolve).outputs = 5; node(ids.resolve).wires.push([ids.admit]);
  changes.find(c => c.id === ids.resolve).fields.push('outputs', 'wires');
  const added = [];
  for (const [name, id, outputs, wires] of [
    ['poll_admit', ids.admit, 3, [[ids.cas], [ids.resolve], [ids.response]]],
    ['poll_ack', ids.ack, 2, [[ids.resolve], [ids.response]]],
    ['reconcile_dispatch', ids.dispatch, 1, [[ids.record]]],
  ]) {
    const file = `fn_tournament_subscription_${name}.js`, code = sourceTexts[file];
    if (candidate.some(n => n.id === id) || sha(code) !== generation.additions.find(t => t.fileName === file)?.candidateSha256) throw Error('polling added source drift');
    new vm.Script(`(function(msg,node,context,flow,global,env){${code}\n})`);
    candidate.push({ id, type: 'function', z: tab.id, name: `Subscription ${name}`, func: code, outputs,
      timeout: 0, noerr: 0, initialize: name === 'reconcile_dispatch' ? "context.set('batchActive', false);" : '',
      finalize: '', libs: [], x: 100, y: 100, wires }); added.push(id);
  }
  if (candidate.some(n => n.id === ids.cas)) throw Error('polling CAS already exists');
  candidate.push({ ...structuredClone(db), id: ids.cas, name: 'Claim subscription payment check',
    operation: 'findOneAndUpdate', wires: [[ids.ack]] }); added.push(ids.cas);
  if (candidate.some(n => n.id === ids.catch)) throw Error('polling catch already exists');
  candidate.push({ id: ids.catch, type: 'catch', z: tab.id, name: 'Subscription payment claim error',
    scope: [ids.cas], uncaught: false, x: 100, y: 100, wires: [[ids.ack]] }); added.push(ids.catch);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const args = { liveBytes, candidateBytes, deploymentId: 'subscription-payment-polling-20260914',
    allowedChanges: changes, allowedAdditionIds: added };
  const contract = buildExactGraphContract(args); validateExactGraphContract({ ...args, contract });
  return { candidateBytes, contract, report: { sourceSha256: sha(liveBytes), candidateSha256: sha(candidateBytes),
    changedNodeIds: changes.map(c => c.id), addedNodeIds: added, maxBatch: 60,
    deploymentPerformed: false, databaseWritesPerformed: false } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [workspace, outputDir] = process.argv.slice(2);
    if (process.argv.length !== 4 || !path.isAbsolute(outputDir || '')) throw Error('Usage: /absolute/verified-workspace /absolute/new-output');
    await verifyWorkspace(workspace);
    syncPaymentPolling({ check: true });
    // Validate the parent before creating anything; never write raw flows inside a checkout.
    assertExternalWorkspace(path.dirname(outputDir));
    const result = buildPaymentPollingCandidate({ liveBytes: fs.readFileSync(path.join(workspace, 'input/source.flow.json')), sourceTexts: readPollingSources() });
    fs.mkdirSync(outputDir, { mode: 0o700 });
    for (const [name, data] of Object.entries({ 'candidate.flow.json': result.candidateBytes,
      'reviewed-flow.contract.json': JSON.stringify(result.contract, null, 2) + '\n', 'report.json': JSON.stringify(result.report, null, 2) + '\n' })) {
      fs.writeFileSync(path.join(outputDir, name), data, { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(result.report));
  } catch { console.error('Payment polling candidate refused; no deployment or data mutation performed.'); process.exitCode = 1; }
}
