import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { patchTrialGroupBookingSource, trialGroupCheckoutSource } from './lib/trialGroupSources.mjs';
import { verifyWorkspace, assertFlowArray } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const TRIAL_BOOKING_ID = 'lk_subscription_booking_router_20260804';
export const TRIAL_ROUTE = '/lk/trial-group-bookings';
export const TRIAL_COLLECTION = 'lk_trial_group_checkout_ops';
export const trialSha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const prefix = 'lk_trial_group_20261002_';
export function trialGroupNodes(tabId, mongoClientId) {
  const id = name => prefix + name;
  const func = (name, source, outputs, wires) => ({ id: id(name), type: 'function', z: tabId,
    name: `Trial group ${name}`, func: source, outputs, noerr: 0, initialize: '', finalize: '', libs: [],
    x: 1000, y: 5500, wires });
  const nodes = [
    { id: id('post'), type: 'http in', z: tabId, name: 'Trial group booking', url: TRIAL_ROUTE,
      method: 'post', upload: false, swaggerDoc: '', wires: [[id('entry')]] },
    func('entry', 'delete msg._subscriptionBooking; delete msg._splitCtx; return msg;', 1, [[id('router')]]),
    func('router', trialGroupCheckoutSource(), 7,
      [[id('http')], [id('find')], [id('insert')], [id('update')], [id('response')], [], []]),
    { id: id('http'), type: 'http request', z: tabId, name: 'Trial group Viva request',
      method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', requestTimeout: '20000', senderr: true,
      persist: false, authType: '', insecureHTTPParser: false, wires: [[id('router')]] },
    { id: id('response'), type: 'http response', z: tabId, name: 'Trial group response', statusCode: '', headers: {}, wires: [] },
    { id: id('options'), type: 'http in', z: tabId, name: 'OPTIONS trial group', url: TRIAL_ROUTE,
      method: 'options', upload: false, swaggerDoc: '', wires: [[id('cors')]] },
    func('cors', 'msg.statusCode=204; msg.payload=""; msg.headers={"Access-Control-Allow-Origin":"*",'
      + '"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization",'
      + '"Cache-Control":"no-store"}; return msg;', 1, [[id('response')]]),
    { id: id('catch'), type: 'catch', z: tabId, name: 'Trial group persistence errors',
      scope: [id('find'), id('insert'), id('update')], uncaught: false, wires: [[id('router')]] },
  ];
  for (const [name, operation] of [['find', 'find'], ['insert', 'insertOne'], ['update', 'updateOne']]) {
    nodes.push({ id: id(name), type: 'mongodb4', z: tabId, name: `Trial checkout ${name}`,
      collection: TRIAL_COLLECTION, operation, clientNode: mongoClientId, mode: 'collection',
      output: 'toArray', maxTimeMS: '5000', handleDocId: false, wires: [[id('router')]] });
  }
  return nodes;
}
export function composeTrialGroupCandidate(raw, expectedSourceSha, expectedBookingSha) {
  if (trialSha256(raw) !== expectedSourceSha) throw new Error('Trial source SHA drift');
  const flow = JSON.parse(raw); assertFlowArray(flow, 'Trial source');
  const booking = flow.find(row => row.id === TRIAL_BOOKING_ID);
  const mongo = flow.find(row => row.id === 'lk_subscription_booking_find_20260804');
  const productRouterId = 'lk_subscription_product_router_20260907';
  const productRouter = flow.find(row => row.id === productRouterId);
  const knownProductOutput = booking?.outputs !== 8 || (
    JSON.stringify(booking.wires?.[7]) === JSON.stringify([productRouterId])
    && productRouter?.type === 'function' && productRouter.z === booking.z
    && productRouter.d !== true && productRouter.disabled !== true);
  if (booking?.type !== 'function' || ![7, 8].includes(booking.outputs)
    || booking.wires?.length !== booking.outputs || !knownProductOutput
    || booking.d === true || booking.disabled === true || trialSha256(booking.func || '') !== expectedBookingSha
    || mongo?.type !== 'mongodb4' || mongo.z !== booking.z || mongo.operation !== 'find'
    || typeof mongo.clientNode !== 'string'
    || !flow.some(row => row.id === mongo.clientNode && row.type === 'mongodb4-client')
    || !flow.some(row => row.id === booking.z && row.type === 'tab' && row.disabled !== true)) {
    throw new Error('Trial booking/Mongo topology drift');
  }
  if (flow.some(row => row.id.startsWith(prefix) || (row.type === 'http in' && row.url === TRIAL_ROUTE))) {
    throw new Error('Trial graph already installed or route conflict');
  }
  const candidate = structuredClone(flow);
  candidate.find(row => row.id === TRIAL_BOOKING_ID).func = patchTrialGroupBookingSource(booking.func);
  const added = trialGroupNodes(booking.z, mongo.clientNode);
  candidate.push(...added); assertFlowArray(candidate, 'Trial candidate');
  for (const row of added) {
    if (row.type === 'function') new Function('msg', 'global', 'node', 'env', row.func);
    if (row.wires.flat().some(target => !candidate.some(node => node.id === target))) throw new Error('Trial graph dangling wire');
  }
  const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const deploymentId = 'trial-group-eligibility-v1';
  const contract = buildExactGraphContract({ liveBytes: raw, candidateBytes: bytes, deploymentId,
    allowedChanges: [{ id: TRIAL_BOOKING_ID, fields: ['func'] }], allowedAdditionIds: added.map(row => row.id) });
  validateReviewedFlowContract({ liveBytes: raw, candidateBytes: bytes, contract, deploymentId });
  return { candidate, bytes, contract };
}
export function writeTrialGroupCandidate(workspace, output, expectedSourceSha, expectedBookingSha) {
  // Verification checks exact live-147 origin, private files and <=30m freshness.
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (!path.isAbsolute(output || '') || path.resolve(output) !== output || fs.existsSync(output)
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Use a new canonical external directory');
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: path.dirname(output), stdio: 'pipe' });
    throw new Error('Trial raw artifacts must stay outside Git');
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  const result = composeTrialGroupCandidate(fs.readFileSync(verified.sourcePath), expectedSourceSha, expectedBookingSha);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'candidate.flow.json'), result.bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'exact-graph-contract.json'), JSON.stringify(result.contract, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { sourceSha256: expectedSourceSha, candidateSha256: trialSha256(result.bytes), changedNodes: 1,
    addedNodes: trialGroupNodes('summary', 'summary').length, liveMutation: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) throw new Error('Usage: workspace new-external-output expected-source-sha expected-booking-sha');
  console.log(JSON.stringify(writeTrialGroupCandidate(...process.argv.slice(2))));
}
