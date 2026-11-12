// Offline, source-preserving preparation. No provider calls, deployment or data writes.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { extractSubscriptionPricePreviewSource } from './lib/subscriptionPricePreviewSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const booking = read('./nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
const preview = read('./nodered_subscription_price_preview_nodes/router.js');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bookingId = 'lk_subscription_booking_router_20260804';
const previewId = 'lk_subscription_price_preview_20260908_router';
const replaceOnce = (source, before, after) => {
  if (!before || source.split(before).length !== 2) throw Error('BOOKING_PAGINATION_ANCHOR_DRIFT');
  return source.replace(before, after);
};
const slice = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0 || source.indexOf(start, a + 1) !== -1) throw Error('BOOKING_PAGINATION_TRACKED_SOURCE_DRIFT');
  return source.slice(a, b);
};

// Every edit has an exact inverse. Existing pricing, owner modules and lifecycle stay intact.
export function subscriptionBookingPaginationEdits() {
  const marker = 'const findArrayForKey =';
  const helpers = slice(booking, '// Bounded read-only pagination', marker);
  const oldGuard = '  if (msg.error || msg.statusCode !== 200 || msg.responseUrl !== `${VIVA_API_BASE}${paths[ctx.step]}`) {';
  const newGuard = slice(booking, '  const baseReadUrl =', '    return managedLeavePending');
  const edits = [[marker, helpers + marker], [oldGuard + '\n', newGuard]];
  for (const [stage, label, code] of [['active_bookings', 'Список активных записей Viva неполон', 'ACTIVE'],
    ['history_bookings', 'История записей Viva неполна', 'HISTORY']]) {
    const before = `  if (!hasCompleteBookingList(msg.payload)) {\n    return finishError(ctx, 502, "${label}", {\n      code: "SUBSCRIPTION_BOOKINGS_${code}_INCOMPLETE",\n    });\n  }\n`;
    const body = booking.slice(booking.indexOf(`if (ctx.step === "${stage}") {`));
    const a = body.indexOf('  if (!hasCompleteBookingList(msg.payload) || ctx.bookingPages');
    const b = body.indexOf('\n  }', a);
    if (a < 0 || b < 0) throw Error('BOOKING_PAGINATION_TRACKED_SOURCE_DRIFT');
    edits.push([before, body.slice(a, b + 5)]);
  }
  edits.push(['  ctx.activeBookingsObservedAt = new Date().toISOString();', '  ctx.activeBookingsObservedAt ||= new Date().toISOString();']);
  edits.push(['  const activeBookingsPayload = ctx.activeBookingsPayload;', '  delete ctx.bookingsPagesDeadlineAt;\n  const activeBookingsPayload = ctx.activeBookingsPayload;']);
  return edits;
}
export function subscriptionPreviewPaginationEdits() {
  const guard = "if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {";
  const collector = extractSubscriptionPricePreviewSource({ source: booking, roots: ['collectVivaBookingPage'] }).source;
  const prefix = `Object.assign(canonical, (() => {\n${collector}\nreturn { collectVivaBookingPage }; })());\n`;
  const pagination = slice(preview, '// Collect pages before', guard)
    .replace('lkDiagnostic({', "(typeof lkBookingsDiagnostic === 'function' ? lkBookingsDiagnostic : lkDiagnostic)({");
  return [[guard, prefix + pagination + guard],
    ['    ctx.activeObservedAt = new Date().toISOString();', '    ctx.activeObservedAt ||= new Date().toISOString();'],
    ['  ctx.cancellationSnapshot = { observedAt: ctx.activeObservedAt,',
      '  delete ctx.bookingsPagesDeadlineAt;\n  ctx.cancellationSnapshot = { observedAt: ctx.activeObservedAt,']];
}
export function applyPaginationEdits(source, edits) {
  const original = source;
  for (const [before, after] of edits) source = replaceOnce(source, before, after);
  let restored = source;
  for (const [before, after] of [...edits].reverse()) restored = replaceOnce(restored, after, before);
  if (restored !== original) throw Error('BOOKING_PAGINATION_PREIMAGE_NOT_RECOVERED');
  new Function(source);
  return source;
}
export function composeSubscriptionBookingPagination(liveBytes, { release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256 } = {}) {
  if (!/^[a-f0-9]{40}$/.test(release || '')
    || [expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256].some(value => !/^[a-f0-9]{64}$/.test(value || ''))) {
    throw Error('BOOKING_PAGINATION_EXACT_IDENTITY_REQUIRED');
  }
  if (sha(liveBytes) !== expectedSourceSha256) throw Error('BOOKING_PAGINATION_FLOW_DRIFT');
  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('BOOKING_PAGINATION_GRAPH_DRIFT');
  for (const [id, expected, edits] of [[bookingId, expectedBookingSha256, subscriptionBookingPaginationEdits()],
    [previewId, expectedPreviewSha256, subscriptionPreviewPaginationEdits()]]) {
    const node = flow.find(n => n.id === id);
    if (!node || node.type !== 'function' || node.d === true || node.disabled === true
      || flow.find(n => n.id === node.z)?.disabled === true || sha(node.func || '') !== expected) {
      throw Error('BOOKING_PAGINATION_ROUTER_DRIFT');
    }
    node.func = applyPaginationEdits(node.func, edits);
  }
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'subscription-booking-pagination',
    allowedChanges: [bookingId, previewId].map(id => ({ id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { sourceCommit: release, sourceSha256: sha(liveBytes),
    candidateSha256: sha(candidateBytes), changedNodeCount: 2, changedFields: ['func'],
    preimagesRecoverExactly: true, topologyPreserved: true, liveMutationPerformed: false } };
}

export function assertPrivatePaginationOutput(repository, workspace, directory) {
  repository = path.resolve(repository);
  workspace = path.resolve(workspace);
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
    || directory === repository || directory.startsWith(repository + '/')
    || directory === workspace || directory.startsWith(workspace + '/')
    || !fs.statSync(directory).isDirectory() || (fs.statSync(directory).mode & 0o077)) throw Error('BOOKING_PAGINATION_PRIVATE_OUTPUT_REQUIRED');
}

// Release preparation requires a fresh verified live-147 workspace and a clean source commit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('BOOKING_PAGINATION_CLEAN_HEAD_REQUIRED');
  assertPrivatePaginationOutput(repository, verified.workspace, directory);
  const result = composeSubscriptionBookingPagination(fs.readFileSync(verified.sourcePath), {
    release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256 });
  for (const [name, bytes] of [['candidate.flow.json', result.candidateBytes],
    ['contract.json', JSON.stringify(result.contract, null, 2)], ['report.json', JSON.stringify(result.report, null, 2)]]) {
    fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(result.report));
}
