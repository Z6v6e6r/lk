import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { assertProtectedFile, assertProtectedFileModes, atomicWrite, recoverAtomicExclusivePublication,
  syncDirectory, writeFileExclusiveAtomicDurable } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { ROOT, RELEASES, LEASE_NAME, sha, processEqual, validProcess, validRecoveryProcess, settingsCandidate,
  transactionDirectory, validateContract } from "./subscription409-contract.mjs";

const json = value => Buffer.from(JSON.stringify(value));
const check = (condition, code) => { if (!condition) throw Error(code); };
const PHASES = ["PREPARED", "RESTART_INTENT", "SOAKING", "ROLLBACK_INTENT", "ROLLBACK_RESTART_INTENT", "ROLLBACK_VERIFIED"];

// Every mutating entrypoint requires a live kernel-lock assertion. Production CLI
// supplies /proc/locks verification; tests inject a fake lock and a fake PM2 adapter.
// No automatic rollback/restart retry: uncertainty retains the durable shared lease.
export function createSubscription409Installer({ root = ROOT, releases = RELEASES,
  uid = 0, gid = 0, machineSha256, assertLock, pm2, now = () => Date.now(),
  onTransition = () => {}, soakMs = 15 * 60_000, registrationTimeoutMs = 30_000, pollMs = 100,
  monotonic = () => performance.now(), wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  check(typeof assertLock === "function" && pm2 && Number.isInteger(soakMs) && soakMs >= 15 * 60_000
    && Number.isInteger(registrationTimeoutMs) && registrationTimeoutMs >= 1000 && registrationTimeoutMs <= 60_000
    && Number.isInteger(pollMs) && pollMs >= 10 && pollMs <= 1000, "INSTALLER_OPTIONS_INVALID");
  const fileOptions = { uid, gid, mode: 0o600 };
  const settings = path.join(root, "settings.js"), flow = path.join(root, "flows.json"), leasePath = path.join(root, LEASE_NAME);
  const protectedDirectory = (dir, exactMode = null) => {
    const s = fs.lstatSync(dir);
    check(s.isDirectory() && !s.isSymbolicLink() && s.uid === uid && s.gid === gid
      && !(s.mode & 0o022) && (!exactMode || (s.mode & 0o777) === exactMode)
      && fs.realpathSync(dir) === dir, "DIRECTORY_UNSAFE");
  };
  const mkdir = dir => {
    if (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (!fs.existsSync(parent)) mkdir(parent); else protectedDirectory(parent);
      fs.mkdirSync(dir, { mode: 0o700 }); fs.chownSync(dir, uid, gid); syncDirectory(parent);
    }
    protectedDirectory(dir, 0o700);
  };
  const read = file => { assertProtectedFile(file, fileOptions); return fs.readFileSync(file); };
  const hash = file => sha(read(file));
  const ownedFile = (file, expected) => {
    const s = fs.lstatSync(file);
    check(s.isFile() && !s.isSymbolicLink() && [1, 2].includes(s.nlink) && s.uid === uid
      && s.gid === gid && (s.mode & 0o777) === 0o600 && sha(fs.readFileSync(file)) === expected, "OWNED_FILE_DRIFT");
    recoverAtomicExclusivePublication(file, fileOptions);
    check(hash(file) === expected, "OWNED_FILE_DRIFT");
  };
  const readJson = file => JSON.parse(read(file).toString("utf8"));
  const exclusive = (file, bytes) => writeFileExclusiveAtomicDurable(file, bytes, fileOptions);
  const write = (file, value) => atomicWrite(file, json(value), { uid, gid });
  const contract = value => { validateContract(value); check(value.machineSha256 === machineSha256, "MACHINE_DRIFT"); return value; };
  const paths = c => {
    const tx = transactionDirectory(root, c.generation);
    return { tx, backup: path.join(tx, "settings.before.js"), candidate: path.join(tx, "settings.after.js"),
      contract: path.join(tx, "contract.json"), intent: path.join(tx, "intent.json"), ready: path.join(tx, "ready.json"),
      done: path.join(tx, "finish.json"), deactivation: path.join(tx, "deactivation.intent.json"),
      artifact: path.join(releases, c.bundleSha256, "observer.cjs") };
  };
  const sources = (c, allowedSettings) => {
    protectedDirectory(root);
    check(hash(flow) === c.flowSha256, "FLOW_DRIFT");
    const nodes = JSON.parse(read(flow)), byId = new Map(nodes.map(n => [n.id, n]));
    const inputs = nodes.filter(n => n.type === "http in" && n.method === "post" && n.url === "/lk/subscription-bookings"
      && !n.d && !byId.get(n.z)?.disabled);
    check(inputs.length === 1, "HOOK_ROUTE_DRIFT");
    const seen = new Set(), todo = [inputs[0].id];
    while (todo.length) {
      const id = todo.pop(), n = byId.get(id); if (!n || seen.has(id)) continue;
      seen.add(id); todo.push(...(n.wires || []).flat()); if (n.type === "link out") todo.push(...(n.links || []));
    }
    for (const [role, stage] of [["router", "booking_router"], ["finalize", "booking_finalize"]]) {
      const matches = [...seen].map(id => byId.get(id)).filter(n => n.type === "function" && !n.d
        && !byId.get(n.z)?.disabled
        && sha(n.func || "") === c.hooks[role] && n.func.includes('global.get("lkDiagnostics")')
        && n.func.includes(`.observe(msg, "${stage}"`));
      check(matches.length === 1, "HOOK_SOURCE_DRIFT");
    }
    for (const f of c.preservedFiles) {
      assertProtectedFileModes(f.path, { uid, gid, modes: [0o600, 0o644] });
      check(sha(fs.readFileSync(f.path)) === f.sha256, "PRESERVED_SOURCE_DRIFT");
    }
    check(allowedSettings.includes(hash(settings)), "SETTINGS_DRIFT");
  };
  const inspect = () => { const p = pm2.inspect(); check(validProcess(p), "PROCESS_NOT_ONLINE"); return p; };
  const sameProcess = p => check(processEqual(inspect(), p), "PROCESS_DRIFT");
  const sameRecoveryProcess = p => {
    const current = pm2.inspect(); check(validRecoveryProcess(current) && processEqual(current, p), "PROCESS_DRIFT");
  };
  const owned = c => {
    assertLock();
    protectedDirectory(root);
    protectedDirectory(path.dirname(paths(c).tx), 0o700); protectedDirectory(paths(c).tx, 0o700);
    // Inspect ownership before recovering a hardlink publication, never repair foreign leases.
    const s = fs.lstatSync(leasePath);
    check(s.isFile() && !s.isSymbolicLink() && [1, 2].includes(s.nlink) && s.uid === uid
      && s.gid === gid && (s.mode & 0o777) === 0o600, "LEASE_UNSAFE");
    const l = JSON.parse(fs.readFileSync(leasePath));
    check(l.formatVersion === 4 && l.kind === "subscription409-runtime" && l.contractSha256 === sha(json(c))
      && l.generation === c.generation && PHASES.includes(l.phase), "FOREIGN_LEASE");
    recoverAtomicExclusivePublication(leasePath, fileOptions);
    assertProtectedFile(leasePath, fileOptions);
    ownedFile(paths(c).contract, sha(json(c)));
    ownedFile(paths(c).backup, c.settingsSha256); ownedFile(paths(c).candidate, c.candidateSha256);
    return l;
  };
  const phase = (c, l, next, extra = {}) => {
    const current = owned(c); check(current.phase === l.phase, "LEASE_PHASE_DRIFT");
    const result = { ...current, ...extra, phase: next }; write(leasePath, result); return result;
  };
  const ready = (c, p) => {
    protectedDirectory(releases, 0o700); protectedDirectory(path.dirname(paths(c).artifact), 0o700);
    check(hash(paths(c).artifact) === c.bundleSha256, "ARTIFACT_DRIFT");
    const r = readJson(paths(c).ready);
    check(r.kind === "SUBSCRIPTION409_SETTINGS_REGISTERED" && r.registered === true && r.pid === p.pid
      && r.generation === c.generation && r.bundleSha256 === c.bundleSha256, "REGISTRATION_NOT_PROVEN");
  };
  const waitForRegistration = (c, expected) => {
    const deadline = monotonic() + registrationTimeoutMs;
    while (true) {
      assertLock();
      const remaining = deadline - monotonic(); check(remaining > 0, "REGISTRATION_TIMEOUT");
      const current = pm2.inspect({ timeoutMs: Math.max(1, Math.min(1000, Math.ceil(remaining))) });
      check(monotonic() < deadline, "REGISTRATION_TIMEOUT");
      check(validProcess(current) && processEqual(current, expected), "PROCESS_DRIFT");
      if (fs.existsSync(paths(c).ready)) { ready(c, current); return current; }
      wait(Math.min(pollMs, Math.max(1, deadline - monotonic())));
    }
  };
  const completed = (c, receipt) => {
    check(receipt.contractSha256 === sha(json(c)) && ["INSTALLED", "ROLLED_BACK"].includes(receipt.state), "FINISH_RECEIPT_INVALID");
    sources(c, [receipt.state === "INSTALLED" ? c.candidateSha256 : c.settingsSha256]);
    sameProcess(receipt.process);
    if (receipt.state === "INSTALLED") ready(c, receipt.process);
    return receipt;
  };
  const release = (c, l, state, p) => {
    const receipt = { contractSha256: sha(json(c)), state, process: p };
    write(paths(c).done, receipt); onTransition("finish-receipt-durable");
    const current = owned(c); check(current.phase === l.phase, "LEASE_PHASE_DRIFT");
    fs.unlinkSync(leasePath); onTransition("lease-unlinked-before-directory-sync"); syncDirectory(root);
    onTransition("lease-released"); return receipt;
  };
  const alreadyDone = c => {
    const file = paths(c).done;
    if (!fs.existsSync(file)) return null;
    const raw = readJson(file);
    check(raw.state !== "INSTALLED" || !fs.existsSync(paths(c).deactivation), "ROLLBACK_PENDING_USE_ROLLBACK");
    const receipt = completed(c, raw);
    if (fs.existsSync(leasePath)) { const l = owned(c); return release(c, l, receipt.state, receipt.process); }
    syncDirectory(root);
    return receipt;
  };
  return {
    status() {
      if (!fs.existsSync(leasePath)) return { state: "NO_LEASE" };
      const l = readJson(leasePath); return { state: "LEASE_PRESENT", ownedKind: l.kind === "subscription409-runtime",
        phase: PHASES.includes(l.phase) ? l.phase : "UNKNOWN" };
    },
    apply(value, { bundle, beforeSettings, afterSettings }) {
      assertLock(); const c = contract(value), p = paths(c);
      const done = alreadyDone(c); if (done) return done;
      check(!fs.existsSync(leasePath), "DEPLOYMENT_LEASE_PRESENT");
      check(now() >= c.createdAtMs && now() - c.createdAtMs <= 30 * 60_000, "CONTRACT_STALE");
      check(sha(bundle) === c.bundleSha256 && sha(beforeSettings) === c.settingsSha256
        && sha(afterSettings) === c.candidateSha256, "PACKET_DIGEST_INVALID");
      check(settingsCandidate(beforeSettings, { ...c, root, releases }).equals(afterSettings), "SETTINGS_DELTA_INVALID");
      sources(c, [c.settingsSha256]); sameProcess(c.process);
      mkdir(p.tx);
      for (const [file, bytes] of [[p.backup, beforeSettings], [p.candidate, afterSettings], [p.contract, json(c)],
        [p.intent, json({ kind: "SUBSCRIPTION409_INSTALL_INTENT", contractSha256: sha(json(c)) })]]) {
        if (fs.existsSync(file)) ownedFile(file, sha(bytes)); else exclusive(file, bytes);
      }
      syncDirectory(p.tx); onTransition("backups-and-intent-durable");
      // No timeout cleanup: v4 is sticky and canonical flow/editor readers reject it.
      exclusive(leasePath, json({ formatVersion: 4, kind: "subscription409-runtime", generation: c.generation,
        contractSha256: sha(json(c)), phase: "PREPARED", beforeProcess: c.process }));
      onTransition("lease-published");
      let l = owned(c); mkdir(path.dirname(p.artifact));
      if (fs.existsSync(p.artifact)) ownedFile(p.artifact, c.bundleSha256);
      else exclusive(p.artifact, bundle);
      onTransition("artifact-published");
      sources(c, [c.settingsSha256]); sameProcess(c.process); assertLock();
      atomicWrite(settings, afterSettings, { uid, gid }); onTransition("settings-published");
      sources(c, [c.candidateSha256]); sameProcess(c.process);
      l = phase(c, l, "RESTART_INTENT"); onTransition("restart-intent-durable");
      pm2.restart(c.process.restartCount); onTransition("restart-returned-before-receipt");
      const active = inspect();
      check(active.restartCount === c.process.restartCount + 1 && active.pid !== c.process.pid, "RESTART_OUTCOME_UNKNOWN");
      sources(c, [c.candidateSha256]);
      l = phase(c, l, "RESTART_INTENT", { registrationProcess: active, restartReturned: true });
      waitForRegistration(c, active); sources(c, [c.candidateSha256]);
      l = phase(c, l, "SOAKING", { process: active, soakUntilMs: now() + soakMs });
      onTransition("soaking-durable"); return { state: "SOAKING", soakUntilMs: l.soakUntilMs };
    },
    resume(value, { recoveryProcess, restartQuiesced = false } = {}) {
      assertLock(); const c = contract(value); const done = alreadyDone(c); if (done) return done;
      let l = owned(c); sources(c, [c.candidateSha256]);
      if (l.phase === "SOAKING") {
        sameProcess(l.process); ready(c, l.process); return { state: "SOAKING", soakUntilMs: l.soakUntilMs };
      }
      check(l.phase === "RESTART_INTENT", "FORWARD_RESUME_PHASE_INVALID");
      let expected = l.registrationProcess;
      if (!l.restartReturned || !validProcess(expected)) {
        check(restartQuiesced && validProcess(recoveryProcess), "EXPLICIT_RESTART_RECOVERY_REQUIRED");
        sameProcess(recoveryProcess);
        check(recoveryProcess.restartCount === c.process.restartCount + 1 && recoveryProcess.pid !== c.process.pid, "PROCESS_DRIFT");
        expected = recoveryProcess;
        l = phase(c, l, "RESTART_INTENT", { registrationProcess: expected, restartReturned: true });
      }
      const active = waitForRegistration(c, expected); sources(c, [c.candidateSha256]);
      l = phase(c, l, "SOAKING", { process: active, soakUntilMs: now() + soakMs });
      return { state: "SOAKING", soakUntilMs: l.soakUntilMs };
    },
    finish(value) {
      assertLock(); const c = contract(value); const done = alreadyDone(c); if (done) return done;
      const l = owned(c); check(l.phase === "SOAKING" && now() >= l.soakUntilMs, "SOAK_NOT_COMPLETE");
      sources(c, [c.candidateSha256]); sameProcess(l.process); ready(c, l.process);
      return release(c, l, "INSTALLED", l.process);
    },
    rollback(value, { recoveryProcess, restartQuiesced = false } = {}) {
      assertLock(); const c = contract(value), p = paths(c);
      if (fs.existsSync(p.done)) {
        const receipt = readJson(p.done);
        if (receipt.state === "ROLLED_BACK") return alreadyDone(c);
        check(receipt.state === "INSTALLED" && receipt.contractSha256 === sha(json(c)), "FINISH_RECEIPT_INVALID");
        // A delayed stop remains possible after the soak lease was released.
        // Its durable intent prevents apply/finish from treating old INSTALLED as current.
        if (!fs.existsSync(p.deactivation)) {
          completed(c, receipt); if (fs.existsSync(leasePath)) owned(c);
          write(p.deactivation, { contractSha256: sha(json(c)), process: receipt.process });
          onTransition("deactivation-intent-durable");
        } else {
          const intent = readJson(p.deactivation);
          check(intent.contractSha256 === sha(json(c)) && processEqual(intent.process, receipt.process), "DEACTIVATION_INTENT_DRIFT");
        }
        if (!fs.existsSync(leasePath)) {
          completed(c, receipt);
          exclusive(leasePath, json({ formatVersion: 4, kind: "subscription409-runtime", generation: c.generation,
            contractSha256: sha(json(c)), phase: "SOAKING", beforeProcess: c.process, process: receipt.process }));
          onTransition("rollback-lease-reacquired");
        }
      }
      let l = owned(c); sources(c, [c.settingsSha256, c.candidateSha256]);
      let active = pm2.inspect(); check(validRecoveryProcess(active), "PROCESS_IDENTITY_INVALID");
      const uncertain = ["RESTART_INTENT", "ROLLBACK_RESTART_INTENT"].includes(l.phase);
      if (uncertain) {
        check(restartQuiesced && validRecoveryProcess(recoveryProcess) && processEqual(active, recoveryProcess), "EXPLICIT_RESTART_RECOVERY_REQUIRED");
        // Reconcile a returned baseline restart without issuing a second one.
        if (l.phase === "ROLLBACK_RESTART_INTENT") {
          check(hash(settings) === c.settingsSha256, "ROLLBACK_RESTART_OUTCOME_UNKNOWN");
          if (validProcess(active) && active.restartCount === l.beforeRollback.restartCount + 1 && active.pid !== l.beforeRollback.pid) {
            l = phase(c, l, "ROLLBACK_VERIFIED", { process: active });
            return release(c, l, "ROLLED_BACK", active);
          }
          check(processEqual(active, l.beforeRollback) || (!validProcess(active)
            && active.restartCount === l.beforeRollback.restartCount + 1), "ROLLBACK_RESTART_OUTCOME_UNKNOWN");
        } else {
          check(processEqual(active, c.process) || (active.restartCount === c.process.restartCount + 1
            && active.pid !== c.process.pid) || (!validProcess(active) && active.restartCount === c.process.restartCount), "PROCESS_DRIFT");
        }
      } else sameRecoveryProcess(l.phase === "PREPARED" ? c.process
        : l.phase === "ROLLBACK_INTENT" ? l.beforeRollback : l.process);
      if (l.phase === "ROLLBACK_VERIFIED") {
        sources(c, [c.settingsSha256]); return release(c, l, "ROLLED_BACK", l.process);
      }
      const needsRestart = !processEqual(active, c.process);
      l = phase(c, l, "ROLLBACK_INTENT", { beforeRollback: active, needsRestart }); onTransition("rollback-intent-durable");
      if (hash(settings) === c.candidateSha256) atomicWrite(settings, read(p.backup), { uid, gid });
      onTransition("baseline-settings-restored"); sources(c, [c.settingsSha256]); sameRecoveryProcess(active);
      if (needsRestart) {
        l = phase(c, l, "ROLLBACK_RESTART_INTENT"); onTransition("rollback-restart-intent-durable");
        pm2.restart(active.restartCount, { allowOffline: !validProcess(active) }); onTransition("rollback-restart-returned-before-receipt");
        const baseline = inspect(); check(baseline.restartCount === active.restartCount + 1
          && baseline.pid !== active.pid, "ROLLBACK_RESTART_OUTCOME_UNKNOWN"); active = baseline;
      }
      sources(c, [c.settingsSha256]); sameProcess(active);
      l = phase(c, l, "ROLLBACK_VERIFIED", { process: active }); onTransition("rollback-verified-durable");
      // Artifact/backups/evidence retained, including a pre-existing same-hash artifact.
      return release(c, l, "ROLLED_BACK", active);
    },
  };
}
