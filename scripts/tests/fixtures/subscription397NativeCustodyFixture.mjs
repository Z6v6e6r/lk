import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSubscription397NativeOperation, subscription397TargetNodesHash } from '../../nodered_reviewed_flow_deploy/subscription397_native_operation.mjs';
import { subscription397GraphHash, subscription397OrderedGraphHash, createSubscription397BodyPreserver } from '../../nodered_reviewed_flow_deploy/subscription397_body_preserver.mjs';
import crypto from 'node:crypto';
import { buildSubscription397Artifact } from '../../lib/subscription397_native_artifact.mjs';
import { applyPaginationEdits, subscriptionBookingPaginationEdits } from '../../prepare_subscription_booking_pagination.mjs';
import { subscriptionDateExclusionBlock } from '../../prepare_subscription_history_release.mjs';
export const sha256 = value=>crypto.createHash('sha256').update(value).digest('hex');
export const artifact=buildSubscription397Artifact();
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const booking = applyPaginationEdits(read('../../nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
  subscriptionBookingPaginationEdits().reverse().map(([a,b])=>[b,a]));
const preview = read('../../nodered_subscription_price_preview_nodes/router.js').replace(subscriptionDateExclusionBlock,'');
const start=preview.indexOf('// Collect pages before'),end=preview.indexOf("if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {",start);
const sourceBody=(preview.slice(0,start)+preview.slice(end)).replace('ctx.activeObservedAt ||=','ctx.activeObservedAt =').replace('  delete ctx.bookingsPagesDeadlineAt;\n','');
export const sourceBodies = {booking,preview:sourceBody};
export const code = 'a'.repeat(64);
export const identity = 'b'.repeat(64);
export const commit = 'c'.repeat(40);
export const confirmation = 'RESERVE_SUBSCRIPTION397_NATIVE_NO_RESTART_147';
export async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subscription397-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const stage = path.join(root, '.padlhub-subscription397-stage-20261112T110000Z-1'); fs.mkdirSync(stage, { mode: 0o700 });
  const graph = [{ id: 'tab', type: 'tab', disabled: false },
    { id: 'inject', type: 'inject', z: 'tab', once: false, crontab: '20 12 * * *', wires: [['lk_subscription_price_preview_20260908_router']] },
    { id: 'lk_subscription_price_preview_20260908_router', type: 'function', name: 'Subscription price preview router', z: 'tab', func: sourceBody, initialize: '', finalize: '', libs: [{var:'preview350Crypto',module:'crypto'},{var:'preview350Performance',module:'perf_hooks'}], outputs: 1, wires: [['http', 'debug']] },
    {id:'lk_subscription_booking_router_20260804',type:'function',z:'tab',func:booking,initialize:'// preserved',finalize:'',libs:[],wires:[[]]},
    { id: 'http', type: 'http request', z: 'tab', method: 'GET', url: '', wires: [[]] },
    { id: 'debug', type: 'debug', z: 'tab', active: false, complete: 'true' }];
  const live = path.join(root, 'flows.json'), lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  fs.writeFileSync(live, JSON.stringify(graph), { mode: 0o600 });
  let now = Date.parse('2026-11-12T11:00:00.000Z'), target = identity;
  const readback = async (g = graph, revision = 'synthetic-pre-revision') => ({ origin: 'http://127.0.0.1:18801',
    requestedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(),
    orderedGraphSha256: await subscription397OrderedGraphHash(g), editorOrderedGraphSha256: await subscription397OrderedGraphHash(g), graphSha256: await subscription397GraphHash(g), revisionSha256: sha256(revision) });
  const options = { stage, root, uid: process.getuid(), gid: process.getgid(), getUid: () => process.getuid(),
    now: () => now, readTarget: () => target, codeHash: () => code, patchOptions: {artifact} };
  const op = createSubscription397NativeOperation(options);
  const pins={expectedNodeCount:graph.length,expectedTargetNodesSha256:subscription397TargetNodesHash(graph)};
  const prepared = await op.prepare({ ...pins, expectedSourceSha256: sha256(fs.readFileSync(live)), expectedTargetSha256: identity,
    expectedCodeSha256: code, sourceCommit: commit, native: await readback() });
  const expectedPlanSha256 = prepared.planSha256;
  const reserve = async () => op.reserve({ expectedPlanSha256, confirmation, native: await readback() });
  const begin = async () => op.begin({ expectedPlanSha256, native: await readback() });
  const candidate = JSON.parse(fs.readFileSync(path.join(stage, 'candidate.flow.json')));
  const applyFixture = async seal => {
    const preserver = await createSubscription397BodyPreserver(seal, artifact, { rev: 'synthetic-pre-revision', flows: graph });
    const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
      postBody: { rev: 'synthetic-pre-revision', flows: graph } });
    fs.writeFileSync(live, JSON.stringify(JSON.parse(result.postDataText).flows));
    return { expectedPlanSha256, native: await readback(candidate, 'synthetic-post-revision'), httpStatus: 200, ackAt: now,
      audit: { ...result.audit, status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: seal.notAfter } };
  };
  return { op, options, pins, root, stage, graph, live, lease, expectedPlanSha256, reserve, begin, candidate, readback, applyFixture,
    now: () => now, advance: ms => { now += ms; }, driftTarget: () => { target = 'd'.repeat(64); } };
}
