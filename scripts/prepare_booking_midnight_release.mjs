#!/usr/bin/env node
// Focused live backport of PR377; no I/O against provider, DB or production runtime.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { extractSubscriptionPricePreviewSource } from './lib/subscriptionPricePreviewSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
export const MIDNIGHT_LIVE_PINS = Object.freeze({
  prepare: { id: 'f3f9a60354d394da', sha256: 'b69eb36c138d5b9ae6ac020202148ca6d86f7495b4046811f7dde1473ea0ef9d' },
  split: { id: '8f7bd5b482fe9763', sha256: 'd93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b' },
  finalize: { id: 'lk_subscription_booking_finalize_20260804', sha256: '62ac99bd56a710179e57c5de48826da21417beccfd08090493e6a4194a4299b2' },
  preview: { id: 'lk_subscription_price_preview_20260908_router', sha256: '2053d6679bb41354bda6484ebb4ea1f558884cd946f1c5ba57eddf262f78f37a' },
});
export function midnightReplace(source, before, after, count = 1) {
  if (source.split(before).length - 1 !== count) throw Error('MIDNIGHT_RELEASE_ANCHOR_DRIFT');
  return source.split(before).join(after);
}
export function composeBookingMidnightRelease(liveBytes, { expectedSourceSha256, release } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256 || '') || sha(liveBytes) !== expectedSourceSha256) throw Error('MIDNIGHT_RELEASE_FLOW_DRIFT');
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw Error('MIDNIGHT_RELEASE_COMMIT_REQUIRED');
  const flow = JSON.parse(liveBytes);
  if (flow.length !== 4985 || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('MIDNIGHT_RELEASE_GRAPH_DRIFT');
  const nodes = {};
  for (const [key, pin] of Object.entries(MIDNIGHT_LIVE_PINS)) {
    const n = flow.find(n => n.id === pin.id);
    if (!n || n.type !== 'function' || n.d === true || n.disabled === true || flow.find(t => t.id === n.z)?.disabled === true
      || sha(n.func || '') !== pin.sha256) throw Error('MIDNIGHT_RELEASE_FUNCTION_DRIFT');
    nodes[key] = n;
  }
  const helper = extractSubscriptionPricePreviewSource({ source: read('nodered_games_nodes/fn_split_router.js'), roots: ['splitCreateEndDate'] }).source + '\n';
  if (Object.values(nodes).some(n => n.func.includes('const splitCreateEndDate ='))) throw Error('MIDNIGHT_RELEASE_ALREADY_COMPOSED');
  for (const key of ['prepare', 'split', 'finalize']) nodes[key].func = helper + nodes[key].func;
  const prep = nodes.prepare;
  prep.func = midnightReplace(prep.func, 'const startAtIso = `${date}T${fromTime}:00+03:00`;', 'const startAtIso = `${date}T${fromTime}${fromTime.length === 5 ? ":00" : ""}+03:00`;');
  prep.func = midnightReplace(prep.func, 'timeFrom: `${date}T${fromTime}:00+03:00`,', 'timeFrom: `${date}T${fromTime}${fromTime.length === 5 ? ":00" : ""}+03:00`,');
  prep.func = midnightReplace(prep.func, 'timeTo: `${date}T${toTime}:00+03:00`,', 'timeTo: `${splitCreateEndDate({ date, fromTime, toTime })}T${toTime}${toTime.length === 5 ? ":00" : ""}+03:00`,');
  const split = nodes.split;
  split.func = midnightReplace(split.func, 'const targetStart = `${ctx.date}T${ctx.fromTime}:00+03:00`;', 'const targetStart = `${ctx.date}T${ctx.fromTime}${ctx.fromTime.length === 5 ? ":00" : ""}+03:00`;');
  split.func = midnightReplace(split.func, 'const targetEnd = `${ctx.date}T${ctx.toTime}:00+03:00`;', 'const targetEnd = `${splitCreateEndDate(ctx)}T${ctx.toTime}${ctx.toTime.length === 5 ? ":00" : ""}+03:00`;');
  // All three exact occurrences are one tuple: durable approval fingerprint,
  // prospective preflight target and sole provider POST. Never change only POST.
  split.func = midnightReplace(split.func, 'timeTo: `${ctx.date}T${ctx.toTime}+03:00`,', 'timeTo: `${splitCreateEndDate(ctx)}T${ctx.toTime}+03:00`,', 3);
  nodes.finalize.func = midnightReplace(nodes.finalize.func, 'target?.timeTo === `${split.date}T${split.toTime}+03:00`;', 'target?.timeTo === `${splitCreateEndDate(split)}T${split.toTime}+03:00`;');
  const preview = nodes.preview;
  const tracked = read('nodered_subscription_price_preview_nodes/router.js');
  const start = '  // Clubs close at 00:00.';
  const end = '    // Derive bounded shape only.';
  if (tracked.split(start).length !== 2 || tracked.split(end).length !== 2) throw Error('MIDNIGHT_RELEASE_SOURCE_DRIFT');
  const guard = tracked.slice(tracked.indexOf(start), tracked.indexOf(end));
  preview.func = midnightReplace(preview.func, "  // Current CREATE binds a single local date to both ends. Do not invent a cross-day tariff here.\n  if (localEnd.slice(0, 10) !== ctx.target.startsAt.slice(0, 10)) {\n", guard);
  // Preserve exact reviewed observer/runtime/schema bundle and lifecycle. Rebind
  // only the fixed release and observed-function identity, never raw context.
  if (sha(preview.initialize || '') !== '41e10f67f5f966e3a28e29cc15f8b5e60af2ec9063d435faf9bfa425be67a89a'
    || sha(preview.finalize || '') !== '8ed42bff21b56b50ee1926385981d76c626f6d5402a99e592660e00ad5d38df1'
    || JSON.stringify(preview.libs) !== JSON.stringify([{ var: 'preview350Crypto', module: 'crypto' }, { var: 'preview350Performance', module: 'perf_hooks' }])) throw Error('MIDNIGHT_RELEASE_OBSERVER_DRIFT');
  const originalSource = '1139b85ce9bfe126a87cb2b705e92bd64d57a7f81d5af5708ebcd504446f42a3';
  const originalRelease = '20e8190ee862678a2c3f18f372b36375f8594346';
  const sourceHash = sha(preview.func);
  for (const quote of ["'", '"']) {
    preview.initialize = midnightReplace(preview.initialize, quote + originalSource + quote, quote + sourceHash + quote);
    preview.initialize = midnightReplace(preview.initialize, quote + originalRelease + quote, quote + release + quote);
  }
  for (const n of Object.values(nodes)) for (const key of ['func', 'initialize', 'finalize']) new Function(n[key] || '');
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const allowedChanges = Object.entries(nodes).map(([key, n]) => ({ id: n.id, fields: key === 'preview' ? ['func', 'initialize'] : ['func'] }));
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'booking-midnight-377', allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { sourceSha256: sha(liveBytes), candidateSha256: sha(candidateBytes), sourceCommit: release,
    changedNodeCount: 4, addedNodeCount: 0, allowedChanges, sourceHash,
    observerSchemaSha256: '5794345145cc4c443208ea611a1e864f58d4e69daad42a22320255d24e6a21e1',
    observerBundleSha256: '91b2b91b4c8fefc29f03207c567035a948068fc62bc7a47e45a77c71f7cfe183',
    targetFields: Object.fromEntries(Object.entries(nodes).map(([key, n]) => [key, { func: sha(n.func), initialize: sha(n.initialize || ''), finalize: sha(n.finalize || ''), libs: n.libs || [] }])),
    topologyChanged: false, workerChanged: false, settingsChanged: false, packageInstallRequired: false, liveMutationPerformed: false } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, expectedSourceSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.dirname(root);
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('MIDNIGHT_RELEASE_CLEAN_HEAD_REQUIRED');
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory || directory.startsWith(repository + '/')
    || directory === repository || directory === verified.workspace || directory.startsWith(verified.workspace + '/')
    || (fs.statSync(directory).mode & 0o077)) throw Error('MIDNIGHT_RELEASE_PRIVATE_OUTPUT_REQUIRED');
  const packet = composeBookingMidnightRelease(fs.readFileSync(verified.sourcePath), { release, expectedSourceSha256 });
  for (const [name, data] of [['candidate.flow.json', packet.candidateBytes], ['contract.json', JSON.stringify(packet.contract, null, 2)], ['report.json', JSON.stringify(packet.report, null, 2)]]) {
    fs.writeFileSync(path.join(directory, name), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(packet.report));
}
