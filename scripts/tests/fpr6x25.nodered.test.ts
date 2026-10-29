import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { buildFprNodeFunction, FPR_PREFIX_END } from "../nodered_fpr6x25.mjs";
import { patchFprFlow, fprSha256 } from "../patch_live_fpr6x25.mjs";
import { createFprState, fprProjection } from "../../src/components/tournaments/fpr6x25.ts";
import { isTournamentFinalized } from "../lib/tournamentFinalization.mjs";
import { planCommunityTournamentClose } from "../lib/communityMonthlyFinalization.mjs";

const legacyPrepare = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_prepare.js", "utf8");
const legacyRecalculate = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_recalculate.js", "utf8");
const legacyHistoryGuard = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_history_request_guard.js", "utf8");
const legacyCommunityQuery = fs.readFileSync("scripts/nodered_tournament_community_nodes/fn_tournament_community_publications_query.js", "utf8");
const prepare = new Function("msg", buildFprNodeFunction(legacyPrepare, "prepare"));
const recalculate = new Function("msg", buildFprNodeFunction(legacyRecalculate, "recalculate"));
function fixture() {
  const state = createFprState({ tournamentId: `fpr-${crypto.randomUUID()}`, players: Array.from({ length: 8 }, (_, i) => ({
    id: `p${i + 1}`, name: `Player ${i + 1}`, leaguePoints: 0, leaguePlace: null, level: 3,
  })), courts: ["Court 1", "Court 2"], leagueSource: "League snapshot", now: new Date(Date.now() - 1000).toISOString(),
  endsAt: new Date(Date.now() + 180 * 60_000).toISOString(), reserveAllowed: true });
  return { _id: `fpr6x25:${state.tournamentId}`, tournamentId: state.tournamentId, tournamentType: "fpr_6x25", tenantKey: "test",
    organizer: { id: "organizer" }, participants: state.players.map(p => ({ id: p.id, name: p.name })), ...fprProjection(state) };
}
function update(document: ReturnType<typeof fixture>, action: Record<string, unknown>) {
  const before = document.params.fpr6x25;
  const out = recalculate({ payload: structuredClone(document), req: { body: {
    results: [], params: { fprCommand: { id: crypto.randomUUID(), expectedRevision: before.revision, ...action } },
  } } });
  assert.equal(out.statusCode, 200, JSON.stringify(out.payload));
  assert.equal(out.mongoQuery["params.fpr6x25.revision"], before.revision);
  assert.equal(out.mongoQuery._id, document._id);
  return { ...document, ...out.mongoUpdate.$set };
}

test("FPR create is canonical, insert-only, fixes the sum at 25, strips legacy completion and level events", () => {
  const input = fixture();
  input.params = { ...input.params, finished: true, published: true, status: "completed" };
  const [out, error] = prepare({ payload: { ...input, targetScore: 99, startRatingChanges: [{ eventId: "unsafe" }] } });
  assert.equal(error, null);
  assert.equal(out.query._id, input._id);
  assert.equal(out.query["params.fpr6x25"].revision, 0);
  assert.equal(out.payload.$set, undefined);
  assert.equal(out.payload.$setOnInsert.targetScore, 25);
  assert.deepEqual(out.payload.$setOnInsert.startRatingChanges, []);
  assert.equal(out.payload.$setOnInsert.params.finished, false);
  assert.equal(out.payload.$setOnInsert.params.published, false);
  assert.equal(isTournamentFinalized(out.payload.$setOnInsert), false);
});

test("FPR create rejects changed seeds, roster mismatch, legacy event IDs and already started states", () => {
  for (const change of [
    (t: ReturnType<typeof fixture>) => { t.params.fpr6x25.players.reverse(); },
    (t: ReturnType<typeof fixture>) => { t.participants.pop(); },
    (t: ReturnType<typeof fixture>) => { t.tournamentId = "12345"; t.params.fpr6x25.tournamentId = "12345"; },
    (t: ReturnType<typeof fixture>) => { t.params.fpr6x25.status = "in_progress"; },
  ]) {
    const input = fixture(); change(input);
    const [mongo, out] = prepare({ payload: input });
    assert.equal(mongo, null); assert.equal(out.statusCode, 422); assert.equal(out.query, undefined);
  }
});

test("FPR commands use CAS and idempotency; legacy result/finish payload cannot bypass the reducer", () => {
  let doc = fixture();
  const before = structuredClone(doc);
  const cmd = { id: "stable-start", expectedRevision: 0, action: "start_round" };
  const run = (data: typeof doc, command: typeof cmd) => recalculate({ payload: data, req: { body: { params: { fprCommand: command } } } });
  const out = run(doc, cmd);
  assert.equal(out.statusCode, 200);
  doc = { ...doc, ...out.mongoUpdate.$set };
  const retry = run(doc, cmd);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.payload.params.fpr6x25.revision, 1);
  assert.equal(retry.payload.params.fpr6x25.audit.length, 1);
  const conflict = run(doc, { ...cmd, id: "other-start" });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.mongoUpdate, undefined);
  const bypass = recalculate({ payload: structuredClone(before), req: { body: { results: [{ score1: 25, score2: 0 }], params: { finished: true } } } });
  assert.equal(bypass.statusCode, 422); assert.equal(bypass.mongoUpdate, undefined);
});

test("complete FPR event stays ineligible for both current rating workers and generic monthly closure", () => {
  let doc = fixture();
  for (let r = 1; r <= 6; r += 1) {
    doc = update(doc, { action: "start_round" });
    for (const m of doc.params.fpr6x25.attempts.at(-1)!.matches) {
      doc = update(doc, { action: "score", matchId: m.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true });
    }
    doc = update(doc, { action: "close_round" });
  }
  doc = update(doc, { action: "finish" });
  assert.equal(doc.params.fpr6x25.status, "completed");
  assert.equal(doc.params.fpr6x25.attempts.filter(a => a.status === "closed").length, 6);
  assert.deepEqual(doc.rounds, []);
  assert.equal(doc.summary.completedRounds, 0);
  assert.equal(doc.summary.completedMatches, 0);
  assert.equal(doc.summary.totalMatches, 0);
  assert.equal(isTournamentFinalized(doc), false);
  assert.ok(doc.standings.every((p: Record<string, unknown>) => !["ratingBefore", "ratingAfter", "ratingDelta", "deltaTotal"].some(key => key in p)));
  assert.deepEqual(doc.totals, {});
  const plan = planCommunityTournamentClose({ tournament: doc, now: new Date(Date.now() + 4 * 3600_000).toISOString() });
  assert.equal(plan.close, false);

  // After a backend rollback, a cached client can submit another FPR command to
  // the original generic reducer. It must neither acknowledge it nor finalize.
  const command = { id: "cached-client-after-rollback", expectedRevision: doc.params.fpr6x25.revision, action: "finish" };
  const legacy = new Function("msg", legacyRecalculate)({ payload: structuredClone(doc),
    req: { body: { results: [], params: { fprCommand: command } } } });
  const afterRollback = { ...doc, ...legacy.mongoUpdate.$set };
  assert.equal(afterRollback.summary.status, "in_progress");
  assert.equal(isTournamentFinalized(afterRollback), false);
  assert.deepEqual(afterRollback.params.fpr6x25, doc.params.fpr6x25);
  assert.equal(afterRollback.params.fpr6x25.audit.some(entry => entry.id === command.id), false);
  assert.equal(planCommunityTournamentClose({ tournament: afterRollback, now: new Date(Date.now() + 4 * 3600_000).toISOString() }).close, false);
  const unsafe = { ...structuredClone(doc), rounds: doc.params.fpr6x25.attempts.filter(a => a.status === "closed").map(a => ({
    id: a.id, index: a.round, byes: a.byes, matches: a.matches.map(m => ({ ...m, court: doc.params.fpr6x25.courts[m.courtIndex] })),
  })) };
  const control = new Function("msg", legacyRecalculate)({ payload: unsafe, req: { body: { results: [], params: { fprCommand: command } } } });
  assert.equal(isTournamentFinalized({ ...unsafe, ...control.mongoUpdate.$set }), true);
});

test("guarded patch upgrades only four function bodies and preserves exact live legacy suffixes", () => {
  const flow = [
    { id: "prepare", type: "function", name: "Prepare", func: legacyPrepare, wires: [["db"], ["error"]] },
    { id: "recalculate", type: "function", name: "Recalculate", func: legacyRecalculate, wires: [["persist"]] },
    { id: "history_guard", type: "function", name: "History guard", func: legacyHistoryGuard, wires: [["response"], ["history-db"]] },
    { id: "community_context", type: "function", name: "Community query", func: legacyCommunityQuery, wires: [["publications-db"]] },
    { id: "route", type: "http in", url: "/lk/tournaments/americano", method: "post", wires: [["prepare"]] },
  ];
  const bytes = Buffer.from(JSON.stringify(flow));
  const contract = { flowSha256: fprSha256(bytes), nodes: flow.slice(0, 4).map(n => ({ id: n.id, name: n.name, kind: n.id, sha256: fprSha256(n.func) })) };
  const patched = patchFprFlow(bytes, contract);
  assert.equal(patched.report.changes.length, 4);
  const candidate = JSON.parse(patched.output);
  for (let i = 0; i < 4; i += 1) assert.equal(candidate[i].func.split(FPR_PREFIX_END)[1], flow[i].func);
  assert.deepEqual(candidate[4], flow[4]);
  const upgradedBytes = Buffer.from(patched.output);
  const upgradeContract = { flowSha256: fprSha256(upgradedBytes), nodes: candidate.slice(0, 4).map(n => ({ id: n.id, name: n.name, kind: n.id, sha256: fprSha256(n.func) })) };
  // An identical upgrade has no four-function diff and is refused rather than
  // fabricating another deployment or nesting a second prefix.
  assert.throws(() => patchFprFlow(upgradedBytes, upgradeContract), /Unexpected flow/);
  assert.throws(() => patchFprFlow(bytes, { ...contract, flowSha256: "0".repeat(64) }), /preimage/);
  assert.throws(() => patchFprFlow(bytes, { ...contract, nodes: contract.nodes.map((n, i) => i ? n : { ...n, sha256: "0".repeat(64) }) }), /preimage/);
});

test("community context reads work before a protocol exists and do not enter the normal history cache", () => {
  const id = "9bbaeb68-c883-480d-a9a0-cd43267a679a";
  const query = new Function("msg", buildFprNodeFunction(legacyCommunityQuery, "community_context"));
  const attach = new Function("msg", fs.readFileSync("scripts/nodered_tournament_community_nodes/fn_tournament_community_publications_attach.js", "utf8"));
  const msg = query({ payload: [], _tournamentHistoryCacheKey: `id:${id}`, req: { query: { tournamentId: id, fprCommunityContext: "1" } } });
  assert.equal(msg._tournamentHistoryCacheKey, undefined);
  assert.ok(msg.payload.$or.some((c: Record<string, unknown>) => c.relatedTournamentId === id));
  msg.payload = [{ id: "post1", communityId: "club", communityName: "Club", kind: "TOURNAMENT", relatedTournamentId: id }];
  const result = attach(msg);
  assert.equal(result.payload[0].communityContextOnly, true); assert.equal(result.payload[0].ratingCommunityId, "club");
  assert.equal(result.payload[0].tournamentId, id); assert.equal(result.payload[0].participants, undefined);
});

test("fresh FPR history bypasses only its cache entry while preserving legacy cache and rate limits", () => {
  const fprId = `fpr-${crypto.randomUUID()}`;
  const store: Record<string, unknown> = { lkTournamentHistoryResponseCache: {
    [`id:${fprId}`]: { expiresAt: Date.now() + 10000, payload: [{ revision: "stale" }] },
    "id:legacy": { expiresAt: Date.now() + 10000, payload: [{ marker: "legacy" }] },
  } };
  const flow = { get: (key: string) => store[key], set: (key: string, value: unknown) => { store[key] = value; } };
  const run = new Function("msg", "flow", buildFprNodeFunction(legacyHistoryGuard, "history_guard"));
  const fresh = run({ req: { query: { tournamentId: fprId, readback: "1" }, headers: { "x-real-ip": "test" } } }, flow);
  assert.equal(fresh[0], null); assert.equal(fresh[1]._tournamentHistoryCacheKey, `id:${fprId}`);
  const legacy = run({ req: { query: { tournamentId: "legacy", readback: "1" }, headers: { "x-real-ip": "test" } } }, flow);
  assert.deepEqual(legacy[0].payload, [{ marker: "legacy" }]);
  const contextRead = run({ req: { query: { tournamentId: "legacy", fprCommunityContext: "1" }, headers: { "x-real-ip": "context-test" } } }, flow);
  assert.equal(contextRead[0], null); assert.equal(contextRead[1]._tournamentHistoryCacheKey, "id:legacy");
  const invalidContext = run({ req: { query: { tournamentId: "../invalid", fprCommunityContext: "1" }, headers: {} } }, flow);
  assert.equal(invalidContext[0].statusCode, 422); assert.equal(invalidContext[1], null);
  let last;
  for (let i = 0; i < 24; i += 1) last = run({ req: { query: { tournamentId: fprId, readback: String(i + 2) }, headers: { "x-real-ip": "test" } } }, flow);
  assert.equal(last[0].statusCode, 429);
});

test("legacy tournament preparation is unchanged by the conditional dispatch", () => {
  const input = { payload: { tournamentId: "old-type-example", tournamentType: "americano_classic", createdAt: "2026-10-28T00:00:00Z", participants: [], rounds: [] } };
  const legacy = new Function("msg", legacyPrepare)(structuredClone(input));
  const wrapped = prepare(structuredClone(input));
  delete legacy[0].payload.$set.updatedAt; delete wrapped[0].payload.$set.updatedAt;
  assert.deepEqual(wrapped, legacy);
});
