import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { composeGameCreatePreparation, gameCreatePreparationIds }
  from './patch_nodered_game_create_preparation.mjs';
import { gameCreatePreparationSource, gameCreateServiceTable, gameCreateSelectorSha256 }
  from './lib/gameCreatePreparationSource.mjs';
import { extractSubscriptionPricePreviewSource } from './lib/subscriptionPricePreviewSources.mjs';
import { assertFlowArray, verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { assertHubOutputPath } from './patch_live_lk1_hub.mjs';
import { readRepositoryProvenance } from './lib/release-provenance.mjs';
import { validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

// Source-only. Builds the reviewed additive packet for the private CREATE preparation route
// (LK #273) on the installed LK1 graph; never imports, restarts, enables or writes a server.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Installed flows.json on lk-primary-147 after A1 + fpr-start-bootstrap-20261106 (2026-11-07).
export const GAME_CREATE_LIVE_SOURCE_SHA256 =
  '6b8223642d6b5cdd89ddb6190c708145ac9efb26222735ad4e481dbee1ea52f9';
// Live onboarding node whose serviceByStation is the installed station/service authority.
export const GAME_CREATE_LIVE_ONBOARDING_NODE_ID = '22ee96a6857b3a35';
export const GAME_CREATE_ROUTE = '/lk/integrations/v1/game-create-preparations';
const RECEIVER_ADMISSION_IN = 'lk_booked_operation_admission_in_20261021';

const CLOSURE = [
  'scripts/prepare_game_create_preparation_live.mjs',
  'scripts/patch_nodered_game_create_preparation.mjs',
  'scripts/lib/gameCreatePreparationSource.mjs',
  'scripts/lib/subscriptionPricePreviewSources.mjs',
  'scripts/nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js',
  'scripts/nodered_game_create_preparation_nodes/_game_create_preparation_contract.js',
  'scripts/nodered_game_create_preparation_nodes/fn_game_create_preparation_verify.js',
  'scripts/nodered_game_create_preparation_nodes/fn_game_create_preparation_router.js',
  'scripts/nodered_game_create_preparation_nodes/fn_game_create_preparation_response.js',
  'scripts/nodered_lk1_hub_nodes/gateway_hooks.js',
  'scripts/nodered_onboarding_nodes/fn_onboarding_stations.js',
  'scripts/nodered_subscription_price_preview_nodes/router.js',
  'scripts/verify_nodered_source_origin.mjs', 'scripts/lib/release-provenance.mjs',
  'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs',
  'package.json', 'package-lock.json',
];

// Node-RED prefixes a missing leading slash and uses non-strict Express routing: a trailing slash
// and letter case do not separate routes.
const routePattern = (url) => new RegExp('^' + (('/' + url.replace(/^\/+/, '')).replace(/\/+$/, '') || '/')
  .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  .replace(/\/:[^/]+\\\?/g, '(?:/[^/]+)?')
  .replace(/\/:[^/]+/g, '/[^/]+')
  .replace(/\*/g, '.*') + '/?$', 'i');

// Facts of the installed graph that the additive route relies on. Each one fails closed.
export function assertLiveGameCreateFacts(flow) {
  assertFlowArray(flow);
  const disabledTabs = new Set(flow.filter((n) => n.type === 'tab' && n.disabled).map((n) => n.id));
  const active = (n) => n && !n.d && !disabledTabs.has(n.z);

  const onboarding = flow.find((n) => n.id === GAME_CREATE_LIVE_ONBOARDING_NODE_ID);
  if (!active(onboarding) || onboarding.type !== 'function' || typeof onboarding.func !== 'string') {
    throw new Error('CREATE_LIVE_ONBOARDING_MISSING');
  }
  let live;
  try {
    const { source } = extractSubscriptionPricePreviewSource({
      source: onboarding.func, label: 'live onboarding', roots: ['serviceByStation'] });
    live = new Function(source + '\nreturn serviceByStation;')();
  } catch {
    throw new Error('CREATE_LIVE_SERVICE_TABLE_UNREADABLE');
  }
  const stations = Object.keys(gameCreateServiceTable).sort();
  if (!isDeepStrictEqual(Object.keys(live || {}).sort(), stations) || stations.some((id) =>
    live[id].masterServiceId !== gameCreateServiceTable[id].masterServiceId
    || !isDeepStrictEqual(live[id].subServiceIds, [gameCreateServiceTable[id].subServiceId]))) {
    throw new Error('CREATE_LIVE_SERVICE_TABLE_PARITY_INVALID');
  }

  // The admin catalogue reads use the existing LK1 global credential; it must still be produced.
  if (!flow.some((n) => n.type === 'function' && active(n)
    && /global\.set\(\s*['"]vivacrm_access_token['"]/.test(n.func || ''))) {
    throw new Error('CREATE_LIVE_ADMIN_CREDENTIAL_SOURCE_MISSING');
  }
  // Same receiver authentication boundary as the installed admission route.
  if (!active(flow.find((n) => n.id === RECEIVER_ADMISSION_IN && n.type === 'http in'))) {
    throw new Error('CREATE_LIVE_RECEIVER_MISSING');
  }
  // Express registers the new route last: no existing route may match the path first.
  if (flow.some((n) => n.type === 'http in' && typeof n.url === 'string'
    && ['post', 'all', 'use'].includes(String(n.method).toLowerCase())
    && routePattern(n.url).test(GAME_CREATE_ROUTE))) {
    throw new Error('CREATE_LIVE_ROUTE_SHADOWED');
  }
}

export function composeGameCreatePreparationLive(liveBytes, deploymentId,
  expectedSha256 = GAME_CREATE_LIVE_SOURCE_SHA256) {
  if (hash(liveBytes) !== expectedSha256) throw new Error('CREATE_LIVE_PREIMAGE_DRIFT');
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  assertLiveGameCreateFacts(flow);
  const packet = composeGameCreatePreparation(liveBytes, deploymentId);
  const { candidate } = packet;
  // Existing nodes are byte-for-byte unchanged and stay in order; additions are the suffix.
  if (!isDeepStrictEqual(candidate.slice(0, flow.length), flow)) {
    throw new Error('CREATE_LIVE_EXISTING_NODE_CHANGED');
  }
  const added = candidate.slice(flow.length);
  const ids = Object.values(gameCreatePreparationIds);
  if (!isDeepStrictEqual(added.map((n) => n.id), ids)) throw new Error('CREATE_LIVE_ADDITIONS_INVALID');
  for (const [key, name] of [['verify', 'verify'], ['router', 'router'], ['sanitize', 'response']]) {
    if (added.find((n) => n.id === gameCreatePreparationIds[key]).func !== gameCreatePreparationSource(name)) {
      throw new Error('CREATE_LIVE_FUNCTION_SOURCE_DRIFT');
    }
  }
  if (added.some((n) => ['mongodb4', 'mongodb out', 'mongodb in', 'inject', 'link out', 'link in'].includes(n.type))) {
    throw new Error('CREATE_LIVE_FORBIDDEN_NODE_TYPE');
  }
  validateReviewedFlowContract({ liveBytes, candidateBytes: packet.candidateBytes, contract: packet.contract });
  return packet;
}

// The live onboarding table is read through the TypeScript extractor: pin the installed parser.
function typescriptVersion() {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const locked = read('package-lock.json').packages?.['node_modules/typescript']?.version;
  const installed = read('node_modules/typescript/package.json').version;
  if (!locked || installed !== locked) throw new Error('Installed typescript differs from package-lock.json');
  return installed;
}

function provenance() {
  const identity = readRepositoryProvenance(ROOT);
  if (identity.sourceDirty) throw new Error('Commit the exact CREATE preparation source before packet generation');
  return { ...identity, typescriptVersion: typescriptVersion(), sourceFiles: Object.fromEntries(CLOSURE.map((file) =>
    [file, hash(fs.readFileSync(path.join(ROOT, file)))])) };
}

export function prepareGameCreatePreparationLive(workspace, outputDirectory) {
  const output = assertHubOutputPath(outputDirectory);
  const source = provenance();
  const verified = verifyWorkspace(workspace, { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (hash(liveBytes) !== verified.sourceSha256) throw new Error('Verified CREATE preparation source changed');
  const packet = composeGameCreatePreparationLive(liveBytes,
    'game-create-preparation-' + source.sourceCommit.slice(0, 12));
  if (!isDeepStrictEqual(source, provenance())) throw new Error('CREATE preparation source changed during composition');
  const contractText = JSON.stringify(packet.contract, null, 2) + '\n';
  const report = { ...source, sourceSha256: hash(liveBytes), candidateSha256: hash(packet.candidateBytes),
    contractSha256: hash(contractText), contractKind: 'exact-graph', deploymentId: packet.contract.deploymentId,
    nodeCount: packet.candidate.length, additions: Object.values(gameCreatePreparationIds), changes: 0,
    route: GAME_CREATE_ROUTE, selectorRevision: gameCreateSelectorSha256, sourceOnly: true,
    activationAuthorized: false, imported: false, providerWritesPerformed: false };
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
    console.log(JSON.stringify(prepareGameCreatePreparationLive(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
