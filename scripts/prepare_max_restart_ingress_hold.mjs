import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildExactGraphContract, validateExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { assertExternalWorkspace, verifyWorkspace } from './verify_nodered_source_origin.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const HOLD_COLLECTION = 'support_cup_restart_ingress_hold';
const CONNECTORS = ['MAX_ACADEMY_BOT', 'MAX_BOT'];
const FILES = ['webhook_prepare_restart_hold', 'restart_hold_prepare', 'restart_hold_write_result',
  'restart_hold_claim', 'restart_hold_reinject', 'restart_hold_lookup_result', 'restart_hold_finalize',
  'restart_hold_mark_unknown', 'restart_hold_finalize_result'];
const fail = code => { throw Error(`MAX restart hold refused: ${code}`); };
const need = (value, code) => { if (!value) fail(code); };
export const readMaxRestartHoldSources = () => Object.fromEntries(FILES.map(key => [key,
  fs.readFileSync(new URL(`./nodered_max_nodes/fn_max_${key}.js`, import.meta.url), 'utf8')]));
const fresh = (value, now, maximum) => {
  const age = now - Date.parse(value); return Number.isFinite(age) && age >= 0 && age <= maximum;
};

export function buildMaxRestartIngressHold({ liveBytes, admission, mongoEvidenceBytes,
  sourceTexts = readMaxRestartHoldSources(), nowMs = Date.now() }) {
  need(admission?.schema === 'PHUB_MAX_RESTART_HOLD_ADMISSION_V1', 'ADMISSION_SCHEMA');
  need(/^[0-9a-f]{32}$/.test(admission.windowId), 'WINDOW_ID');
  need(admission.sourceSha256 === hash(liveBytes), 'SOURCE_PREIMAGE');
  need(fresh(admission.capturedAt, nowMs, 30 * 60_000), 'CAPTURE_EXPIRED');
  const remaining = Date.parse(admission.acceptUntil) - nowMs;
  need(remaining > 0 && remaining <= 4 * 60 * 60_000, 'BOUNDED_WINDOW');
  need(Buffer.isBuffer(mongoEvidenceBytes) && hash(mongoEvidenceBytes) === admission.mongoEvidenceSha256, 'MONGO_EVIDENCE_HASH');
  const evidence = JSON.parse(mongoEvidenceBytes);
  need(evidence.schema === 'PHUB_MAX_HOLD_MONGO_ADMISSION_V1' && evidence.status === 'VERIFIED', 'MONGO_UNVERIFIED');
  need(fresh(evidence.observedAt, nowMs, 15 * 60_000) && evidence.sourceSha256 === admission.sourceSha256
    && evidence.windowId === admission.windowId, 'MONGO_EVIDENCE_STALE_OR_UNBOUND');
  need(evidence.database === 'games' && evidence.collection === HOLD_COLLECTION
    && evidence.connected === true && evidence.majorityJournaledWriteAcknowledged === true
    && evidence.driverContract === 'MONGODB4_FLAT_UPDATE_DOCUMENT_AFTER_V1'
    && evidence.cryptoModuleVerified === true && evidence.urlModuleVerified === true && isDeepStrictEqual(evidence.writeConcern, { w: 'majority', j: true }), 'MONGO_DURABILITY_UNKNOWN');
  const source = JSON.parse(liveBytes), candidate = structuredClone(source);
  need(Array.isArray(source) && source.length > 0 && source.every(n => typeof n.id === 'string' && n.id)
    && new Set(source.map(n => n.id)).size === source.length, 'GRAPH_IDS');
  const byId = new Map(candidate.map(n => [n.id, n]));
  const node = (id, type) => { const n = byId.get(id); need(n && (!type || n.type === type), 'NODE_TYPE'); return n; };
  for (const n of source) for (const output of n.wires || []) {
    need(Array.isArray(output) && output.every(id => byId.has(id)), 'DANGLING_WIRE');
  }
  const client = node(evidence.clientNodeId, 'mongodb4-client');
  need(hash(JSON.stringify(client)) === evidence.clientNodeSha256, 'MONGO_CLIENT_PREIMAGE');
  need(Array.isArray(admission.branches) && isDeepStrictEqual(admission.branches.map(b => b.connector).sort(), CONNECTORS), 'BOTH_CONNECTORS_REQUIRED');
  need(new Set(admission.branches.map(b => b.botConfigId)).size === 2, 'BOT_ISOLATION');
  need(new Set(admission.branches.map(b => b.normalizerId)).size === 2, 'NORMALIZER_ISOLATION');
  const changes = [], additions = [];
  const sources = sourceTexts;
  for (const key of FILES) need(typeof sources[key] === 'string' && sources[key], 'SOURCE_MISSING');
  const incoming = id => source.filter(n => (n.wires || []).some(w => w.includes(id))).map(n => n.id).sort();
  const wires = (n, expected) => need(isDeepStrictEqual(n.wires, expected), 'WIRE_DRIFT');
  for (const branch of admission.branches) {
    const tab = node(branch.tabId, 'tab'); need(tab.disabled !== true, 'TAB_DISABLED');
    const normalizer = node(branch.normalizerId, 'function'), lookup = node(branch.lookupPrepareId, 'function');
    const lookupHttp = node(branch.lookupHttpId, 'http request'), router = node(branch.routerId, 'function');
    const eventHttp = node(branch.eventHttpId, 'http request'), response = node(branch.responseId, 'http response');
    node(branch.botConfigId, 'maxbot-config');
    need(!source.some(n => n.type === 'maxbot-receive' && n.bot === branch.botConfigId
      && n.d !== true && node(n.z, 'tab').disabled !== true), 'POLLING_ACK_BOUNDARY_UNKNOWN');
    need(Array.isArray(branch.ingressIds) && branch.ingressIds.length > 0 && new Set(branch.ingressIds).size === branch.ingressIds.length, 'INGRESS_SET');
    const selected = [tab.id, normalizer.id, lookup.id, lookupHttp.id, router.id, eventHttp.id,
      response.id, branch.botConfigId, ...branch.ingressIds];
    need(branch.nodeSha256 && isDeepStrictEqual(Object.keys(branch.nodeSha256).sort(), [...new Set(selected)].sort()), 'EXACT_NODE_PINS_REQUIRED');
    for (const id of selected) need(hash(JSON.stringify(node(id))) === branch.nodeSha256[id], 'NODE_PREIMAGE_DRIFT');
    for (const n of [normalizer, lookup, lookupHttp, router, eventHttp, response]) need(n.z === tab.id, 'WRONG_BOT_FLOW');
    need(isDeepStrictEqual(incoming(normalizer.id), [...branch.ingressIds].sort()), 'FOREIGN_INGRESS');
    for (const id of branch.ingressIds) {
      const ingress = node(id, 'http in'); need(ingress.z === tab.id && ingress.method === 'post' && ingress.d !== true, 'WEBHOOK_ONLY_REQUIRED');
      wires(ingress, [[normalizer.id]]);
    }
    need(!source.some(n => (n.links || []).includes(normalizer.id)), 'LINK_INGRESS_UNKNOWN');
    need(normalizer.outputs === 3 && normalizer.initialize === '' && normalizer.finalize === ''
      && Array.isArray(normalizer.libs) && normalizer.libs.length === 0, 'NORMALIZER_CONTRACT');
    need(normalizer.func.includes('return [downstreamMsg, httpResponse, debugMsg];')
      && normalizer.func.includes('maxUpdate: normalized') && normalizer.func.includes('const expectedSecret =') && !/node\s*\.\s*(?:send|error)\s*\(/.test(normalizer.func), 'NORMALIZER_RETURN_ONLY_REQUIRED');
    need(normalizer.wires.length === 3 && normalizer.wires[2].every(id => node(id).type === 'debug'), 'NORMALIZER_DEBUG_CONTRACT');
    wires(normalizer, [[lookup.id], [response.id], normalizer.wires[2]]);
    wires(lookup, [[lookupHttp.id]]); wires(lookupHttp, [[router.id]]);
    need(router.outputs === 3 && router.wires.length === 3 && isDeepStrictEqual(router.wires[0], [eventHttp.id]), 'ROUTER_CONTRACT');
    need(lookup.func.includes(`addQuery("connector", "${branch.connector}")`)
      && router.func.includes(`connector: "${branch.connector}"`), 'CONNECTOR_SOURCE_MISMATCH');
    const sends = router.wires[1].map(id => node(id)).filter(n => n.type === 'maxbot-send');
    need(sends.length > 0 && sends.every(n => n.bot === branch.botConfigId && n.z === tab.id), 'SENDER_BOT_MISMATCH');
    need(router.wires[1].every(id => ['maxbot-send', 'debug'].includes(node(id).type)), 'ROUTER_OUTBOUND_UNKNOWN');
    for (const [n, predecessor] of [[lookup, normalizer], [lookupHttp, lookup], [router, lookupHttp], [eventHttp, router]]) {
      need(isDeepStrictEqual(incoming(n.id), [predecessor.id]), 'SHARED_PATH_REFUSED');
    }
    for (const http of [lookupHttp, eventHttp]) need(http.method === 'use' && http.ret === 'obj' && http.senderr === false, 'HTTP_CONTRACT');
    const hold = { windowId: admission.windowId, connector: branch.connector, acceptUntil: admission.acceptUntil };
    const id = role => `max_hold_${hash(JSON.stringify([admission.windowId, branch.connector, role])).slice(0,20)}`;
    const add = n => { need(!byId.has(n.id), 'ADDITION_COLLISION'); candidate.push(n); byId.set(n.id, n); additions.push(n.id); };
    const fn = (role, key, outputs, outputsTo) => {
      const func = sources[key].replace('/* __MAX_HOLD_CONFIG__ */', JSON.stringify(hold));
      new vm.Script(`(function(msg,node,context,flow,global,env,nodeCrypto,nodeUrl){${func}\n})`);
      add({ id: id(role), z: tab.id, type: 'function', name: `MAX restart hold ${role}`, func, outputs,
        noerr: 0, initialize: '', finalize: '', libs: [{ var: 'nodeCrypto', module: 'crypto' }, ...(key === 'restart_hold_prepare'
          ? [{ var: 'nodeUrl', module: 'url' }] : [])], wires: outputsTo });
    };
    const mongo = (role, operation, next) => add({ id: id(role), z: tab.id, type: 'mongodb4',
      name: `MAX restart hold ${role}`, clientNode: evidence.clientNodeId, mode: 'collection',
      collection: HOLD_COLLECTION, operation, output: 'toArray', maxTimeMS: '5000', handleDocId: false, wires: [[id(next)]] });
    const catcher = (role, scope, next) => add({ id: id(role), z: tab.id, type: 'catch',
      name: `MAX restart hold ${role}`, scope, uncaught: false, wires: [[id(next)]] });
    const manual = (role, confirmation, next, extra = {}) => add({ id: id(role), z: tab.id, type: 'inject',
      name: `MANUAL ${branch.connector} ${role}`, props: [{ p: 'payload' }], repeat: '', crontab: '', once: false,
      payloadType: 'json', payload: JSON.stringify({ windowId: admission.windowId, connector: branch.connector, confirmation, ...extra }),
      wires: [[id(next)]] });
    const gatedNormalizer = normalizer.func.replace('return [downstreamMsg, httpResponse, debugMsg];',
      "if (isWebhook && !expectedSecret) return [null, makeHttpResponse(msg, 503, { ok: false }), null];\nreturn [downstreamMsg, httpResponse, debugMsg];");
    normalizer.func = sources.webhook_prepare_restart_hold.replace('/* __PINNED_MAX_NORMALIZER__ */', gatedNormalizer);
    new vm.Script(`(function(msg,node,context,flow,global,env){${normalizer.func}\n})`);
    normalizer.outputs = 2; normalizer.wires = [[id('prepare')], [response.id]];
    changes.push({ id: normalizer.id, fields: ['func', 'outputs', 'wires'] });
    lookupHttp.wires = [[id('lookup-result')]]; changes.push({ id: lookupHttp.id, fields: ['wires'] });
    eventHttp.wires = eventHttp.wires.map(w => [...w]); need(eventHttp.wires.length === 1, 'EVENT_HTTP_OUTPUT');
    eventHttp.wires[0].push(id('finalize')); changes.push({ id: eventHttp.id, fields: ['wires'] });
    fn('prepare', 'restart_hold_prepare', 2, [[id('write')], [response.id]]);
    mongo('write', 'updateOne', 'write-result'); fn('write-result', 'restart_hold_write_result', 1, [[response.id]]);
    catcher('write-error', [id('write')], 'write-result');
    manual('drain-one', 'DRAIN_ONE_HELD_MAX_EVENT', 'claim');
    fn('claim', 'restart_hold_claim', 1, [[id('claim-write')]]); mongo('claim-write', 'findOneAndUpdate', 'reinject');
    fn('reinject', 'restart_hold_reinject', 1, [[lookup.id]]); catcher('claim-error', [id('claim-write')], 'reinject');
    fn('lookup-result', 'restart_hold_lookup_result', 2, [[router.id], [id('finalize')]]);
    catcher('lookup-error', [lookupHttp.id], 'lookup-result'); catcher('event-error', [eventHttp.id], 'finalize');
    fn('finalize', 'restart_hold_finalize', 1, [[id('final-write')]]);
    mongo('final-write', 'updateOne', 'final-result'); fn('final-result', 'restart_hold_finalize_result', 1, [[id('status')]]);
    catcher('final-error', [id('final-write')], 'final-result');
    manual('mark-unknown', 'MARK_EXACT_INTERRUPTED_CLAIM_UNKNOWN_NO_REPLAY', 'unknown', { receiptId: '', claimToken: '' });
    fn('unknown', 'restart_hold_mark_unknown', 1, [[id('final-write')]]);
    add({ id: id('status'), type: 'debug', z: tab.id, name: 'MAX restart custody status only', active: false,
      tosidebar: true, console: false, complete: 'payload', targetType: 'msg', wires: [] });
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const args = { liveBytes, candidateBytes, deploymentId: `max-restart-hold-${admission.windowId}`,
    allowedChanges: changes, allowedAdditionIds: additions };
  const contract = buildExactGraphContract(args); validateExactGraphContract({ ...args, contract });
  return { candidateBytes, contract, report: { schema: 'PHUB_MAX_RESTART_HOLD_CANDIDATE_V1',
    sourceSha256: hash(liveBytes), candidateSha256: hash(candidateBytes), windowId: admission.windowId,
    mongoEvidenceSha256: hash(mongoEvidenceBytes), changedNodeIds: changes.map(n => n.id), addedNodeIds: additions,
    collection: HOLD_COLLECTION, deploymentPerformed: false, databaseWritesPerformed: false,
    durableCupCompletion: false, rollbackRetainsHoldRecords: true } };
}

export function restoreMaxRestartHoldPreimage({ candidateBytes, originalBytes, contract }) {
  need(hash(candidateBytes) === contract.candidateSha256 && hash(originalBytes) === contract.sourceSha256, 'ROLLBACK_EXACT_PREIMAGE');
  validateExactGraphContract({ liveBytes: originalBytes, candidateBytes, contract });
  return Buffer.from(originalBytes); // Graph bytes only. Never drop/update/delete the hold collection.
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [workspace, admissionPath, evidencePath, output] = process.argv.slice(2);
    need(process.argv.length === 6 && [admissionPath, evidencePath, output].every(p => path.isAbsolute(p || '')), 'CLI_ARGUMENTS');
    verifyWorkspace(workspace); assertExternalWorkspace(path.dirname(output));
    const result = buildMaxRestartIngressHold({ liveBytes: fs.readFileSync(path.join(workspace, 'input/source.flow.json')),
      admission: JSON.parse(fs.readFileSync(admissionPath)), mongoEvidenceBytes: fs.readFileSync(evidencePath) });
    fs.mkdirSync(output, { mode: 0o700 });
    for (const [name, value] of Object.entries({ 'candidate.flow.json': result.candidateBytes,
      'reviewed-flow.contract.json': JSON.stringify(result.contract, null, 2) + '\n',
      'report.json': JSON.stringify(result.report, null, 2) + '\n' })) fs.writeFileSync(path.join(output, name), value, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result.report));
  } catch { console.error('MAX restart hold candidate refused; no deployment or database write performed.'); process.exitCode = 1; }
}
