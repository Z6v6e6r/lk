import { isDeepStrictEqual } from 'node:util';

export function assertUnpaidWorkerIdentity(snapshot) {
  const p = snapshot.properties;
  if (p.ActiveState !== 'active' || p.SubState !== 'running' || !/^[1-9][0-9]*$/.test(p.MainPID || '')
    || p.FragmentPath !== '/etc/systemd/system/lk1-unpaid-cancel.service' || p.DropInPaths !== ''
    || p.NeedDaemonReload !== 'no' || p.WorkingDirectory !== '/opt/padlhub-lk1-unpaid-cancel/current'
    || p.EnvironmentFiles !== '/etc/padlhub/lk1-unpaid-cancel.env (ignore_errors=yes)'
    || snapshot.cwd !== snapshot.releasePath || snapshot.executable !== snapshot.expectedExecutable
    || !isDeepStrictEqual(snapshot.argv, ['/usr/local/bin/node', '/opt/padlhub-lk1-unpaid-cancel/current/launch_lk1_unpaid_booking_cancellation.mjs', '--run'])
    || !Object.entries(snapshot.config).every(([key, value]) => snapshot.processEnvironment[key] === value)
    || !p.ExecStart.includes('path=/usr/local/bin/node ; argv[]=/usr/local/bin/node /opt/padlhub-lk1-unpaid-cancel/current/launch_lk1_unpaid_booking_cancellation.mjs --run ;')) {
    throw new Error('RUNNING_WORKER_IDENTITY_MISMATCH');
  }
  // Never return processEnvironment or raw ExecStart (which may contain secrets
  // in an unexpected unit). Only fixed paths, hashes and process identity escape.
  return { pid: Number(p.MainPID), startedAt: snapshot.startedAt, releasePath: snapshot.releasePath,
    unitSha256: snapshot.unitSha256, environmentSha256: snapshot.environmentSha256,
    manifestSha256: snapshot.manifestSha256, fragmentPath: p.FragmentPath, dropIns: 0,
    effectiveConfigurationMatches: true };
}
