import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreview363NativeOperation } from '../../nodered_reviewed_flow_deploy/preview363_native_operation.mjs';
import { preview363GraphHash, preview363OrderedGraphHash, createPreview363BodyPreserver } from '../../nodered_reviewed_flow_deploy/preview363_body_preserver.mjs';
import { sha256, buildPreview363Artifact } from '../../lib/preview363_activation.mjs';
export const sourceBody = `const ctx=msg.ctx;
const tariffDetails=()=>({});
const reason='empty_tariff_list';
const lkDiagnostic=()=>{};
    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');
return msg;`;
export const bundle = 'module.exports.createScopedEmptyTariffObserver=()=>({observe(){},dispose(){}});';

export const code = 'a'.repeat(64);
export const identity = 'b'.repeat(64);
export const commit = 'c'.repeat(40);
export const confirmation = 'RESERVE_PREVIEW363_NATIVE_NO_RESTART_147';
export async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preview363-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const stage = path.join(root, '.padlhub-preview363-stage-20261112T110000Z-1'); fs.mkdirSync(stage, { mode: 0o700 });
  const graph = [{ id: 'tab', type: 'tab', disabled: false },
    { id: 'inject', type: 'inject', z: 'tab', once: false, crontab: '20 12 * * *', wires: [['lk_subscription_price_preview_20260908_router']] },
    { id: 'lk_subscription_price_preview_20260908_router', type: 'function', name: 'Subscription price preview router', z: 'tab', func: sourceBody, initialize: '', finalize: '', libs: [{var:'preview350Crypto',module:'crypto'},{var:'preview350Performance',module:'perf_hooks'}], outputs: 1, wires: [['http', 'debug']] },
    { id: 'http', type: 'http request', z: 'tab', method: 'GET', url: '', wires: [[]] },
    { id: 'debug', type: 'debug', z: 'tab', active: false, complete: 'true' }];
  const live = path.join(root, 'flows.json'), lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  fs.writeFileSync(live, JSON.stringify(graph), { mode: 0o600 });
  let now = Date.parse('2026-11-12T11:00:00.000Z'), target = identity;
  const readback = async (g = graph, revision = 'synthetic-pre-revision') => ({ origin: 'http://127.0.0.1:18801',
    requestedAt: new Date(now).toISOString(), observedAt: new Date(now).toISOString(),
    orderedGraphSha256: await preview363OrderedGraphHash(g), editorOrderedGraphSha256: await preview363OrderedGraphHash(g), graphSha256: await preview363GraphHash(g), revisionSha256: sha256(revision) });
  const options = { stage, root, uid: process.getuid(), gid: process.getgid(), getUid: () => process.getuid(),
    now: () => now, readTarget: () => target, codeHash: () => code, patchOptions: { bundle, expectedNodeCount: 5, expectedFunctionSha256: sha256(sourceBody), expectedInitializeSha256: sha256(''), expectedFinalizeSha256: sha256('') } };
  const op = createPreview363NativeOperation(options);
  const prepared = await op.prepare({ expectedSourceSha256: sha256(fs.readFileSync(live)), expectedTargetSha256: identity,
    expectedCodeSha256: code, sourceCommit: commit, native: await readback() });
  const expectedPlanSha256 = prepared.planSha256;
  const reserve = async () => op.reserve({ expectedPlanSha256, confirmation, native: await readback() });
  const begin = async () => op.begin({ expectedPlanSha256, native: await readback() });
  const candidate = JSON.parse(fs.readFileSync(path.join(stage, 'candidate.flow.json')));
  const applyFixture = async seal => {
    const preserver = await createPreview363BodyPreserver(seal, buildPreview363Artifact(commit, bundle), { rev: 'synthetic-pre-revision', flows: graph });
    const result = await preserver({ request: { url: 'http://127.0.0.1:18801/flows', method: 'POST', apiVersion: 'v2', deploymentType: 'nodes' },
      postBody: { rev: 'synthetic-pre-revision', flows: graph } });
    fs.writeFileSync(live, JSON.stringify(JSON.parse(result.postDataText).flows));
    return { expectedPlanSha256, native: await readback(candidate, 'synthetic-post-revision'), httpStatus: 200, ackAt: now,
      audit: { ...result.audit, status: 'FORWARDED_AWAITING_READBACK', forwarded: 1, rejected: 0, notAfter: seal.notAfter } };
  };
  return { op, options, root, stage, graph, live, lease, expectedPlanSha256, reserve, begin, candidate, readback, applyFixture,
    now: () => now, advance: ms => { now += ms; }, driftTarget: () => { target = 'd'.repeat(64); } };
}

