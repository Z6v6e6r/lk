import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEditorPauseOperation } from "../nodered_reviewed_flow_deploy/editor_pause_operation.mjs";
import { createReviewedFlowRuntime } from "../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs";
import { canonicalFlowSha256, sha256 } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { codePointGraphSha256 } from "../nodered_reviewed_flow_deploy/max-pause-body-preserver.mjs";
import { buildMaxPauseBrowserGuard } from "../nodered_reviewed_flow_deploy/max-pause-browser-guard.mjs";

const sourceDir = fileURLToPath(new URL("../nodered_reviewed_flow_deploy/", import.meta.url));
const ids = ["e75785ffa19c2e20", "c1ecd06ce451751b"];
const sources = ["editor_pause_operation.mjs", "deploy_reviewed_flow_147_remote.mjs", "runtime_contract.mjs", "max-pause-body-preserver.mjs", "max-pause-browser-guard.mjs"];
const graph = () => [
  ...ids.map(id => ({ id, type: "inject", once: true, repeat: "5", wires: [[]] })),
  { id: "lk_booked_operation_provider_request_20261021", type: "http request", requestTimeout: "15000" },
  ...Array.from({ length: 4854 }, (_, i) => ({ id: `fictional-${i}`, type: "debug" })),
];
async function fixture(t, mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-operation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, ".padlhub-reviewed-flow-stage-20261027T090000+0300-1");
  fs.mkdirSync(stage, { mode: 0o700 });
  const uid = process.getuid(), gid = process.getgid();
  const live = graph(), candidate = structuredClone(live); candidate[0].d = true; candidate[1].d = true;
  const liveBytes = Buffer.from(JSON.stringify(live));
  const liveFile = path.join(root, "flows.json"), leaseFile = path.join(root, ".padlhub-reviewed-flow-deploy.lease.json");
  fs.writeFileSync(liveFile, liveBytes, { mode: 0o600 });
  let now = Date.parse("2026-10-27T06:00:00.000Z");
  const old = { formatVersion: 2, deploymentId: "completed-prior", token: "synthetic-private-prior", phase: "soaking", acquiredAtMs: now - 120000, expiresAtMs: now - 60000, sourceSha256: "a".repeat(64), candidateSha256: sha256(liveBytes) };
  const oldBytes = Buffer.from(JSON.stringify(old)); fs.writeFileSync(leaseFile, oldBytes, { mode: 0o600 });
  const target = { hostAlias: "lk-primary-147", machineIdSha256: "a".repeat(64), executable: "/usr/bin/node", cwd: "/root", pmExecPath: "/usr/bin/node-red", pmCwd: "/root", processArgsSha256: "b".repeat(64), settingsPath: "/root/.node-red/settings.js", settingsSha256: "c".repeat(64), serverEndpoint: "http://127.0.0.1:1880/flows", browserEndpoint: "http://127.0.0.1:18801/flows" };
  const actual = { ...target, pid: 789, restartCount: 5, status: "online" };
  const pins = {};
  for (const name of sources) { const content = fs.readFileSync(path.join(sourceDir, name)); fs.writeFileSync(path.join(stage, name), content, { mode: 0o600 }); pins[name] = sha256(content); }
  const p = { formatVersion: 1, operationId: "fictional-max-pause", deploymentId: "fictional-editor-pause", stamp: "20261027T090000+0300", stageDirectory: stage, target,
    sourceSha256: sha256(liveBytes), sourceCanonicalSha256: canonicalFlowSha256(live), sourceCodePointSha256: codePointGraphSha256(live),
    candidateCanonicalSha256: canonicalFlowSha256(candidate), candidateCodePointSha256: codePointGraphSha256(candidate), preRevisionSha256: "d".repeat(64),
    nodeCount: 4857, expectedPid: 789, expectedRestartCount: 5,
    existingLease: { sha256: sha256(oldBytes), deploymentId: old.deploymentId, candidateSha256: old.candidateSha256 }, sourceFileSha256: pins,
    browserBuiltSha256: sha256(Buffer.from(await buildMaxPauseBrowserGuard())), confirmation: "PAUSE_TWO_MAX_INJECTS_PRESERVE_GRAPH_NATIVE_REVISION_NO_RESTART" };
  mutate(p);
  const packetBytes = Buffer.from(JSON.stringify(p)); fs.writeFileSync(path.join(stage, "operator-packet.json"), packetBytes, { mode: 0o600 });
  const pm2 = { assertOnline: () => ({ pid: actual.pid, restartCount: actual.restartCount, status: actual.status }), restart: () => { throw new Error("restart prohibited"); } };
  const runtime = createReviewedFlowRuntime({ liveFlowPath: liveFile, stageParent: root, backupDirectory: path.join(root, ".padlhub-reviewed-flow-backups"), deploymentLeasePath: leaseFile,
    uid, gid, getUid: () => uid, now: () => now, randomUUID: () => "synthetic-private-editor-token", pm2 });
  const options = { stage, packetSha256: sha256(packetBytes), stageParent: root, uid, gid, now: () => now, readTarget: () => actual, runtime };
  const operation = await createEditorPauseOperation(options);
  const readback = (state = "source", revision = p.preRevisionSha256) => ({ observedAt: new Date(now).toISOString(), origin: "http://127.0.0.1:18801", revisionSha256: revision, codePointSha256: p[`${state}CodePointSha256`], nodeCount: 4857 });
  return { operation, options, p, actual, stage, leaseFile, liveFile, candidate, liveBytes, oldBytes, readback,
    advance: ms => { now += ms; }, now: () => now };
}
const ackInput = (f, begun) => ({ attemptSha256: begun.attemptSha256, requestedAt: new Date(f.now()).toISOString(), ackAt: new Date(f.now()).toISOString(), httpStatus: 200, authenticated: true, conflict: false,
  guardAudit: { operationId: f.p.operationId, state: "FORWARDED_AWAITING_READBACK", forwarded: 1, rejected: 0, sourceCodePointSha256: f.p.sourceCodePointSha256, preRevisionSha256: f.p.preRevisionSha256,
    nodeCount: 4857, pausedInjectIds: ids, restoredRequestTimeoutCount: 1, postBodyCodePointSha256: f.p.candidateCodePointSha256, forwardedBodySha256: "f".repeat(64), notAfter: begun.notAfter },
  nativeReadback: f.readback("candidate", "e".repeat(64)) });

test("root custody protocol reserves once, binds native ACK and finishes only after full soak", async t => {
  const f = await fixture(t), output = [];
  output.push(f.operation.prepareReserve());
  const begun = f.operation.begin(f.readback()); output.push(begun);
  assert.throws(() => f.operation.begin(f.readback()), /EEXIST/);
  assert.throws(() => f.operation.abortBeforeAttempt(), /MAY_HAVE_EFFECT/);
  assert.deepEqual(fs.readFileSync(f.liveFile), f.liveBytes);
  // Only this test simulates the native editor; production controller never writes flows.
  fs.writeFileSync(f.liveFile, JSON.stringify(f.candidate), { mode: 0o600 });
  output.push(f.operation.acknowledge(ackInput(f, begun)));
  assert.throws(() => f.operation.finish(f.readback("candidate", "e".repeat(64))), /SOAK_NOT_COMPLETE/);
  f.advance(900000);
  output.push(f.operation.finish(f.readback("candidate", "e".repeat(64))));
  assert.equal(fs.existsSync(f.leaseFile), false);
  assert.equal(output.at(-1).status, "FINISHED");
  assert.equal(f.operation.recoverFinish().resumed, true);
  assert.equal(JSON.stringify(output).includes("synthetic-private"), false);
  const mode = fs.statSync(path.join(f.stage, "browser-attempt.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

for (const key of ["machineIdSha256", "executable", "cwd", "pmExecPath", "pmCwd", "processArgsSha256", "settingsSha256", "serverEndpoint", "browserEndpoint", "pid", "restartCount", "status"]) {
  test(`target drift ${key} refuses before any stage or lease effect`, async t => {
    const f = await fixture(t); f.actual[key] = typeof f.actual[key] === "number" ? f.actual[key] + 1 : "foreign";
    assert.throws(() => f.operation.prepareReserve(), /TARGET_DRIFT|RUNTIME_DRIFT/);
    assert.deepEqual(fs.readFileSync(f.leaseFile), f.oldBytes);
    assert.equal(fs.existsSync(path.join(f.stage, "candidate.flow.json")), false);
  });
}
test("packet/source/guard pin failures are closed before operation construction", async t => {
  const f = await fixture(t);
  await assert.rejects(createEditorPauseOperation({ ...f.options, packetSha256: "a".repeat(64) }), /PACKET_HASH/);
  await assert.rejects(createEditorPauseOperation({ ...f.options, buildGuard: async () => "foreign" }), /GUARD_DRIFT/);
  fs.appendFileSync(path.join(f.stage, "runtime_contract.mjs"), "// drift");
  await assert.rejects(createEditorPauseOperation(f.options), /SOURCE_DRIFT/);
});
test("begin requires fresh native origin, revision, graph and sufficient reservation budget", async t => {
  const f = await fixture(t); f.operation.prepareReserve();
  for (const [key, value] of [["origin", "https://foreign.test"], ["revisionSha256", "f".repeat(64)], ["codePointSha256", "a".repeat(64)], ["observedAt", "2026-10-26T00:00:00.000Z"]]) {
    assert.throws(() => f.operation.begin({ ...f.readback(), [key]: value }), /NATIVE_BINDING|PRE_REVISION_DRIFT/);
    assert.equal(fs.existsSync(path.join(f.stage, "browser-attempt.json")), false);
  }
  f.advance(600000);
  assert.throws(() => f.operation.begin(f.readback()), /RESERVATION_TTL/);
});
for (const [label, mutate] of [
  ["extra credential field", x => { x.Authorization = "fictional-do-not-persist"; }],
  ["wrong attempt", x => { x.attemptSha256 = "a".repeat(64); }],
  ["HTTP conflict", x => { x.httpStatus = 409; }],
  ["unknown delivery", x => { x.authenticated = false; }],
  ["expired request", (x, f, b) => { x.requestedAt = b.notAfter; x.ackAt = b.notAfter; f.advance(300001); }],
  ["wrong guard body", x => { x.guardAudit.postBodyCodePointSha256 = "a".repeat(64); }],
  ["second attempt", x => { x.guardAudit.forwarded = 2; }],
  ["wrong native revision", (x, f) => { x.nativeReadback.revisionSha256 = f.p.preRevisionSha256; }],
]) test(`ACK refuses ${label} and retains v3 custody`, async t => {
  const f = await fixture(t); f.operation.prepareReserve(); const begun = f.operation.begin(f.readback());
  fs.writeFileSync(f.liveFile, JSON.stringify(f.candidate), { mode: 0o600 });
  const input = ackInput(f, begun); mutate(input, f, begun);
  assert.throws(() => f.operation.acknowledge(input), /ACK_INPUT|GUARD_ACK|POST_REVISION/);
  assert.equal(JSON.parse(fs.readFileSync(f.leaseFile)).phase, "editor-reserved");
  assert.equal(fs.existsSync(path.join(f.stage, "editor-ack.json")), false);
});
test("read-only PRE/POST/UNKNOWN reconciliation never releases or retries after ambiguous attempt", async t => {
  const f = await fixture(t); f.operation.prepareReserve(); f.operation.begin(f.readback());
  assert.equal(f.operation.reconcile().status, "UNKNOWN");
  assert.equal(f.operation.reconcile().diskState, "PRE");
  assert.equal(f.operation.reconcile(f.readback()).status, "PRE");
  fs.writeFileSync(f.liveFile, JSON.stringify(f.candidate));
  assert.equal(f.operation.reconcile(f.readback()).status, "UNKNOWN");
  assert.equal(f.operation.reconcile(f.readback("candidate", "e".repeat(64))).status, "POST");
  assert.equal(f.operation.reconcile({ ...f.readback("candidate", "e".repeat(64)), origin: "https://foreign.test" }).status, "UNKNOWN");
  const foreign = structuredClone(f.candidate); foreign[3].foreign = true;
  fs.writeFileSync(f.liveFile, JSON.stringify(foreign)); assert.equal(f.operation.reconcile().status, "UNKNOWN");
  assert.equal(f.operation.reconcile().automaticRelease, false);
  assert.equal(JSON.parse(fs.readFileSync(f.leaseFile)).formatVersion, 3);
});
test("durable ACK permits local confirmation recovery without repeating browser action", async t => {
  const f = await fixture(t); f.operation.prepareReserve(); const begun = f.operation.begin(f.readback());
  fs.writeFileSync(f.liveFile, JSON.stringify(f.candidate));
  const original = f.options.runtime.confirmEditorModified;
  f.options.runtime.confirmEditorModified = () => { throw new Error("synthetic confirm before call"); };
  assert.throws(() => f.operation.acknowledge(ackInput(f, begun)), /synthetic confirm/);
  assert.equal(fs.existsSync(path.join(f.stage, "editor-ack.json")), true);
  f.options.runtime.confirmEditorModified = original;
  assert.equal(f.operation.recoverConfirm().status, "SOAKING");
  assert.equal(f.operation.recoverConfirm().resumed, true);
});
test("failure after attempt publication leaves one attempt consumed and no automatic abort", async t => {
  const f = await fixture(t); f.operation.prepareReserve();
  // Exclusive guard artifact failure occurs after durable marker publication.
  fs.writeFileSync(path.join(f.stage, "browser-guard.js"), "foreign", { mode: 0o600 });
  assert.throws(() => f.operation.begin(f.readback()), /EEXIST/);
  assert.equal(fs.existsSync(path.join(f.stage, "browser-attempt.json")), true);
  assert.throws(() => f.operation.begin(f.readback()), /EEXIST/);
  assert.throws(() => f.operation.abortBeforeAttempt(), /MAY_HAVE_EFFECT/);
  assert.deepEqual(fs.readFileSync(f.liveFile), f.liveBytes);
});
test("abort before any browser attempt uses canonical source-only release", async t => {
  const f = await fixture(t); f.operation.prepareReserve();
  assert.equal(f.operation.abortBeforeAttempt().deploymentLeaseReleased, true);
  assert.deepEqual(fs.readFileSync(f.liveFile), f.liveBytes);
});
