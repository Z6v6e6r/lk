import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  composeProviderAccountAttestation,
  providerAccountAttestationGameIds,
  providerAccountAttestationIds,
  PROVIDER_ACCOUNT_GAMES_CLIENT,
  PROVIDER_ACCOUNT_ROUTE,
} from './patch_nodered_provider_account_attestation.mjs';
import { buildExactGraphContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { providerAccountAttestationSource } from './lib/providerAccountAttestationSource.mjs';
import { assertFlowArray, verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { assertHubOutputPath } from './patch_live_lk1_hub.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
import { validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

// Source-only. Builds the reviewed additive packet for the read-only provider-account
// attestation route (LK #303 + #304) on the installed LK1 graph. Never imports, restarts,
// enables the flag or writes a server.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Installed flows.json on lk-primary-147 after the attestation install (#305, 2026-11-08 22:45 MSK):
// the reviewed candidate 0f6590d4 itself, so the nine installed attestation nodes are pinned too.
export const ATTESTATION_LIVE_SOURCE_SHA256 =
  '0f6590d4a69b16e69b6c6cdf77075de114b207e08abcbab623fb740b5a9af97b';
// Upgrade (legacyGameId target): only these fields of the installed nodes may change.
const UPGRADE_CHANGES = Object.freeze({
  [providerAccountAttestationIds.verify]: ['func'],
  [providerAccountAttestationIds.router]: ['func', 'outputs', 'wires'],
  [providerAccountAttestationIds.probe]: ['func'],
  [providerAccountAttestationIds.sanitize]: ['func'],
});
const RECEIVER_ADMISSION_IN = 'lk_booked_operation_admission_in_20261021';

const CLOSURE = [
  'scripts/prepare_provider_account_attestation_live.mjs',
  'scripts/patch_nodered_provider_account_attestation.mjs',
  'scripts/lib/providerAccountAttestationSource.mjs',
  'scripts/lib/subscriptionPricePreviewSources.mjs',
  'scripts/nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js',
  'scripts/nodered_provider_account_attestation_nodes/_provider_account_attestation_contract.js',
  'scripts/nodered_provider_account_attestation_nodes/fn_provider_account_attestation_verify.js',
  'scripts/nodered_provider_account_attestation_nodes/fn_provider_account_attestation_router.js',
  'scripts/nodered_provider_account_attestation_nodes/fn_provider_account_attestation_response.js',
  'scripts/nodered_provider_account_attestation_nodes/fn_provider_account_attestation_probe.js',
  'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
  'scripts/nodered_lk1_hub_nodes/gateway.js',
  'scripts/verify_nodered_source_origin.mjs', 'scripts/lib/release-provenance.mjs',
  'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs',
  'package.json', 'package-lock.json',
];

// Node-RED prefixes a missing leading slash and routes through non-strict, case-insensitive
// Express: a trailing slash, letter case, a parameter or a wildcard do not separate routes.
export const routePattern = (url) => new RegExp('^' + (('/' + url.replace(/^\/+/, '')).replace(/\/+$/, '') || '/')
  .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  .replace(/\/:[^/]+\\\?/g, '(?:/[^/]+)?')
  .replace(/\/:[^/]+/g, '/[^/]+')
  .replace(/\*/g, '.*') + '/?$', 'i');

// Express 4 passes regex groups, quantifiers and mid-segment parameters through to the route
// regex; routePattern cannot model them, so such a route counts as shadowing (fail closed).
export const opaqueRoute = (url) => /[()+]|[^/]:|\?(?<!:[A-Za-z0-9_]+\?)/.test(url.replace(/\/:[A-Za-z0-9_]+\??/g, '/P'));

// Facts of the installed graph the additive route relies on. Each one fails closed.
export function assertLiveAttestationFacts(flow) {
  assertFlowArray(flow);
  // The legacy-game lookup reads lk_games through the existing games database client.
  const client = flow.find((n) => n.id === PROVIDER_ACCOUNT_GAMES_CLIENT);
  if (!client || client.type !== 'mongodb4-client' || client.dbName !== 'games' || client.d) {
    throw new Error('ATTESTATION_LIVE_GAMES_CLIENT_MISSING');
  }
  const disabledTabs = new Set(flow.filter((n) => n.type === 'tab' && n.disabled).map((n) => n.id));
  const active = (n) => n && !n.d && !disabledTabs.has(n.z);
  // The same delegation boundary as the installed receiver.
  if (!active(flow.find((n) => n.id === RECEIVER_ADMISSION_IN && n.type === 'http in'))) {
    throw new Error('ATTESTATION_LIVE_RECEIVER_MISSING');
  }
  // The HUB JOIN pins compiled into the router must equal what the installed money gate and
  // booking owner enforce.
  const router = providerAccountAttestationSource('router');
  for (const name of ['LK1_OVERLAY_HUB_PRODUCT_ID', 'MANAGED_ENFORCEMENT_PURCHASE_FROM']) {
    const re = new RegExp('const ' + name + ' = "([^"]+)"');
    const expected = router.match(re)?.[1];
    const declared = new RegExp('\\b(?:let|var|const)\\s+' + name + '\\b');
    const functions = flow.filter((n) => active(n) && n.type === 'function' && typeof n.func === 'string');
    const installed = functions.filter((n) => re.test(n.func)).map((n) => n.func.match(re)[1]);
    // Any other declaration form is unreadable here and refuses.
    const unreadable = functions.some((n) => (n.func.match(new RegExp(declared.source, 'g')) || []).length
      !== (n.func.match(new RegExp(re.source, 'g')) || []).length);
    if (!expected || !installed.length || unreadable || installed.some((value) => value !== expected)) {
      throw new Error('ATTESTATION_LIVE_RULE_PIN_DRIFT');
    }
  }
  // Express registers the new routes last: no existing route may match the path first, or it
  // would receive the delegation and the actor token.
  for (const method of ['post', 'get']) {
    if (flow.some((n) => n.type === 'http in' && typeof n.url === 'string'
      && [method, 'all', 'use'].includes(String(n.method).toLowerCase())
      && (routePattern(n.url).test(PROVIDER_ACCOUNT_ROUTE) || opaqueRoute(n.url)))) {
      throw new Error('ATTESTATION_LIVE_ROUTE_SHADOWED');
    }
  }
}

const installedIds = new Set(Object.values(providerAccountAttestationIds));
const isInstalled = (n) => installedIds.has(n.id) || n.z === providerAccountAttestationIds.tab;

export function composeProviderAccountAttestationLive(liveBytes, deploymentId,
  expectedSha256 = ATTESTATION_LIVE_SOURCE_SHA256) {
  if (hash(liveBytes) !== expectedSha256) throw new Error('ATTESTATION_LIVE_PREIMAGE_DRIFT');
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  const installed = flow.filter(isInstalled);
  const remainder = flow.filter((n) => !isInstalled(n));
  // Facts and collisions are checked on the graph without the installed attestation tab.
  assertLiveAttestationFacts(remainder);
  if (!isDeepStrictEqual(installed.map((n) => n.id), Object.values(providerAccountAttestationIds))
    || !isDeepStrictEqual(flow.slice(0, remainder.length), remainder)) {
    throw new Error('ATTESTATION_LIVE_INSTALLED_SHAPE_INVALID');
  }
  const fresh = composeProviderAccountAttestation(Buffer.from(JSON.stringify(remainder, null, 2) + '\n'), deploymentId);
  const target = new Map(fresh.candidate.slice(remainder.length).map((n) => [n.id, n]));
  const allowedChanges = [];
  const upgraded = installed.map((node) => {
    const next = target.get(node.id);
    const fields = [...new Set([...Object.keys(node), ...Object.keys(next)])]
      .filter((k) => !isDeepStrictEqual(node[k], next[k])).sort();
    if (!isDeepStrictEqual(fields, [...(UPGRADE_CHANGES[node.id] ?? [])].sort())) {
      throw new Error('ATTESTATION_LIVE_UNEXPECTED_CHANGE:' + node.id + ':' + fields.join('+'));
    }
    if (fields.length) allowedChanges.push({ id: node.id, fields });
    return next;
  });
  const additions = Object.values(providerAccountAttestationGameIds).map((id) => target.get(id));
  const candidate = [...remainder, ...upgraded, ...additions];
  for (const [key, name] of [['verify', 'verify'], ['router', 'router'], ['probe', 'probe'], ['sanitize', 'response']]) {
    if (candidate.find((n) => n.id === providerAccountAttestationIds[key]).func !== providerAccountAttestationSource(name)) {
      throw new Error('ATTESTATION_LIVE_FUNCTION_SOURCE_DRIFT');
    }
  }
  const mongo = additions.filter((n) => /mongodb/.test(n.type));
  if (mongo.length !== 1 || mongo[0].operation !== 'find' || mongo[0].collection !== 'lk_games'
    || mongo[0].clientNode !== PROVIDER_ACCOUNT_GAMES_CLIENT
    || additions.some((n) => /inject|link (in|out)|e-?mail|file|exec/.test(n.type))) {
    throw new Error('ATTESTATION_LIVE_FORBIDDEN_NODE_TYPE');
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges,
    allowedAdditionIds: additions.map((n) => n.id) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, allowedChanges, selectorRevision: fresh.selectorRevision };
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
  if (identity.sourceDirty) throw new Error('Commit the exact attestation source before packet generation');
  return { ...identity, typescriptVersion: typescriptVersion(), sourceFiles: Object.fromEntries(CLOSURE.map((file) =>
    [file, hash(fs.readFileSync(path.join(ROOT, file)))])) };
}

export function prepareProviderAccountAttestationLive(workspace, outputDirectory) {
  const output = assertHubOutputPath(outputDirectory);
  const source = provenance();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (hash(liveBytes) !== verified.sourceSha256) throw new Error('Verified attestation source changed');
  const packet = composeProviderAccountAttestationLive(liveBytes,
    'provider-account-attestation-' + source.sourceCommit.slice(0, 12));
  if (!isDeepStrictEqual(source, provenance())) throw new Error('Attestation source changed during composition');
  const contractText = JSON.stringify(packet.contract, null, 2) + '\n';
  const report = { ...source, sourceSha256: hash(liveBytes), candidateSha256: hash(packet.candidateBytes),
    contractSha256: hash(contractText), contractKind: 'exact-graph', deploymentId: packet.contract.deploymentId,
    nodeCount: packet.candidate.length, additions: Object.values(providerAccountAttestationGameIds),
    changes: packet.allowedChanges,
    route: PROVIDER_ACCOUNT_ROUTE, selectorRevision: packet.selectorRevision, flag: 'LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED',
    sourceOnly: true, activationAuthorized: false, imported: false, providerWritesPerformed: false };
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
    console.log(JSON.stringify(prepareProviderAccountAttestationLive(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
