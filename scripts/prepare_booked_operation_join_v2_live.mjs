import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { buildReceiverCandidate, NODE_IDS, TAB_ID, ROUTES, COLLECTION }
  from './patch_nodered_booked_operation_receiver_flow.mjs';
import { assertFlowArray, verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { assertHubOutputPath } from './patch_live_lk1_hub.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

// Source-only. Upgrades the installed LK2 booked-operation receiver (built at 57648b82) to the
// main receiver with the managed JOIN v2 routes, and lets the owner probe advertise contract 2.
// Never imports, restarts, provisions globals/env or writes a server.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Installed flows.json on lk-primary-147 after lk1-spanish-training-subscriptions-20261107.
export const JOIN_V2_LIVE_SOURCE_SHA256 = 'be3177e477153364b31b3e3d83e99441cff64869db8c9acc98fb002d62ffdec1';
export const JOIN_V2_RECEIVER_BASE_COMMIT = '57648b82727f7f74ef86637ea8ce9b70416d9e0a';
// Installed receiver function sources, byte-equal to the receiver build at the base commit.
export const JOIN_V2_RECEIVER_LIVE_FUNC_SHA256 = Object.freeze({
  [NODE_IDS.admissionVerify]: 'b5991ba820b3a0bbdd6fc9f93752b2117ef6721f9246974423bef8671342a650',
  [NODE_IDS.readVerify]: 'c4941d2d3752af273512e1bd00cd14dafaed72a8e5f42ebf4391fa58b5013d45',
  [NODE_IDS.router]: 'e001978df104c6f921fa1d6bf3a79dcc4d25f984855e83b3d7eef6b90fd234c9',
  [NODE_IDS.executor]: '5c6f8acf6dea6a8a72d6f505b8d50587bb0b9d6c0274be7cccbf7e36fd422905',
  [NODE_IDS.respond]: '05e7ae743ec126e08aa56749c603927767fd0a2694d98f180f673e5d1e9674d1',
});
export const OWNER_ROUTER_ID = 'lk_subscription_booking_router_20260804';
export const OWNER_ROUTER_LIVE_FUNC_SHA256 = 'b0f1b30966451e246854177fcdee6e0fd8c24f30efcad2c4b25d309642dc9014';
export const RECEIVER_MONGO_CLIENT_ID = '4e820638cc39c730';
// A1 installed only probe contract 1 (scripts/lib/bookedOperationOwnerLiveRebase.mjs).
export const PROBE_INSTALLED = '["1"].includes(ownerProbeVersion) /* 2 needs the JOIN v2 receiver, 3 the SELF leave graph */';
export const PROBE_JOIN_V2 = '["1", "2"].includes(ownerProbeVersion) /* 3 needs the SELF leave graph */';

// Advertising contract 2 is a promise that the installed owner enforces MANAGED_JOIN_V2: legacy and
// recovery-only calls never reserve or book, and a v2 booking needs the confirmed CUP entitlement.
// These statements (main fn_subscription_booking_router/prepare) must be present before the flip.
export const OWNER_PREPARE_ID = 'lk_subscription_booking_prepare_20260804';
export const OWNER_V2_GUARDS = Object.freeze({
  [OWNER_ROUTER_ID]: Object.freeze([
    'if (ctx.lk2LegacyJoin === true || ctx.managedJoinV2RecoveryOnly || ctx.managedJoinV2RecoveryOperation) return managedJoinV2Pending(ctx);',
    'if (ctx.managedJoinV2RecoveryOnly || ctx.managedJoinV2RecoveryOperation) return managedJoinV2Pending(ctx);',
    'if (ctx.lk2LegacyJoin === true && ctx.managedEnforcement?.enabled === true) return managedJoinV2Pending(ctx);',
    '|| !toStr(ctx.managedEntitlementOperationId) || !validEntitlementDecision(ctx, ctx.managedDecision)',
    '|| ctx.managedDecision.money.finalPriceMinor !== 0 || !managedJoinV2Positive(ctx.managedDecision.usageUnits))) {',
    'if (ctx.lk2LegacyJoin !== undefined && (ctx.lk2LegacyJoin !== true || ctx.managedJoinV2 !== undefined)) return managedJoinV2Pending(ctx);',
  ]),
  [OWNER_PREPARE_ID]: Object.freeze([
    'if (body.managedJoinV2RecoveryOnly !== undefined && (!recoveryOnly || body.managedJoinV2 === undefined))',
    '|| action !== "book" || Object.keys(body).sort().join(",") !== "clientSubscriptionId,exerciseId,lk2LegacyJoin,operationId"',
  ]),
});

// Exactly these installed receiver fields move to main; anything else is drift.
const EXPECTED_RECEIVER_CHANGES = Object.freeze({
  [NODE_IDS.admissionVerify]: ['func'],
  [NODE_IDS.readVerify]: ['func'],
  [NODE_IDS.router]: ['func', 'libs'],
  [NODE_IDS.executor]: ['func'],
  [NODE_IDS.respond]: ['func'],
  [NODE_IDS.catch]: ['scope'],
});
export const JOIN_V2_ADDITION_IDS = Object.freeze([
  NODE_IDS.admissionV2In, NODE_IDS.readV2In, NODE_IDS.preflightIn,
  NODE_IDS.preflightVerify, NODE_IDS.preflightRouter, NODE_IDS.preflightRequest,
]);
const POSITIONAL = new Set(['x', 'y']);

const CLOSURE = [
  'scripts/prepare_booked_operation_join_v2_live.mjs',
  'scripts/patch_nodered_booked_operation_receiver_flow.mjs',
  'scripts/lib/subscriptionPricePreviewSources.mjs',
  'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
  'scripts/verify_nodered_source_origin.mjs', 'scripts/lib/release-provenance.mjs',
  'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs',
  'package.json', 'package-lock.json',
  ...fs.readdirSync(path.join(ROOT, 'scripts/nodered_booked_operation_receiver_nodes'))
    .filter((file) => file.endsWith('.js')).sort()
    .map((file) => 'scripts/nodered_booked_operation_receiver_nodes/' + file),
];

const routePattern = (url) => new RegExp('^' + (('/' + url.replace(/^\/+/, '')).replace(/\/+$/, '') || '/')
  .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  .replace(/\/:[^/]+\\\?/g, '(?:/[^/]+)?')
  .replace(/\/:[^/]+/g, '/[^/]+')
  .replace(/\*/g, '.*') + '/?$', 'i');

export function composeJoinV2Live(liveBytes, deploymentId, pins = {}) {
  const sourceSha = pins.sourceSha256 ?? JOIN_V2_LIVE_SOURCE_SHA256;
  const receiverPins = pins.receiverFuncSha256 ?? JOIN_V2_RECEIVER_LIVE_FUNC_SHA256;
  const ownerPin = pins.ownerRouterFuncSha256 ?? OWNER_ROUTER_LIVE_FUNC_SHA256;
  const mongoClientId = pins.mongoClientId ?? RECEIVER_MONGO_CLIENT_ID;
  if (hash(liveBytes) !== sourceSha) throw new Error('JOIN_V2_LIVE_PREIMAGE_DRIFT');
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  assertFlowArray(flow);

  // Installed receiver: exact base sources, one Mongo client, no foreign edges into the tab.
  const installed = flow.filter((n) => n.z === TAB_ID);
  if (!flow.some((n) => n.id === TAB_ID && n.type === 'tab')) throw new Error('JOIN_V2_RECEIVER_TAB_MISSING');
  for (const [id, expected] of Object.entries(receiverPins)) {
    const node = installed.find((n) => n.id === id);
    if (node?.type !== 'function' || hash(node.func) !== expected) throw new Error('JOIN_V2_RECEIVER_SOURCE_DRIFT: ' + id);
  }
  if (installed.some((n) => JOIN_V2_ADDITION_IDS.includes(n.id))) throw new Error('JOIN_V2_ALREADY_INSTALLED');
  if (!isDeepStrictEqual([...new Set(installed.filter((n) => n.type === 'mongodb4').map((n) => n.clientNode))], [mongoClientId])) {
    throw new Error('JOIN_V2_RECEIVER_STORE_DRIFT');
  }
  const installedIds = new Set(installed.map((n) => n.id));
  if (flow.some((n) => n.z !== TAB_ID && JSON.stringify([n.wires ?? [], n.scope ?? [], n.links ?? []])
    .match(/"(lk_booked_operation_[a-z0-9_]+)"/g)?.some((m) => installedIds.has(m.slice(1, -1))
      || JOIN_V2_ADDITION_IDS.includes(m.slice(1, -1))))) {
    throw new Error('JOIN_V2_FOREIGN_EDGE');
  }
  // New v2 routes must not be matched first by an existing route outside the receiver.
  for (const url of [ROUTES.preflightV2, ROUTES.admissionV2, ROUTES.readPrefixV2 + 'x']) {
    if (flow.some((n) => n.type === 'http in' && n.z !== TAB_ID && typeof n.url === 'string' && routePattern(n.url).test(url))) {
      throw new Error('JOIN_V2_ROUTE_SHADOWED: ' + url);
    }
  }

  // Canonical main receiver for this graph: the reviewed fresh-install builder on the same graph
  // without the installed receiver. All of its invariants (provider/preflight isolation) apply.
  const stripped = flow.filter((n) => n.z !== TAB_ID && n.id !== TAB_ID);
  const canonical = buildReceiverCandidate(stripped);
  if (canonical.report.mongoClientNodeId !== mongoClientId || canonical.report.collection !== COLLECTION) {
    throw new Error('JOIN_V2_RECEIVER_STORE_DRIFT');
  }
  const target = new Map(canonical.candidate.slice(stripped.length).map((n) => [n.id, n]));
  if (!isDeepStrictEqual([...target.keys()].filter((id) => id !== TAB_ID).sort(),
    [...installedIds, ...JOIN_V2_ADDITION_IDS].sort())) throw new Error('JOIN_V2_RECEIVER_NODE_SET_DRIFT');

  const candidate = structuredClone(flow);
  const allowedChanges = [];
  for (const node of candidate.filter((n) => n.z === TAB_ID || n.id === TAB_ID)) {
    const next = target.get(node.id);
    const fields = [...new Set([...Object.keys(node), ...Object.keys(next)])]
      .filter((key) => !POSITIONAL.has(key) && !isDeepStrictEqual(node[key], next[key])).sort();
    if (!isDeepStrictEqual(fields, [...(EXPECTED_RECEIVER_CHANGES[node.id] ?? [])].sort())) {
      throw new Error('JOIN_V2_RECEIVER_FIELD_DRIFT: ' + node.id + ' ' + fields.join(','));
    }
    for (const key of fields) node[key] = structuredClone(next[key]);
    if (fields.length) allowedChanges.push({ id: node.id, fields });
  }
  candidate.push(...JOIN_V2_ADDITION_IDS.map((id) => structuredClone(target.get(id))));

  // Owner probe: advertise contract 2 now that the v2 receiver exists. SELF leave (3) stays closed.
  const owner = candidate.find((n) => n.id === OWNER_ROUTER_ID);
  if (owner?.type !== 'function' || hash(owner.func) !== ownerPin || owner.func.split(PROBE_INSTALLED).length !== 2) {
    throw new Error('JOIN_V2_OWNER_PROBE_DRIFT');
  }
  for (const [id, guards] of Object.entries(OWNER_V2_GUARDS)) {
    const func = candidate.find((n) => n.id === id && n.type === 'function')?.func ?? '';
    for (const guard of guards) if (!func.includes(guard)) throw new Error('JOIN_V2_OWNER_GUARD_MISSING: ' + id);
  }
  owner.func = owner.func.replace(PROBE_INSTALLED, PROBE_JOIN_V2);
  new Function('msg', 'global', 'node', 'env', owner.func);
  allowedChanges.push({ id: OWNER_ROUTER_ID, fields: ['func'] });

  for (const node of candidate.filter((n) => n.z === TAB_ID && n.type === 'function')) {
    new Function('msg', 'env', 'global', 'nodeCrypto', 'node', node.func);
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges, allowedAdditionIds: [...JOIN_V2_ADDITION_IDS] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, allowedChanges, receiver: canonical.report };
}

function typescriptVersion() {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const locked = read('package-lock.json').packages?.['node_modules/typescript']?.version;
  const installed = read('node_modules/typescript/package.json').version;
  if (!locked || installed !== locked) throw new Error('Installed typescript differs from package-lock.json');
  return installed;
}

function provenance() {
  const identity = readRepositoryProvenance(ROOT);
  if (identity.sourceDirty) throw new Error('Commit the exact JOIN v2 source before packet generation');
  return { ...identity, typescriptVersion: typescriptVersion(), sourceFiles: Object.fromEntries(CLOSURE.map((file) =>
    [file, hash(fs.readFileSync(path.join(ROOT, file)))])) };
}

export function prepareJoinV2Live(workspace, outputDirectory) {
  const output = assertHubOutputPath(outputDirectory);
  const source = provenance();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (hash(liveBytes) !== verified.sourceSha256) throw new Error('Verified JOIN v2 source changed');
  const packet = composeJoinV2Live(liveBytes, 'join-v2-receiver-' + source.sourceCommit.slice(0, 12));
  if (!isDeepStrictEqual(source, provenance())) throw new Error('JOIN v2 source changed during composition');
  const contractText = JSON.stringify(packet.contract, null, 2) + '\n';
  const report = { ...source, receiverBaseCommit: JOIN_V2_RECEIVER_BASE_COMMIT, sourceSha256: hash(liveBytes),
    candidateSha256: hash(packet.candidateBytes), contractSha256: hash(contractText), contractKind: 'exact-graph',
    deploymentId: packet.contract.deploymentId, nodeCount: packet.candidate.length,
    changes: packet.allowedChanges, additions: [...JOIN_V2_ADDITION_IDS],
    routesAdded: [ROUTES.preflightV2, ROUTES.admissionV2, ROUTES.readPrefixV2 + ':operationId'],
    probeContracts: ['1', '2'], sourceOnly: true, activationAuthorized: false, imported: false,
    providerWritesPerformed: false, runtimePrerequisites: packet.receiver.runtimePrerequisites };
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of [['candidate.flow.json', packet.candidateBytes], ['contract.json', contractText],
    ['report.json', JSON.stringify(report, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: <fresh-private-live-workspace> <new-private-output-directory>');
    console.log(JSON.stringify(prepareJoinV2Live(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
