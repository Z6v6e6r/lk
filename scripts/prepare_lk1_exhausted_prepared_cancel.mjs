import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const routerId = 'lk_subscription_booking_router_20260804';
const protocolPreimage = 'e2631979117e2f5873400ec2ae0e45e78bff4250873ae6395a9a25e208682c12';
const routerPreimage = '4c004bd49a37ef75f4751e9d82d7d2554c8ca0aba4916b284c5d6161a4bbae13';
const sha = value => createHash('sha256').update(value).digest('hex');

export function composeExhaustedPreparedCancel(liveBytes) {
  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow)) throw Error('Expected a Node-RED flow array');
  const routers = flow.filter(n => n.id === routerId);
  const router = routers[0];
  if (routers.length !== 1 || router.type !== 'function' || router.outputs !== 8
    || router.d || router.disabled || typeof router.func !== 'string') throw Error('Cancellation router identity drift');

  const start = '// Native, zero-money subscription cancellation.';
  const end = '// lk1Free* pure protocol';
  if (router.func.split(start).length !== 2 || router.func.split(end).length !== 2) {
    throw Error('Cancellation protocol anchors drifted');
  }
  const from = router.func.indexOf(start), to = router.func.indexOf(end);
  if (to < from || sha(router.func.slice(from, to).trim()) !== protocolPreimage) {
    throw Error('Cancellation protocol preimage drift');
  }
  if (sha(router.func) !== routerPreimage) throw Error('Cancellation router preaccept preimage drift');
  const protocol = fs.readFileSync(new URL('./lib/lk1FreeCancellation.mjs', import.meta.url), 'utf8')
    .replace(/^export /gm, '').trim();
  router.func = router.func.slice(0, from) + protocol + '\n\n' + router.func.slice(to);
  new Function('msg', 'node', 'global', 'env', 'flow', router.func);

  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'lk1-exhausted-prepared-cancel', allowedChanges: [{ id: routerId, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, gatewaySha256: sha(router.func) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.length !== 3) throw Error('Expected one verified private live-flow workspace');
  const verified = verifyWorkspace(process.argv[2], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (sha(liveBytes) !== verified.sourceSha256) throw Error('Verified flow bytes drifted');
  const built = composeExhaustedPreparedCancel(liveBytes);
  for (const [name, bytes] of [['exhausted-prepared-candidate.json', built.candidateBytes],
    ['exhausted-prepared-contract.json', JSON.stringify(built.contract, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(verified.workspace, name), bytes, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ candidateSha256: sha(built.candidateBytes), gatewaySha256: built.gatewaySha256 }));
}
