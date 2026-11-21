// Dependency-free server validation. Offline AST/dependency review precedes approval
// of the exact whole-source digest; the runtime never loads TypeScript or business code.
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { canonicalFlowSha256, sha256 } from './runtime_contract.mjs';

const approved = JSON.parse(fs.readFileSync(new URL('../legacy_startup_retirement/bindings.json', import.meta.url), 'utf8'));
export const RETIREMENT_KIND = 'legacy-startup-retirement';
export const RETIREMENT_ROLLBACK_POLICY = 'forbid-source-restore';
export const RETIREMENT_SOURCE_FILES = Object.freeze([
  'nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs',
  'nodered_reviewed_flow_deploy/legacy_retirement_contract.mjs',
  'nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs',
  'nodered_reviewed_flow_deploy/runtime_contract.mjs',
  'legacy_startup_retirement/bindings.json',
]);
export const retirementOperationSourceHashes = () => Object.fromEntries(RETIREMENT_SOURCE_FILES.map(name => [name,
  sha256(fs.readFileSync(new URL(`../${name}`, import.meta.url)))]));
const check = (ok, code) => { if (!ok) throw new Error(code); };
const digest = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const nodeHash = n => sha256(JSON.stringify(canonical(n)));

export function buildLegacyRetirementContract({ sourceBytes, candidateBytes, deploymentId, target, preparedAtMs, validUntilMs, operationSourceSha256, bindings = approved }) {
  check(typeof deploymentId === 'string' && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(deploymentId), 'RETIREMENT_DEPLOYMENT_ID');
  check(target && isDeepStrictEqual(Object.keys(target).sort(), ['hostAlias', 'machineIdSha256', 'pid', 'restartCount', 'runtimeFingerprintSha256'])
    && target.hostAlias === 'lk-primary-147' && digest(target.machineIdSha256)
    && digest(target.runtimeFingerprintSha256)
    && Number.isSafeInteger(target.pid) && target.pid > 0 && Number.isSafeInteger(target.restartCount) && target.restartCount >= 0, 'RETIREMENT_TARGET');
  check(Number.isSafeInteger(preparedAtMs) && preparedAtMs >= 0 && Number.isSafeInteger(validUntilMs)
    && validUntilMs > preparedAtMs && validUntilMs - preparedAtMs <= 30 * 60 * 1000, 'RETIREMENT_FRESHNESS_WINDOW');
  check(operationSourceSha256 && isDeepStrictEqual(Object.keys(operationSourceSha256).sort(), [...RETIREMENT_SOURCE_FILES].sort())
    && Object.values(operationSourceSha256).every(digest), 'RETIREMENT_OPERATION_SOURCE_SET');
  let source, candidate;
  try { source = JSON.parse(Buffer.from(sourceBytes).toString('utf8')); candidate = JSON.parse(Buffer.from(candidateBytes).toString('utf8')); }
  catch { throw new Error('RETIREMENT_INVALID_JSON'); }
  canonicalFlowSha256(source); canonicalFlowSha256(candidate);
  check(bindings && isDeepStrictEqual(Object.keys(bindings).sort(), Object.keys(approved).sort()), 'RETIREMENT_BINDING_SET');
  const ids = new Set(), identities = new Set(), removed = [];
  for (const [role, expected] of Object.entries(approved)) {
    const pin = bindings[role];
    check(pin && pin.type === expected.type && digest(pin.identityHash) && digest(pin.nodeSha256) && !identities.has(pin.identityHash), 'RETIREMENT_BINDING');
    identities.add(pin.identityHash);
    const matches = source.filter(n => sha256(n.id) === pin.identityHash);
    check(matches.length === 1 && matches[0].type === pin.type && nodeHash(matches[0]) === pin.nodeSha256, 'RETIREMENT_PREIMAGE');
    ids.add(matches[0].id); removed.push({ role, ...pin });
  }
  const retained = source.filter(n => !ids.has(n.id));
  check(isDeepStrictEqual(candidate, retained), 'RETIREMENT_EXACT_FILTER_ONLY');
  for (const n of retained) check(![...ids].some(id => JSON.stringify(n).includes(id)), 'RETIREMENT_EXTERNAL_REFERENCE');
  return {
    formatVersion: 3, contractKind: RETIREMENT_KIND, rollbackPolicy: RETIREMENT_ROLLBACK_POLICY,
    deploymentId, target: { ...target }, preparedAtMs, validUntilMs,
    operationSourceSha256: { ...operationSourceSha256 },
    sourceSha256: sha256(sourceBytes), candidateSha256: sha256(candidateBytes),
    candidateCanonicalSha256: canonicalFlowSha256(candidate), sourceNodeCount: source.length,
    candidateNodeCount: candidate.length, removed, retainedNodesUnchanged: true,
    sourceAudit: 'offline-AST-reviewed-exact-whole-source',
  };
}

export function validateLegacyRetirementContract({ sourceBytes, candidateBytes, contract, bindings = approved }) {
  check(contract?.formatVersion === 3 && contract.contractKind === RETIREMENT_KIND
    && contract.rollbackPolicy === RETIREMENT_ROLLBACK_POLICY, 'RETIREMENT_CONTRACT_KIND');
  const rebuilt = buildLegacyRetirementContract({ sourceBytes, candidateBytes, deploymentId: contract.deploymentId,
    target: contract.target, preparedAtMs: contract.preparedAtMs, validUntilMs: contract.validUntilMs,
    operationSourceSha256: contract.operationSourceSha256, bindings });
  check(isDeepStrictEqual(rebuilt, contract), 'RETIREMENT_CONTRACT_DRIFT');
  return rebuilt;
}
