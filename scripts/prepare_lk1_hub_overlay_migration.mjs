#!/usr/bin/env node

// Migration-only composer for the HUB overlay already active on 147.  The regular
// HUB composer intentionally starts from raw pre-HUB functions; this one refuses
// anything except the reviewed active-overlay preimage and changes gateway.func only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const gatewaySource = fs.readFileSync(path.join(dir, 'nodered_lk1_hub_nodes', 'gateway.js'), 'utf8');

export const HUB_OVERLAY_LIVE_CONTRACT = Object.freeze({
  sourceSha256: 'f6c6c9e2da8a751a28075e44521662f794556052b96c17bed3fc00f59f5b502d',
  gatewayId: 'lk_subscription_booking_router_20260804',
  gatewayFuncSha256: 'aa9be7356409f7a486a3b97a3f1278c5a1090a9e27c77193229069cead6fb799',
});

const fail = (message) => { throw new Error(message); };
const replaceOnce = (source, before, after, label) => {
  if (source.split(before).length !== 2) fail(`HUB overlay migration anchor drift: ${label}`);
  return source.replace(before, after);
};
const fragment = (start, end) => {
  const from = gatewaySource.indexOf(start);
  const to = gatewaySource.indexOf(end, from + start.length);
  if (from < 0 || to < 0) fail(`HUB migration source fragment drift: ${start}`);
  return gatewaySource.slice(from, to).trim();
};
const helpers = fragment('const LK1_EXPIRED_PENDING_RECONCILE =', '\nif (ctx.step === "lk1_ingress_operation_find") {');
const ingressDispatch = fragment('if (lk1ExpiredUnboundClaim(operation, Date.now())) {', '\n    if (operation.state !== "CONFIRMED"');
const reconciliation = fragment('if (ctx.step === LK1_EXPIRED_PENDING_RECONCILE) {', '\nif (ctx.step === "lk1_money_owned_subscriptions") {');

const requiredAbsent = [
  'HUB_PENDING_CONFIRMATION_MS',
  'LK1_EXPIRED_PENDING_RECONCILE',
  'if (ctx.step === LK1_EXPIRED_PENDING_RECONCILE) {',
  'pendingUntil: new Date(now.getTime() + HUB_PENDING_CONFIRMATION_MS).toISOString()',
];

export function buildHubOverlayMigrationCandidate(liveBytes) {
  if (!Buffer.isBuffer(liveBytes)) fail('Live preimage bytes are required');
  if (hash(liveBytes) !== HUB_OVERLAY_LIVE_CONTRACT.sourceSha256) fail('HUB overlay live preimage changed');
  const source = JSON.parse(liveBytes.toString('utf8'));
  if (!Array.isArray(source)) fail('Node-RED source must be an array');
  const flow = structuredClone(source);
  const node = flow.find((item) => item.id === HUB_OVERLAY_LIVE_CONTRACT.gatewayId);
  if (!node || node.type !== 'function' || typeof node.func !== 'string') fail('HUB overlay gateway contract mismatch');
  if (hash(node.func) !== HUB_OVERLAY_LIVE_CONTRACT.gatewayFuncSha256) fail('HUB overlay gateway preimage changed');
  if (requiredAbsent.some((marker) => node.func.includes(marker))) fail('HUB overlay migration already composed');

  let candidate = node.func;
  candidate = replaceOnce(candidate,
    'const MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-09-01";',
    'const MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-09-01";\n\n'
      + '// Bounded pending window for a HUB claim.\n'
      + 'const HUB_PENDING_CONFIRMATION_MS = 15 * 60 * 1000;',
    'HUB helper declaration');
  candidate = replaceOnce(candidate,
    'state: "PENDING_CONFIRMATION", "lk1.createAttemptedAt": ctx.lk1.createAttemptedAt,\n      updatedAt: now.toISOString()',
    'state: "PENDING_CONFIRMATION", "lk1.createAttemptedAt": ctx.lk1.createAttemptedAt,\n'
      + '      pendingUntil: new Date(now.getTime() + HUB_PENDING_CONFIRMATION_MS).toISOString(),\n'
      + '      updatedAt: now.toISOString()',
    'HUB create-attempt pending deadline');
  candidate = replaceOnce(candidate,
    'if (ctx.step === "lk1_ingress_operation_find") {',
    `${helpers}\n\nif (ctx.step === "lk1_ingress_operation_find") {`,
    'HUB ingress helpers');
  candidate = replaceOnce(candidate,
    '    if (operation.state !== "CONFIRMED" || typeof operation.bookingId !== "string" || !operation.bookingId.trim()',
    `    ${ingressDispatch}\n    if (operation.state !== "CONFIRMED" || typeof operation.bookingId !== "string" || !operation.bookingId.trim()`,
    'HUB ingress expiry dispatch');
  candidate = replaceOnce(candidate,
    'if (ctx.step === "lk1_money_owned_subscriptions") {',
    `${reconciliation}\n\nif (ctx.step === "lk1_money_owned_subscriptions") {`,
    'HUB reconciliation handlers');
  for (const marker of requiredAbsent) {
    if (!candidate.includes(marker)) fail(`HUB overlay migration did not install: ${marker}`);
  }
  if (candidate.split('HUB_PENDING_CONFIRMATION_MS').length !== 3
    || candidate.split('LK1_EXPIRED_PENDING_RECONCILE').length < 4) fail('HUB overlay migration marker multiplicity changed');
  new Function('msg', 'node', 'env', 'global', candidate);
  node.func = candidate;

  const changed = flow.filter((item, index) => !isDeepStrictEqual(item, source[index]));
  if (changed.length !== 1 || changed[0].id !== HUB_OVERLAY_LIVE_CONTRACT.gatewayId
    || !isDeepStrictEqual({ ...changed[0], func: source.find((item) => item.id === changed[0].id).func },
      source.find((item) => item.id === changed[0].id))) fail('HUB overlay migration change budget exceeded');
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'lk1-hub-overlay-pending-recovery-20260912',
    allowedChanges: [{ id: HUB_OVERLAY_LIVE_CONTRACT.gatewayId, fields: ['func'] }],
    allowedAdditionIds: [],
  });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { flow, candidateBytes, contract };
}
