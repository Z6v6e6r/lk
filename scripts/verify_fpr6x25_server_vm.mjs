// Read-only server VM test. The build step replaces the null packet with public
// task code and synthetic inputs. Full production code/config never leaves 147.
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";
const packet = null; // FPR_VM_PACKET
let phase = "input";
const diagnostics = {};
try {
  assert.ok(packet && packet.prefixes && packet.fixture);
  const bytes = fs.readFileSync("/root/.node-red/flows.json"), flow = JSON.parse(bytes);
  const node = id => { const n = flow.find(n => n.id === id); assert.ok(n, "Required node missing"); return n; };
  const run = (source, msg) => {
    const store = {}, memory = { get: key => store[key], set: (key, value) => { store[key] = value; } };
    const context = vm.createContext({ serializedMsg: JSON.stringify(msg), flow: memory, global: memory, node: { warn() {}, log() {}, error() {} }, Buffer });
    return new vm.Script(`(function(msg){${source}\n})(JSON.parse(serializedMsg))`).runInContext(context, { timeout: 3000 });
  };
  const prepare = node("4f0f1ce8189a9e8c"), recalculate = node("2e70b2e547e77c00");
  phase = "legacy-guard-parity";
  const body = packet.fixture;
  const legacyCreate = run(prepare.func, { payload: body, req: { headers: {}, body, query: {} } });
  const legacyCreateMessage = Array.isArray(legacyCreate) ? legacyCreate.find(Boolean) : legacyCreate;
  const legacyUpdate = run(recalculate.func, { payload: body, req: { headers: {}, body: { tournamentId: body.tournamentId, results: [] }, query: {} } });
  const legacyPrepareStatus = Number(legacyCreateMessage.statusCode || 200), legacyUpdateStatus = Number(legacyUpdate.statusCode || 200);
  assert.ok(legacyPrepareStatus < 400 && legacyUpdateStatus < 400, "Existing common guard must not be bypassed");
  phase = "actual-create-chain";
  const wrapped = run(packet.prefixes.prepare + prepare.func, { payload: body, req: { headers: {}, body, query: {} } });
  assert.ok(wrapped[0] && !wrapped[1]);
  const upsert = run(node("f476ee4e8d98c43b").func, wrapped[0]);
  assert.equal(upsert.payload[0]._id, "fpr6x25:" + body.tournamentId);
  assert.equal(upsert.payload[0]["params.fpr6x25"].revision, 0);
  assert.ok(upsert.payload[1].$setOnInsert && !upsert.payload[1].$set && !upsert.payload[1].$unset);
  assert.equal(upsert.payload[2].upsert, true);
  const created = run(node("745f991e11130b08").func, { ...upsert, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 0 } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.params.fpr6x25.tournamentId, body.tournamentId);
  phase = "actual-update-cas-chain";
  const command = { id: "server-vm-start", expectedRevision: 0, action: "start_round" };
  const update = run(packet.prefixes.recalculate + recalculate.func, { payload: { ...body, _id: "fpr6x25:" + body.tournamentId }, req: { body: { params: { fprCommand: command }, results: [] } } });
  assert.equal(update.statusCode, 200);
  const routed = run(node("a73c590f8f001001").func, update);
  assert.ok(routed[0] && !routed[1]);
  const changed = routed[0];
  for (const rule of node("7ea8ad4e0b4105b5").rules) {
    assert.ok(rule.t === "set" && rule.pt === "msg" && rule.tot === "msg");
    changed[rule.p] = changed[rule.to];
  }
  const args = run(node("91fc0ea29c45e1df").func, changed);
  assert.equal(args.payload[0]["params.fpr6x25.revision"], 0);
  assert.equal(args.payload[0]._id, "fpr6x25:" + body.tournamentId);
  assert.equal(args.payload[2].upsert, false);
  const ack = run(node("a73c590f8f001002").func, { ...args, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } });
  assert.equal(ack.statusCode, 200);
  assert.equal(ack.payload.params.fpr6x25.audit[0].id, command.id);
  const conflict = run(node("a73c590f8f001002").func, { ...args, payload: { acknowledged: true, matchedCount: 0 } });
  assert.equal(conflict.statusCode, 409);
  phase = "installed-rating-worker-guard";
  const worker = fs.readFileSync("/opt/padlhub-rating-worker/current/scripts/rating_worker.mjs", "utf8");
  const begin = worker.indexOf("export function isTournamentFinalized(");
  const end = worker.indexOf("\nfunction resolveTournamentFinishedAt(", begin);
  const helper = worker.match(/^const isRecord = .*;$/m)?.[0];
  phase = `worker-guard-boundaries:${begin >= 0}:${end > begin}:${Boolean(helper)}`;
  assert.ok(begin >= 0 && end > begin && helper);
  const guard = worker.slice(begin, end).trim(), context = vm.createContext({});
  phase = "worker-guard-load";
  new vm.Script(helper + "\n" + guard.replace(/^export /, "") + "\nthis.check=isTournamentFinalized;").runInContext(context, { timeout: 1000 });
  const check = record => {
    context.serializedRecord = JSON.stringify(record);
    return new vm.Script("check(JSON.parse(serializedRecord))").runInContext(context, { timeout: 1000 });
  };
  const pending = structuredClone(body);
  pending.params.fpr6x25.status = "completed"; pending.params.fpr6x25.finishedAt = new Date().toISOString();
  phase = "worker-guard-pending-result";
  assert.equal(check(pending), false);
  const guardSha256 = crypto.createHash("sha256").update(helper + "\n" + guard).digest("hex");
  diagnostics.pendingFprIgnored = true;
  diagnostics.installedWorkerGuardSha256 = guardSha256;
  diagnostics.statusOnlyWhilePrivate = check({ ...pending, summary: { ...pending.summary, status: "completed" } });
  const finishAt = new Date().toISOString();
  const publishedLegacy = { ...pending, tournamentType: "americano_classic", params: { published: true, status: "completed", finished: true, finishedAt: finishAt },
    summary: { status: "completed", finished: true, finishedAt: finishAt, completedRounds: 6, totalRounds: 6, completedMatches: 6, totalMatches: 6 },
    rounds: Array.from({ length: 6 }, (_, i) => ({ id: `r${i + 1}`, index: i + 1, matches: [{ id: `m${i + 1}`, pair1: ["p1", "p2"], pair2: ["p3", "p4"], score1: 13, score2: 12 }] })) };
  diagnostics.publishedLegacyFinalized = check(publishedLegacy);
  phase = "worker-guard-published-legacy-control";
  assert.equal(diagnostics.publishedLegacyFinalized, true);
  console.log(JSON.stringify({ ok: true, readonly: true, fullFlowExported: false,
    sourceFlowSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    legacyPrepareStatus, legacyUpdateStatus, createChainInsertOnly: true, createAckHasProtocol: true,
    updateCasFilterPreserved: true, zeroMatchReturns409: true,
    installedWorkerGuardSha256: guardSha256, nestedFprCompletionIgnored: true, legacyFinishNegativeControls: diagnostics,
    commonGuardMarkers: { prepareMonthly: prepare.func.includes("monthly_tournament_"), recalculateMonthly: recalculate.func.includes("monthly_tournament_") },
  }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, readonly: true, phase, error: error.name, diagnostics }));
  process.exitCode = 1;
}
