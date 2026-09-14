import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GROUP_UPGRADE_TARGETS, hash, patchGroupEventPaymentBody } from './prepare_group_event_payment_upgrade.mjs';
import { bookingReadbackSource, eventPaymentRoutesSource } from './lib/eventPaymentSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
export const EVENT_ROUTE_TARGETS = Object.freeze([
  { id: 'lk_subscription_booking_prepare_20260804', before: '6a0552f28cb9dff0d6583fadb2503d7e19b30d81ae11c863c89b226000ccf6da', after: '0e5010a88954e100b70ff28b81b56abd8f2fad9a2b485e325c95d304777f762c' },
  { id: 'lk_subscription_booking_router_20260804', before: '26447ec9c83e38ec96a903abe2956146f4909574755e68adffe7a9b49a6ec82a', after: '510daf6733c2d68fdb6a5e45bf84a81f0b658c394f1bff0da424a40f1a839461' },
  { id: 'lk_subscription_booking_finalize_20260804', before: '8f06d32fd4fe4d55260233d4bea871fc4075437fa23c0b8a5dd4c01506695b34', after: '72f575fc4eb01f2e3ff0b7e057adff2e6a523030ac5cf7ab3776c1d13cd01415' },
  { id: 'lk_subscription_price_preview_20260908_entry', before: 'd4f40c7314c415b9bb97981b7b9f1b5e5804c9ff5d9ea1c7589627547d4b0802', after: '9e8b52eb081c55160c457e702174dda9fa35ca5e30c03fa27347f5e99e546cb2' },
  { id: 'lk_subscription_price_preview_20260908_router', before: '978bb9b97c290aac945cf425ec7ddd74e2e8d1a8aee4eeec0c47b9e44bb93171', after: '62ed17c93f6bef08877e3a8b02f93f2dc17ad293ae81768bffdb1e97fc1bd5df' },
]);
const once = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Event routes anchor drift');
  return source.replace(before, () => after);
};
// Applies only public source deltas to a caller-supplied body. The compose/CLI
// boundary below pins complete live preimages and postimages; no live I/O here.
export function patchEventPaymentBody(body, id) {
  if (id === EVENT_ROUTE_TARGETS[0].id) {
    body = once(body, '  caller: "http",\n', '  caller: "http",\n'
      + '  ...(body.expectedTournamentDiscount !== undefined ? { expectedTournamentDiscount: body.expectedTournamentDiscount } : {}),\n');
  } else if (id === EVENT_ROUTE_TARGETS[1].id) {
    body = patchGroupEventPaymentBody(body, GROUP_UPGRADE_TARGETS[0]);
    for (const delta of JSON.parse(read('./nodered_lk1_hub_nodes/event_routes_delta.json'))) {
      body = once(body, delta.before, delta.after);
    }
    body = once(body, '// EVENT_PAYMENT_ROUTES', eventPaymentRoutesSource());
    // Retain the installed game create/visit lifecycle; replace only its owner
    // proof at the authenticated read boundary and extend monetary event v1.
    const oldHelpers = read('./nodered_group_booking_confirmation_nodes/helpers.js').trim();
    body = once(body, oldHelpers, bookingReadbackSource().trim());
    const proofStart = '  delete ctx.lk1GroupConfirmationRead;\n  if (lk1GroupMoneyBooking(ctx)';
    const start = body.indexOf(proofStart);
    const end = body.indexOf('  ctx.step = step;', start);
    if (start < 0 || end < start) throw new Error('Confirmation dispatch anchor drift');
    body = once(body, body.slice(start, end), '  lk1BindConfirmationRead(ctx, step, method, url, headers);\n');
    body = once(body, '(lk1GroupMoneyBooking(ctx) && payload.paymentType === "ON_PLACE")',
      '(lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE")');
    body = once(body, '    const groupMoney = lk1GroupMoneyBooking(ctx);\n'
      + '    if (groupMoney && !lk1GroupSelfReadback(ctx))', '    if (!lk1BookingSelfReadback(ctx))');
    body = once(body, '      && (groupMoney ? lk1GroupOwnerMatches(booking, ctx.actorClientId)\n'
      + '        : normalizeId(bookingClientId(booking)) === normalizeId(ctx.actorClientId))\n'
      + '      && (!groupMoney || lk1GroupUnpaidOnPlace(booking))',
      '      && lk1BookingOwnerMatches(booking, ctx.actorClientId)\n'
      + '      && (!lk1EventMoneyBooking(ctx) || lk1BookingUnpaidOnPlace(booking))');
  } else if (id === EVENT_ROUTE_TARGETS[2].id) {
    const anchor = '  if (ctx.step === "lk1_payment_products" && responseStatus === 200) {\n';
    const canonical = read('./nodered_lk1_hub_nodes/finalize.js');
    const start = canonical.indexOf(anchor);
    const end = canonical.indexOf('    const splitCtx =', start);
    body = once(body, anchor, canonical.slice(start, end));
  } else if (id === EVENT_ROUTE_TARGETS[3].id) {
    body = read('./nodered_subscription_price_preview_nodes/entry.js');
  } else if (id === EVENT_ROUTE_TARGETS[4].id) {
    const marker = '// Dedicated advisory graph.';
    if (body.split(marker).length !== 2) throw new Error('Preview router anchor drift');
    body = body.slice(0, body.indexOf(marker)) + read('./nodered_subscription_price_preview_nodes/router.js');
  } else throw new Error('Unknown event route target');
  new Function('msg', 'node', 'global', 'flow', 'env', body);
  return body;
}
// Alternate hashes are only for synthetic graph tests; CLI never accepts them.
export function composeEventPaymentRoutes(liveBytes, deploymentId, pins = EVENT_ROUTE_TARGETS) {
  const source = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(source) || source.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(source.map(n => n.id)).size !== source.length) throw new Error('Invalid flow identity');
  if (pins.length !== EVENT_ROUTE_TARGETS.length || pins.some((p,i) => p.id !== EVENT_ROUTE_TARGETS[i].id)) throw new Error('Invalid target allowlist');
  const candidate = structuredClone(source);
  for (const target of pins) {
    const node = candidate.find(n => n.id === target.id);
    if (node?.type !== 'function' || node.d === true || node.disabled === true
      || !Number.isInteger(node.outputs) || node.outputs < 1 || node.wires?.length !== node.outputs
      || typeof node.func !== 'string') throw new Error(`Node contract mismatch: ${target.id}`);
    if (hash(node.func) !== target.before) throw new Error(`Preimage drift: ${target.id}`);
    node.func = patchEventPaymentBody(node.func, target.id);
    if (hash(node.func) !== target.after) throw new Error(`Postimage drift: ${target.id}`);
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes: Buffer.from(liveBytes), candidateBytes, deploymentId,
    allowedChanges: EVENT_ROUTE_TARGETS.map(t => ({ id: t.id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: Buffer.from(liveBytes), candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
export function writeEventPaymentRoutes(input, output, deploymentId) {
  if (!path.isAbsolute(input || '') || !path.isAbsolute(output || '') || fs.existsSync(output)
    || path.resolve(output) !== output || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Use absolute input and a new private output directory');
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: path.dirname(output), stdio: 'pipe' });
    throw new Error('Raw output must stay outside Git');
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  const liveBytes = fs.readFileSync(input);
  const artifacts = composeEventPaymentRoutes(liveBytes, deploymentId);
  fs.mkdirSync(output, { mode: 0o700 });
  const summary = { deploymentId, sourceSha256: hash(liveBytes), candidateSha256: hash(artifacts.candidateBytes),
    changes: EVENT_ROUTE_TARGETS, addedNodes: 0, liveWrites: 0 };
  for (const [name,value] of [['candidate.flow.json', artifacts.candidateBytes], ['exact-graph-contract.json', JSON.stringify(artifacts.contract,null,2)+'\n'], ['operator-summary.json',JSON.stringify(summary,null,2)+'\n']]) {
    fs.writeFileSync(path.join(output,name),value,{mode:0o600,flag:'wx'});
  }
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) throw new Error('Usage: node prepare_event_payment_routes_upgrade.mjs /absolute/source.flow.json /absolute/new-private-directory deployment-id');
  console.log(JSON.stringify(writeEventPaymentRoutes(...process.argv.slice(2))));
}
