import { composeLegacyStartupRetirement } from './prepare_legacy_startup_retirement.mjs';
import { buildLegacyRetirementContract, retirementOperationSourceHashes } from './nodered_reviewed_flow_deploy/legacy_retirement_contract.mjs';

// Offline packet composition; never fetches live data, stages to a server, or runs a command.
export function prepareLegacyStartupRetirementRelease({ sourceBytes, expectedSourceSha256, deploymentId,
  target, preparedAtMs, validUntilMs, bindings } = {}) {
  const composed = composeLegacyStartupRetirement(sourceBytes, { expectedSourceSha256, bindings });
  const contract = buildLegacyRetirementContract({ sourceBytes, candidateBytes: composed.candidateBytes,
    deploymentId, target, preparedAtMs, validUntilMs, operationSourceSha256: retirementOperationSourceHashes(), bindings });
  return { ...composed, contract, contractBytes: Buffer.from(`${JSON.stringify(contract, null, 2)}\n`),
    plan: { sourceRestoreAllowed: false, liveMutationAuthorized: false, applyRequiresSeparateApproval: true,
      sharedLock: 'padlhub-reviewed-flow-deploy', failurePolicy: 'forward-only-owner-reconciliation',
      postcheck: 'fresh-native-runtime-canonical-graph-and-readiness-after-15-minute-soak' } };
}
