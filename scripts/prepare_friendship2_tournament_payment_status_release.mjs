import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPrivatePaginationOutput } from './prepare_subscription_booking_pagination.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const prepareId = 'lk_subscription_booking_prepare_20260804';
const routerId = 'lk_subscription_booking_router_20260804';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const statusSource = () => fs.readFileSync(new URL('./nodered_subscription_booking_nodes/tournament_payment_status.js', import.meta.url), 'utf8');

function unique(source, text) {
  if (source.split(text).length !== 2) throw Error('Tournament payment status patch anchor drift: ' + text);
  return source.indexOf(text);
}

function replace(source, before, after) {
  unique(source, before);
  return source.replace(before, () => after);
}

function patchesForPrepare(body) {
  const eligibility = 'const spotNumber = Number(body.spot);\n';
  const liveAction = "if (!['book', 'release', 'cancel-free'].includes(action)) {";
  const action = body.includes(liveAction) ? liveAction : "if (!['book', 'release'].includes(action)) {";
  const operation = 'if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {';
  const validation = String.raw`
const tournamentPaymentStatus = action === "tournament-payment-status";
if (tournamentPaymentStatus && (Object.keys(body).sort().join(",") !== "action,bookingId,exerciseId"
  || ![exerciseId, releaseBookingId].every(value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value || "")))) {
  return finish(400, "Требуется точная привязка записи на турнир", { code: "TOURNAMENT_PAYMENT_STATUS_TARGET_INVALID" });
}
`.trimStart();
  return [
    [eligibility, eligibility + validation],
    [action, action.replace('includes(action))', 'includes(action) && !tournamentPaymentStatus)')],
    [operation, operation.replace('if (', 'if (!tournamentPaymentStatus && (').replace(')) {', '))) {')],
    ['  step: "profile",', '  step: tournamentPaymentStatus ? "tournament_payment_profile" : "profile",'],
    ['exerciseId: action === "book" ? exerciseId : null,', 'exerciseId: action === "book" || tournamentPaymentStatus ? exerciseId : null,'],
  ];
}

function patchesForRouter() {
  const source = statusSource();
  const marker = '// PROFILE PAYMENT LOOKUP\n';
  unique(source, marker);
  const [readSteps, profileLookup] = source.split(marker);
  const profile = 'if (ctx.step === "profile") {';
  const identityChecked = '      code: "SUBSCRIPTION_BOOKING_PROFILE_INCOMPLETE",\n    });\n  }\n';
  return [
    [profile, readSteps + 'if (ctx.step === "profile" || ctx.step === "tournament_payment_profile") {'],
    [identityChecked, identityChecked + profileLookup],
  ];
}

export function addTournamentPaymentStatus(body, kind) {
  const patches = kind === 'prepare' ? patchesForPrepare(body) : patchesForRouter();
  const candidate = patches.reduce((source, [before, after]) => replace(source, before, after), body);
  if ([...patches].reverse().reduce((source, [before, after]) => replace(source, after, before), candidate) !== body) {
    throw Error('Tournament payment inverse changed the preimage: ' + kind);
  }
  new Function(candidate);
  return candidate;
}

export function composeFriendship2TournamentPaymentStatusRelease(liveBytes, { sourceSha256, prepareSha256, routerSha256 }) {
  if (sha(liveBytes) !== sourceSha256) throw Error('Exact tournament payment flow preimage required');
  const flow = JSON.parse(liveBytes);
  const specs = [[prepareId, prepareSha256, 'prepare'], [routerId, routerSha256, 'router']];
  for (const [id, expected, kind] of specs) {
    const node = flow.find(item => item.id === id);
    const tab = flow.find(item => item.id === node?.z && item.type === 'tab');
    if (node?.type !== 'function' || node.d || node.disabled || !tab || tab.disabled || sha(node.func) !== expected) {
      throw Error('Exact tournament payment node preimage required: ' + id);
    }
    node.func = addTournamentPaymentStatus(node.func, kind);
  }
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const allowedChanges = specs.map(([id]) => ({ id, fields: ['func'] }));
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'friendship2-tournament-payment-status',
    allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { sourceSha256, candidateSha256: sha(candidateBytes), allowedChanges,
    exactInverseVerified: true, liveMutationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, sourceSha256, prepareSha256, routerSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(release || '') || git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) {
    throw Error('Clean release checkout required');
  }
  assertPrivatePaginationOutput(repository, verified.workspace, directory);
  const packet = composeFriendship2TournamentPaymentStatusRelease(fs.readFileSync(verified.sourcePath), {
    sourceSha256, prepareSha256, routerSha256,
  });
  for (const [file, data] of [['candidate.flow.json', packet.candidateBytes],
    ['contract.json', JSON.stringify(packet.contract, null, 2)], ['report.json', JSON.stringify({ release, ...packet.report }, null, 2)]]) {
    fs.writeFileSync(path.join(directory, file), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ release, ...packet.report }));
}
