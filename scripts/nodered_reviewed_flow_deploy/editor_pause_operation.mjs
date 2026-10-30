#!/usr/bin/env node
// Root-only custody around the native editor's one permitted request. This code
// never calls /flows, writes the live graph, restarts PM2 or reads browser auth.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReviewedFlowRuntime } from "./deploy_reviewed_flow_147_remote.mjs";
import { buildEditorPauseInjectsContract, canonicalFlowSha256, sha256, writeFileExclusiveDurable } from "./runtime_contract.mjs";
import { codePointGraphSha256 } from "./max-pause-body-preserver.mjs";
import { buildMaxPauseBrowserGuard } from "./max-pause-browser-guard.mjs";

const ROOT = "/root/.node-red";
const LOCK = `${ROOT}/.padlhub-reviewed-flow-deploy.lock`;
const LEASE = ".padlhub-reviewed-flow-deploy.lease.json";
const SOURCE_FILES = ["editor_pause_operation.mjs", "deploy_reviewed_flow_147_remote.mjs", "runtime_contract.mjs", "max-pause-body-preserver.mjs", "max-pause-browser-guard.mjs"];
const TARGET_KEYS = ["hostAlias", "machineIdSha256", "executable", "cwd", "pmExecPath", "pmCwd", "processArgsSha256", "settingsPath", "settingsSha256", "serverEndpoint", "browserEndpoint"];
const PACKET_KEYS = ["formatVersion", "operationId", "deploymentId", "stamp", "stageDirectory", "target", "sourceSha256", "sourceCanonicalSha256", "sourceCodePointSha256", "candidateCanonicalSha256", "candidateCodePointSha256", "preRevisionSha256", "nodeCount", "expectedPid", "expectedRestartCount", "existingLease", "sourceFileSha256", "browserBuiltSha256", "confirmation"];
const IDS = ["e75785ffa19c2e20", "c1ecd06ce451751b"];
const check = (ok, code) => { if (!ok) throw new Error(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && same(Object.keys(value).sort(), [...allowed].sort());
const utc = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

export function readProductionTarget() {
  const result = spawnSync("pm2", ["jlist"], { encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "pipe"] });
  check(!result.error && result.status === 0, "EDITOR_PM2_READ_FAILED");
  const matches = JSON.parse(result.stdout).filter(item => item?.name === "node-red");
  check(matches.length === 1, "EDITOR_PM2_AMBIGUOUS");
  const item = matches[0], env = item.pm2_env, pid = item.pid;
  check(Number.isSafeInteger(pid) && pid > 0 && env.status === "online", "EDITOR_PM2_OFFLINE");
  const settingsPath = `${ROOT}/settings.js`;
  const stat = fs.lstatSync(settingsPath);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o022), "EDITOR_SETTINGS_CUSTODY");
  return { pid, restartCount: env.restart_time, status: env.status,
    hostAlias: "lk-primary-147", machineIdSha256: sha256(fs.readFileSync("/etc/machine-id")),
    executable: fs.readlinkSync(`/proc/${pid}/exe`), cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
    pmExecPath: env.pm_exec_path, pmCwd: env.pm_cwd,
    processArgsSha256: sha256(fs.readFileSync(`/proc/${pid}/cmdline`)), settingsPath,
    settingsSha256: sha256(fs.readFileSync(settingsPath)),
    serverEndpoint: "http://127.0.0.1:1880/flows", browserEndpoint: "http://127.0.0.1:18801/flows" };
}

export async function createEditorPauseOperation({ stage, packetSha256, stageParent = ROOT,
  uid = 0, gid = 0, now = Date.now, readTarget = readProductionTarget,
  runtime = createReviewedFlowRuntime(), buildGuard = buildMaxPauseBrowserGuard } = {}) {
  check(path.dirname(stage) === stageParent && /^\.padlhub-reviewed-flow-stage-\d{8}T\d{6}[+-]\d{4}-\d+$/.test(path.basename(stage)), "EDITOR_STAGE_PATH");
  const dir = fs.lstatSync(stage);
  check(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === uid && dir.gid === gid && (dir.mode & 0o777) === 0o700, "EDITOR_STAGE_CUSTODY");
  const protection = { uid, gid, mode: 0o600 };
  const read = (file, modes = [0o600]) => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      check(stat.isFile() && stat.uid === uid && stat.gid === gid && stat.nlink === 1 && modes.includes(stat.mode & 0o777), "EDITOR_FILE_CUSTODY");
      const content = fs.readFileSync(fd), after = fs.lstatSync(file);
      check(stat.dev === after.dev && stat.ino === after.ino && stat.size === after.size && stat.mtimeMs === after.mtimeMs, "EDITOR_FILE_REPLACED");
      return content;
    } finally { fs.closeSync(fd); }
  };
  const json = name => JSON.parse(read(path.join(stage, name)));
  const write = (name, value) => writeFileExclusiveDurable(path.join(stage, name), Buffer.from(`${JSON.stringify(value, null, 2)}\n`), protection);
  const packetBytes = read(path.join(stage, "operator-packet.json"));
  check(hex(packetSha256) && sha256(packetBytes) === packetSha256, "EDITOR_PACKET_HASH");
  const p = JSON.parse(packetBytes);
  check(keys(p, PACKET_KEYS) && p.formatVersion === 1 && p.stageDirectory === stage
    && /^[a-z0-9][a-z0-9-]{0,127}$/.test(p.operationId)
    && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(p.deploymentId)
    && /^\d{8}T\d{6}[+-]\d{4}$/.test(p.stamp) && p.nodeCount === 4857
    && Number.isSafeInteger(p.expectedPid) && p.expectedPid > 0
    && Number.isSafeInteger(p.expectedRestartCount) && p.expectedRestartCount >= 0
    && p.confirmation === "PAUSE_TWO_MAX_INJECTS_PRESERVE_GRAPH_NATIVE_REVISION_NO_RESTART", "EDITOR_PACKET_CONTRACT");
  for (const key of ["sourceSha256", "sourceCanonicalSha256", "sourceCodePointSha256", "candidateCanonicalSha256", "candidateCodePointSha256", "preRevisionSha256", "browserBuiltSha256"]) check(hex(p[key]), "EDITOR_PACKET_DIGEST");
  check(keys(p.target, TARGET_KEYS) && p.target.hostAlias === "lk-primary-147"
    && hex(p.target.machineIdSha256) && hex(p.target.processArgsSha256) && hex(p.target.settingsSha256)
    && p.target.settingsPath === `${ROOT}/settings.js`
    && p.target.serverEndpoint === "http://127.0.0.1:1880/flows"
    && p.target.browserEndpoint === "http://127.0.0.1:18801/flows", "EDITOR_TARGET_CONTRACT");
  check(keys(p.existingLease, ["sha256", "deploymentId", "candidateSha256"])
    && hex(p.existingLease.sha256) && p.existingLease.candidateSha256 === p.sourceSha256, "EDITOR_PREDECESSOR_CONTRACT");
  check(keys(p.sourceFileSha256, SOURCE_FILES), "EDITOR_SOURCE_PIN_SET");
  for (const name of SOURCE_FILES) check(hex(p.sourceFileSha256[name]) && sha256(read(path.join(stage, name))) === p.sourceFileSha256[name], "EDITOR_SOURCE_DRIFT");
  const guard = await buildGuard();
  check(sha256(Buffer.from(guard)) === p.browserBuiltSha256, "EDITOR_GUARD_DRIFT");
  const bindTarget = () => {
    const target = readTarget();
    check(target.pid === p.expectedPid && target.restartCount === p.expectedRestartCount && target.status === "online", "EDITOR_RUNTIME_DRIFT");
    for (const key of TARGET_KEYS) check(target[key] === p.target[key], "EDITOR_TARGET_DRIFT");
    return target;
  };
  const sourceBytes = () => read(path.join(stageParent, "flows.json"), [0o600, 0o644]);
  const graph = bytes => JSON.parse(bytes);
  const assertGraph = state => {
    const content = sourceBytes(), parsed = graph(content);
    check(parsed.length === p.nodeCount && canonicalFlowSha256(parsed) === p[`${state}CanonicalSha256`]
      && codePointGraphSha256(parsed) === p[`${state}CodePointSha256`], "EDITOR_GRAPH_DRIFT");
    if (state === "source") check(sha256(content) === p.sourceSha256, "EDITOR_RAW_DRIFT");
    return content;
  };
  const lease = () => {
    const value = JSON.parse(read(path.join(stageParent, LEASE)));
    check(value.formatVersion === 3 && value.kind === "editor-modified-nodes" && value.deploymentId === p.deploymentId
      && value.sourceSha256 === p.sourceSha256 && value.sourceCanonicalSha256 === p.sourceCanonicalSha256
      && value.candidateCanonicalSha256 === p.candidateCanonicalSha256
      && value.nodeRedPid === p.expectedPid && value.nodeRedRestartCount === p.expectedRestartCount
      && value.editorStageDirectory === stage && typeof value.token === "string" && value.token.length > 0, "EDITOR_LEASE_BINDING");
    check(sha256(read(value.contractBackup)) === sha256(read(path.join(stage, "contract.json"))), "EDITOR_CONTRACT_DRIFT");
    return value;
  };
  const common = current => ({ deploymentId: p.deploymentId, stamp: p.stamp, leaseToken: current.token });
  const marker = () => {
    const content = read(path.join(stage, "browser-attempt.json")), value = JSON.parse(content);
    const current = lease();
    check(value.operationId === p.operationId && value.packetSha256 === packetSha256
      && value.leaseTokenSha256 === sha256(Buffer.from(current.token)) && value.browserBuiltSha256 === p.browserBuiltSha256
      && value.contractSha256 === sha256(read(path.join(stage, "contract.json")))
      && utc(value.createdAt) && utc(value.notAfter) && Date.parse(value.notAfter) - Date.parse(value.createdAt) === 300000, "EDITOR_ATTEMPT_BINDING");
    return { value, sha256: sha256(content) };
  };
  const nativeReadback = (input, state) => {
    check(keys(input, ["observedAt", "origin", "revisionSha256", "codePointSha256", "nodeCount"])
      && utc(input.observedAt) && Date.parse(input.observedAt) <= now() && now() - Date.parse(input.observedAt) <= 30000
      && input.origin === "http://127.0.0.1:18801" && hex(input.revisionSha256)
      && input.codePointSha256 === p[`${state}CodePointSha256`] && input.nodeCount === 4857, "EDITOR_NATIVE_BINDING");
  };
  return {
    prepareReserve() {
      bindTarget(); const liveBytes = assertGraph("source"), candidate = graph(liveBytes);
      for (const id of IDS) { const node = candidate.find(x => x.id === id); check(node?.type === "inject" && node.once === true && node.repeat === "5" && [undefined, false].includes(node.d), "EDITOR_INJECT_DRIFT"); node.d = true; }
      const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
      const contract = buildEditorPauseInjectsContract({ liveBytes, candidateBytes, deploymentId: p.deploymentId });
      check(contract.candidateCanonicalSha256 === p.candidateCanonicalSha256 && codePointGraphSha256(candidate) === p.candidateCodePointSha256, "EDITOR_CANDIDATE_DRIFT");
      writeFileExclusiveDurable(path.join(stage, "candidate.flow.json"), candidateBytes, protection);
      write("contract.json", contract);
      bindTarget(); assertGraph("source");
      // Same global flock as the helper; the token never reaches stdout/argv.
      const reserved = runtime.reserveEditorModified({ candidatePath: path.join(stage, "candidate.flow.json"), contractPath: path.join(stage, "contract.json"),
        deploymentId: p.deploymentId, stamp: p.stamp, expectedPredecessor: p.existingLease });
      check(sha256(Buffer.from(reserved.leaseToken)) === sha256(Buffer.from(lease().token)), "EDITOR_RESERVE_CUSTODY");
      return { status: "RESERVED", deploymentId: p.deploymentId, reserveReceipt: reserved.reserveReceipt, liveFlowWritten: false, nodeRedRestarted: false };
    },
    begin(input) {
      bindTarget(); assertGraph("source"); nativeReadback(input, "source");
      check(input.revisionSha256 === p.preRevisionSha256, "EDITOR_PRE_REVISION_DRIFT");
      const current = lease(), at = now();
      check(current.phase === "editor-reserved" && current.expiresAtMs - at >= 360000, "EDITOR_RESERVATION_TTL");
      const attempt = { formatVersion: 1, operationId: p.operationId, packetSha256,
        contractSha256: sha256(read(path.join(stage, "contract.json"))), leaseTokenSha256: sha256(Buffer.from(current.token)),
        browserBuiltSha256: p.browserBuiltSha256, createdAt: new Date(at).toISOString(), notAfter: new Date(at + 300000).toISOString() };
      write("browser-attempt.json", attempt);
      writeFileExclusiveDurable(path.join(stage, "browser-guard.js"), Buffer.from(guard), protection);
      bindTarget(); assertGraph("source");
      check(lease().token === current.token, "EDITOR_BEGIN_LEASE_DRIFT");
      return { status: "ONE_ATTEMPT_RESERVED", operationId: p.operationId, notAfter: attempt.notAfter,
        attemptSha256: marker().sha256, browserBuiltSha256: p.browserBuiltSha256,
        expectedPreRevisionSha256: p.preRevisionSha256, expectedSourceCodePointSha256: p.sourceCodePointSha256 };
    },
    acknowledge(input) {
      bindTarget(); assertGraph("candidate"); const attempt = marker(), current = lease();
      check(keys(input, ["attemptSha256", "requestedAt", "ackAt", "httpStatus", "authenticated", "conflict", "guardAudit", "nativeReadback"])
        && input.attemptSha256 === attempt.sha256 && input.httpStatus === 200 && input.authenticated === true && input.conflict === false
        && utc(input.requestedAt) && utc(input.ackAt)
        && Date.parse(input.requestedAt) >= Date.parse(attempt.value.createdAt)
        && Date.parse(input.requestedAt) < Date.parse(attempt.value.notAfter)
        && Date.parse(input.requestedAt) <= Date.parse(input.ackAt) && Date.parse(input.ackAt) <= now()
        && now() <= current.expiresAtMs, "EDITOR_ACK_INPUT");
      const audit = input.guardAudit;
      check(keys(audit, ["operationId", "state", "forwarded", "rejected", "sourceCodePointSha256", "preRevisionSha256", "nodeCount", "pausedInjectIds", "restoredRequestTimeoutCount", "postBodyCodePointSha256", "forwardedBodySha256", "notAfter"])
        && audit.operationId === p.operationId && audit.state === "FORWARDED_AWAITING_READBACK" && audit.forwarded === 1 && audit.rejected === 0
        && audit.sourceCodePointSha256 === p.sourceCodePointSha256 && audit.preRevisionSha256 === p.preRevisionSha256
        && audit.nodeCount === 4857 && same(audit.pausedInjectIds, IDS) && [0, 1].includes(audit.restoredRequestTimeoutCount)
        && audit.postBodyCodePointSha256 === p.candidateCodePointSha256 && hex(audit.forwardedBodySha256)
        && audit.notAfter === attempt.value.notAfter, "EDITOR_GUARD_ACK");
      nativeReadback(input.nativeReadback, "candidate");
      check(input.nativeReadback.revisionSha256 !== p.preRevisionSha256
        && Date.parse(input.nativeReadback.observedAt) >= Date.parse(input.ackAt), "EDITOR_POST_REVISION_UNCHANGED");
      const ack = { deploymentId: p.deploymentId, contractSha256: attempt.value.contractSha256, leaseTokenSha256: attempt.value.leaseTokenSha256,
        sourceCanonicalSha256: p.sourceCanonicalSha256, candidateCanonicalSha256: p.candidateCanonicalSha256,
        deployMode: "modified-nodes", pausedInjectIds: IDS, requestedAt: input.requestedAt, ackAt: input.ackAt,
        authenticated: true, status: "SUCCESS", conflict: false, preRevisionSha256: p.preRevisionSha256, postRevisionSha256: input.nativeReadback.revisionSha256 };
      write("editor-ack.json", ack);
      bindTarget(); assertGraph("candidate");
      const result = runtime.confirmEditorModified({ ...common(current), editorAckPath: path.join(stage, "editor-ack.json") });
      return { status: "SOAKING", confirmReceipt: result.confirmReceipt, soakSeconds: 900, liveFlowWritten: false, nodeRedRestarted: false };
    },
    recoverConfirm() {
      bindTarget(); assertGraph("candidate"); marker();
      const result = runtime.confirmEditorModified({ ...common(lease()), editorAckPath: path.join(stage, "editor-ack.json") });
      return { status: "SOAKING", confirmReceipt: result.confirmReceipt, resumed: result.resumed === true, liveFlowWritten: false, nodeRedRestarted: false };
    },
    finish(input) {
      bindTarget(); assertGraph("candidate"); marker(); nativeReadback(input, "candidate");
      const current = lease(); check(current.phase === "editor-soaking" && now() >= current.expiresAtMs
        && Date.parse(input.observedAt) >= current.expiresAtMs && input.revisionSha256 === current.postRevisionSha256, "EDITOR_SOAK_NOT_COMPLETE");
      write("editor-observation.json", { observedAt: input.observedAt, confirmReceiptSha256: sha256(read(current.confirmReceipt)),
        postRevisionSha256: current.postRevisionSha256, candidateCanonicalSha256: p.candidateCanonicalSha256,
        nodeRedPid: p.expectedPid, nodeRedRestartCount: p.expectedRestartCount });
      const result = runtime.finishEditorModified({ ...common(current), observationPath: path.join(stage, "editor-observation.json") });
      return { status: "FINISHED", receiptPath: result.receiptPath, deploymentLeaseReleased: result.deploymentLeaseReleased, liveFlowWritten: false, nodeRedRestarted: false };
    },
    recoverFinish() {
      bindTarget(); assertGraph("candidate");
      // Canonical finish validates the existing protected observation and its
      // durable receipt even when the lease unlink already succeeded.
      const current = fs.existsSync(path.join(stageParent, LEASE)) ? lease() : { token: "" };
      const result = runtime.finishEditorModified({ ...common(current), observationPath: path.join(stage, "editor-observation.json") });
      return { status: "FINISHED", receiptPath: result.receiptPath, resumed: result.resumed === true, liveFlowWritten: false, nodeRedRestarted: false };
    },
    abortBeforeAttempt() {
      check(!fs.existsSync(path.join(stage, "browser-attempt.json")), "EDITOR_ATTEMPT_MAY_HAVE_EFFECT_NO_AUTO_RELEASE");
      bindTarget(); assertGraph("source");
      const result = runtime.abortEditorModified(common(lease()));
      return { status: "ABORTED_BEFORE_ATTEMPT", deploymentLeaseReleased: result.deploymentLeaseReleased, liveFlowWritten: false, nodeRedRestarted: false };
    },
    reconcile(input) {
      bindTarget(); const content = sourceBytes(), parsed = graph(content);
      const raw = sha256(content), canonical = canonicalFlowSha256(parsed), cp = codePointGraphSha256(parsed);
      const diskState = raw === p.sourceSha256 && canonical === p.sourceCanonicalSha256 && cp === p.sourceCodePointSha256 ? "PRE"
        : canonical === p.candidateCanonicalSha256 && cp === p.candidateCodePointSha256 ? "POST" : "UNKNOWN";
      const result = { status: "UNKNOWN", diskState, attemptExists: fs.existsSync(path.join(stage, "browser-attempt.json")), automaticRetry: false, automaticRelease: false };
      if (!input || diskState === "UNKNOWN") return result;
      try {
        nativeReadback(input, diskState === "PRE" ? "source" : "candidate");
        if (diskState === "PRE") check(input.revisionSha256 === p.preRevisionSha256, "EDITOR_RECONCILE_REVISION");
        else {
          check(input.revisionSha256 !== p.preRevisionSha256, "EDITOR_RECONCILE_REVISION");
          if (fs.existsSync(path.join(stage, "editor-ack.json"))) check(input.revisionSha256 === json("editor-ack.json").postRevisionSha256, "EDITOR_RECONCILE_REVISION");
        }
      } catch { return result; }
      return { ...result, status: diskState };
    },
  };
}

async function main() {
  check(process.getuid?.() === 0 && process.argv.length === 5 && hex(process.argv[4]), "EDITOR_CLI_ARGUMENTS");
  const [action, stage, packetSha256] = process.argv.slice(2);
  check(["prepare-reserve", "begin", "acknowledge", "finish", "recover-confirm", "recover-finish", "abort-before-attempt", "reconcile"].includes(action), "EDITOR_CLI_ACTION");
  const self = fileURLToPath(import.meta.url);
  check(path.dirname(self) === stage, "EDITOR_CLI_STAGE");
  const operation = await createEditorPauseOperation({ stage, packetSha256 });
  const input = ["begin", "acknowledge", "finish", "reconcile"].includes(action) ? JSON.parse(fs.readFileSync(0, "utf8")) : undefined;
  const method = { "prepare-reserve": "prepareReserve", "abort-before-attempt": "abortBeforeAttempt", "recover-confirm": "recoverConfirm", "recover-finish": "recoverFinish" }[action] || action;
  process.stdout.write(`${JSON.stringify(operation[method](input))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.PADLHUB_EDITOR_OPERATION_LOCK_HELD !== "1") {
      const fd = fs.openSync(LOCK, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        check(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, "EDITOR_LOCK_CUSTODY");
      } finally { fs.closeSync(fd); }
      const result = spawnSync("flock", ["-E", "75", "-n", LOCK, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { env: { ...process.env, PADLHUB_EDITOR_OPERATION_LOCK_HELD: "1" }, stdio: "inherit" });
      check(!result.error && Number.isInteger(result.status), "EDITOR_LOCK_FAILED"); process.exitCode = result.status;
    } else {
      const stat = fs.lstatSync(LOCK);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o077), "EDITOR_LOCK_CUSTODY");
      await main();
    }
  } catch { process.stderr.write("EDITOR_OPERATION_REFUSED_RECONCILE_BEFORE_ANY_RETRY\n"); process.exitCode = 1; }
}
