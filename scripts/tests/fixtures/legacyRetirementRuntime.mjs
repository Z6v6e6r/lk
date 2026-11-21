import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { prepareLegacyStartupRetirementRelease } from '../../prepare_legacy_startup_retirement_release.mjs';
import { retirementNodeHash } from '../../prepare_legacy_startup_retirement.mjs';
import { createLegacyRetirementOperation } from '../../nodered_reviewed_flow_deploy/legacy_retirement_operation.mjs';

const scriptRoot = fileURLToPath(new URL('../../', import.meta.url));
const approved = JSON.parse(fs.readFileSync(path.join(scriptRoot, 'legacy_startup_retirement/bindings.json')));
export const hash = x => createHash('sha256').update(x).digest('hex');
export const bytes = x => Buffer.from(`${JSON.stringify(x, null, 2)}\n`);
export function retirementFixture() {
  const cohort = Object.entries(approved).map(([role, p]) => ({ id: `fixture-${role}`, type: p.type,
    ...(p.type === 'inject' ? { once: true, crontab: '* * * * *' } : {}),
    ...(p.type === 'function' ? { func: 'return msg;' } : {}), wires: [] }));
  const flow = [...cohort, { id: 'fixture-retained-route', type: 'http in', url: '/fixture', wires: [[]] },
    { id: 'fixture-retained-function', type: 'function', func: 'return msg;', wires: [[]] }];
  const bindings = Object.fromEntries(cohort.map(n => [n.id.slice(8), { identityHash: hash(n.id), nodeSha256: retirementNodeHash(n), type: n.type }]));
  return { flow, bindings };
}

export function retirementRuntime(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-retirement-test-'))); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const uid = process.getuid(), gid = process.getgid();
  const stage = path.join(root, '.padlhub-reviewed-flow-stage-20261112T180000+0300-123'); fs.mkdirSync(stage, { mode: 0o700 });
  const { flow, bindings } = retirementFixture();
  let time = Date.parse('2026-11-12T15:00:00.000Z'), machine = 'a'.repeat(64), runtimeFingerprint = 'b'.repeat(64);
  let state = { pid: 1000, restartCount: 10, status: 'online' }, restartMode = 'success', restartCalls = 0;
  let hook = () => {};
  const sourceBytes = bytes(flow);
  const prepared = prepareLegacyStartupRetirementRelease({ sourceBytes, expectedSourceSha256: hash(sourceBytes),
    deploymentId: 'fixture-legacy-retirement', target: { hostAlias: 'lk-primary-147', machineIdSha256: machine,
      runtimeFingerprintSha256: runtimeFingerprint, pid: state.pid, restartCount: state.restartCount },
    preparedAtMs: time, validUntilMs: time + 30 * 60 * 1000, bindings });
  const contractSha256 = hash(prepared.contractBytes), backup = path.join(root, '.padlhub-reviewed-flow-backups');
  const op = path.join(backup, `retirement-${contractSha256}`), live = path.join(root, 'flows.json');
  const lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  const write = (p, value) => { fs.writeFileSync(p, Buffer.isBuffer(value) ? value : bytes(value), { mode: 0o600 }); fs.chmodSync(p, 0o600); };
  write(live, sourceBytes); write(path.join(stage, 'candidate.flow.json'), prepared.candidateBytes); write(path.join(stage, 'contract.json'), prepared.contractBytes);
  for (const relative of Object.keys(prepared.contract.operationSourceSha256)) {
    const dest = path.join(stage, 'scripts', relative); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    write(dest, fs.readFileSync(path.join(scriptRoot, relative)));
  }
  const pm2 = {
    inspect: () => ({ ...state }),
    assertOnline() { if (state.status !== 'online' || state.pid <= 0) throw new Error('FIXTURE_PM2_OFFLINE'); return this.inspect(); },
    restart(previous) {
      if (previous !== state.restartCount) throw new Error('FIXTURE_RESTART_COUNTER_DRIFT');
      restartCalls++;
      if (restartMode === 'throw-before') throw new Error('FIXTURE_RESTART_ACK_UNKNOWN');
      state = { pid: state.pid + 1, restartCount: state.restartCount + (restartMode === 'extra-restart' ? 2 : 1), status: 'online' };
      if (restartMode === 'throw-after') throw new Error('FIXTURE_RESTART_ACK_LOST');
      if (restartMode === 'offline') { state.pid = 0; state.status = 'errored'; throw new Error('FIXTURE_PM2_OFFLINE'); }
      return this.inspect();
    },
  };
  const operation = createLegacyRetirementOperation({ stage, contractSha256, stageParent: root, uid, gid,
    getUid: () => uid, now: () => time, randomUUID: () => { hook('FIXTURE_BACKUPS_READY'); return 'fixture-private-lease-token'; }, readMachineId: () => machine,
    readRuntimeFingerprint: () => runtimeFingerprint, pm2, bindings, onTransition: phase => hook(phase) });
  return { root, stage, live, lease, op, backup, operation, pm2, uid, gid, bindings, flow, sourceBytes, ...prepared, contractSha256,
    write, read: p => JSON.parse(fs.readFileSync(p)), advance: ms => { time += ms; }, now: () => time,
    hook: fn => { hook = fn; }, setRestartMode: mode => { restartMode = mode; }, restartCalls: () => restartCalls,
    setMachine: value => { machine = value; }, setRuntimeFingerprint: value => { runtimeFingerprint = value; },
    setProcess: value => { state = { ...state, ...value }; },
    observe(overrides = {}) {
      write(path.join(op, 'postcheck.json'), { observedAtMs: time, contractSha256, pid: state.pid, restartCount: state.restartCount,
        readiness: 'ready', runtimeFlow: prepared.candidate, ...overrides });
    },
  };
}
