import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  composeProviderAccountAttestation,
  providerAccountAttestationIds,
  PROVIDER_ACCOUNT_ROUTE,
} from './patch_nodered_provider_account_attestation.mjs';
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

// Installed flows.json on lk-primary-147 after JOIN v2 + lk1-one-daily-visit (2026-11-08 13:23 MSK).
export const ATTESTATION_LIVE_SOURCE_SHA256 =
  '99f2d29f5c67ad6955f6623c0c160115c24d0de26f791b3ec61aa5291a094c57';
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

// Facts of the installed graph the additive route relies on. Each one fails closed.
export function assertLiveAttestationFacts(flow) {
  assertFlowArray(flow);
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
    const installed = flow.filter((n) => active(n) && n.type === 'function' && typeof n.func === 'string' && re.test(n.func))
      .map((n) => n.func.match(re)[1]);
    if (!expected || !installed.length || installed.some((value) => value !== expected)) {
      throw new Error('ATTESTATION_LIVE_RULE_PIN_DRIFT');
    }
  }
  // Express registers the new routes last: no existing route may match the path first, or it
  // would receive the delegation and the actor token.
  for (const method of ['post', 'get']) {
    if (flow.some((n) => n.type === 'http in' && typeof n.url === 'string'
      && [method, 'all', 'use'].includes(String(n.method).toLowerCase())
      && routePattern(n.url).test(PROVIDER_ACCOUNT_ROUTE))) {
      throw new Error('ATTESTATION_LIVE_ROUTE_SHADOWED');
    }
  }
}

export function composeProviderAccountAttestationLive(liveBytes, deploymentId,
  expectedSha256 = ATTESTATION_LIVE_SOURCE_SHA256) {
  if (hash(liveBytes) !== expectedSha256) throw new Error('ATTESTATION_LIVE_PREIMAGE_DRIFT');
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  assertLiveAttestationFacts(flow);
  const packet = composeProviderAccountAttestation(liveBytes, deploymentId);
  const { candidate } = packet;
  if (!isDeepStrictEqual(candidate.slice(0, flow.length), flow)) throw new Error('ATTESTATION_LIVE_EXISTING_NODE_CHANGED');
  const added = candidate.slice(flow.length);
  if (!isDeepStrictEqual(added.map((n) => n.id), Object.values(providerAccountAttestationIds))) {
    throw new Error('ATTESTATION_LIVE_ADDITIONS_INVALID');
  }
  for (const [key, name] of [['verify', 'verify'], ['router', 'router'], ['probe', 'probe'], ['sanitize', 'response']]) {
    if (added.find((n) => n.id === providerAccountAttestationIds[key]).func !== providerAccountAttestationSource(name)) {
      throw new Error('ATTESTATION_LIVE_FUNCTION_SOURCE_DRIFT');
    }
  }
  if (added.some((n) => /mongodb|inject|link (in|out)|e-?mail|file|exec|catch/.test(n.type))) {
    throw new Error('ATTESTATION_LIVE_FORBIDDEN_NODE_TYPE');
  }
  validateReviewedFlowContract({ liveBytes, candidateBytes: packet.candidateBytes, contract: packet.contract });
  return packet;
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
    nodeCount: packet.candidate.length, additions: Object.values(providerAccountAttestationIds), changes: 0,
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
