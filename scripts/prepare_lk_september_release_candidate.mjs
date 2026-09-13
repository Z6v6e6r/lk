import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeGroupEventPaymentUpgrade, GROUP_UPGRADE_TARGETS, hash } from './prepare_group_event_payment_upgrade.mjs';
import { buildRepeatedBookingLeaveCandidate, LEGACY_TARGETS, IDS } from './prepare_repeated_booking_leave_candidate.mjs';
import { LEGACY_CAS_PROFILE } from './lib/repeated_booking_leave_profile.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export function composeSeptemberRelease(liveBytes, deploymentId) {
  const group = composeGroupEventPaymentUpgrade(liveBytes, deploymentId);
  const candidate = buildRepeatedBookingLeaveCandidate(group.candidate, LEGACY_TARGETS, LEGACY_CAS_PROFILE);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const allowedChanges = [...GROUP_UPGRADE_TARGETS, ...LEGACY_TARGETS].map(t => ({
    id: t.id, fields: t.id === IDS.router ? ['func','outputs','wires'] : ['func'],
  }));
  const allowedAdditionIds = [IDS.bind, IDS.persist, IDS.ack, IDS.caught];
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges, allowedAdditionIds });
  validateReviewedFlowContract({liveBytes,candidateBytes,contract});
  return {candidateBytes,contract};
}
export function writeSeptemberRelease(input, output, deploymentId) {
  if (!path.isAbsolute(input || '') || !path.isAbsolute(output || '') || fs.existsSync(output)
    || path.resolve(output) !== output || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) {
    throw new Error('Use absolute input and a new canonical private output directory');
  }
  try {
    execFileSync('git',['rev-parse','--git-dir'],{cwd:path.dirname(output),stdio:'pipe'});
    throw new Error('Raw output must stay outside Git');
  } catch(error) {
    if(error.status!==128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  const liveBytes=fs.readFileSync(input);const {candidateBytes,contract}=composeSeptemberRelease(liveBytes,deploymentId);
  const summary={deploymentId,profile:LEGACY_CAS_PROFILE,sourceSha256:hash(liveBytes),candidateSha256:hash(candidateBytes),
    changedNodes:contract.allowedChanges.length,addedNodes:contract.allowedAdditions.length,liveWrites:0};
  fs.mkdirSync(output,{mode:0o700});
  for(const [file,bytes] of [['candidate.flow.json',candidateBytes],['contract.json',JSON.stringify(contract,null,2)+'\n'],['summary.json',JSON.stringify(summary,null,2)+'\n']]){
    fs.writeFileSync(path.join(output,file),bytes,{mode:0o600,flag:'wx'});
  }
  return summary;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==5) throw new Error('Usage: input-flow new-private-output deployment-id');
  console.log(JSON.stringify(writeSeptemberRelease(...process.argv.slice(2))));
}
