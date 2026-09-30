// «Дружба 2 часа» — the guarded migration of the LK1 subscription contour.
//
// The packet patches the installed generation of the booking gateway (func + plan-rules
// writer), the price preview, the managed-policy evaluator and both status nodes. The tests
// pin the reviewed targets, prove every delta is an exact inverse of its own revert, and —
// when a fresh live snapshot is supplied — compose the candidate against it and compare the
// result with the digest that was actually applied on 147.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVALUATOR_DELTAS,
  FRIENDSHIP_TWO_HOURS_PRODUCT_ID,
  FRIENDSHIP_TWO_HOURS_SOURCE_NODE_COUNT,
  FRIENDSHIP_TWO_HOURS_SOURCE_SHA256,
  FRIENDSHIP_TWO_HOURS_TARGETS,
  PLAN_STORE_DELTAS,
  applyDeltas,
  composeFriendshipTwoHoursArtifacts,
  revertDeltas,
} from "../patch_live_lk1_friendship_two_hours_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_FRIENDSHIP_TWO_HOURS_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-two-hours-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_FRIENDSHIP_TWO_HOURS_LIVE_SNAPSHOT)`;
/** The digest the guarded installer published on 147 on 2026-09-30 (deployment lk1-friendship-two-hours). */
const APPLIED_CANDIDATE_SHA256 = "cc2d76f4ad9b7462cb5534434a52d9e8a58633a9c2134b179cb7b921b871c80f";

const deltas = [...PLAN_STORE_DELTAS, ...EVALUATOR_DELTAS];

test("the packet pins exactly the six reviewed fields of the five live nodes", () => {
  assert.deepEqual(Object.keys(FRIENDSHIP_TWO_HOURS_TARGETS).sort(),
    ["evaluator", "gateway", "preview", "statusPrepare", "statusResponse"]);
  for (const [key, target] of Object.entries(FRIENDSHIP_TWO_HOURS_TARGETS)) {
    assert.match(target.id, /^[A-Za-z0-9_-]{6,}$/, key);
    assert.match(target.liveFuncSha256, /^[a-f0-9]{64}$/, key);
  }
  assert.equal(FRIENDSHIP_TWO_HOURS_SOURCE_NODE_COUNT, 4804);
  assert.match(FRIENDSHIP_TWO_HOURS_SOURCE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(FRIENDSHIP_TWO_HOURS_TARGETS.gateway.liveInitializeSha256, /^[a-f0-9]{64}$/);
});

test("every delta is unique, additive and an exact inverse of its own revert", () => {
  const ids = deltas.map((delta) => delta.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const delta of deltas) {
    assert.ok(delta.before.length > 40, delta.id);
    assert.notEqual(delta.before, delta.after, delta.id);
    // A delta either replaces its anchor or prepends to it, so the anchor survives at most
    // once and the revert stays unambiguous.
    const embedded = delta.after.includes(delta.before) ? 1 : 0;
    assert.equal(delta.after.split(delta.before).length - 1, embedded, delta.id);
    // A synthetic body proves apply -> revert is byte-exact for every delta on its own.
    const synthetic = `const a = 1;\n${delta.before}\nconst b = 2;\n`;
    const applied = applyDeltas(synthetic, [delta], delta.id);
    assert.notEqual(applied, synthetic, delta.id);
    assert.equal(revertDeltas(applied, [delta], delta.id), synthetic, delta.id);
    assert.throws(() => applyDeltas(synthetic, [delta, delta], delta.id),
      /anchor drift|already carries/, delta.id);
  }
});

test("the plan-store deltas carry the two-hour plan and the day scope", () => {
  const text = PLAN_STORE_DELTAS.map((delta) => delta.after).join("\n");
  assert.ok(text.includes(`friendship_two_hours: "${FRIENDSHIP_TWO_HOURS_PRODUCT_ID}"`));
  assert.ok(text.includes('friendship_two_hours: ["open_game", "tournament"]'));
  assert.ok(text.includes("const LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES = Object.freeze({"));
  assert.ok(text.includes("5278"), "the «Время на друзей» direction must be scoped");
  assert.ok(text.includes("const freeFirstCovered = lk1FreeFirstEventCovers("));
  assert.ok(EVALUATOR_DELTAS[0].after.includes("!aboveActiveLimit"));
  // The marker branch must sit before the generic friendship branch, otherwise a
  // «Дружба 2 часа» name marker would resolve to the old plan.
  const marker = PLAN_STORE_DELTAS.find((delta) => delta.id === "plan-name-markers");
  assert.ok(marker.after.indexOf("friendship_two_hours") < marker.after.indexOf('return "friendship";'));
});

test("the status bodies are swapped for the reviewed repository sources", () => {
  for (const [relative, nodeKey] of [
    ["scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js", "statusPrepare"],
    ["scripts/nodered_games_nodes/fn_tournament_subscription_status_response.js", "statusResponse"],
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(FRIENDSHIP_TWO_HOURS_TARGETS[nodeKey].liveFuncSha256, /^[a-f0-9]{64}$/);
    assert.ok(source.includes("friendship_two_hours"), relative);
    assert.ok(source.includes(`"${FRIENDSHIP_TWO_HOURS_PRODUCT_ID}"`), relative);
  }
});

test("the candidate composes from the installed flow and reverts byte-for-byte", { skip: snapshotSkip }, () => {
  const liveBytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeFriendshipTwoHoursArtifacts(liveBytes, "lk1-friendship-two-hours");
  assert.equal(built.sourceSha256, FRIENDSHIP_TWO_HOURS_SOURCE_SHA256, "the snapshot is not the reviewed preimage");
  assert.equal(built.changes.length, 5);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.flow.length, FRIENDSHIP_TWO_HOURS_SOURCE_NODE_COUNT);
  assert.deepEqual(Object.values(built.preview), [true, true, true, true, true, true]);
  const flow = JSON.parse(liveBytes.toString("utf8"));
  const gateway = flow.find((node) => node.id === FRIENDSHIP_TWO_HOURS_TARGETS.gateway.id);
  const evaluator = flow.find((node) => node.id === FRIENDSHIP_TWO_HOURS_TARGETS.evaluator.id);
  assert.equal(revertDeltas(applyDeltas(gateway.func, PLAN_STORE_DELTAS, "gateway"), PLAN_STORE_DELTAS, "gateway"),
    gateway.func);
  assert.equal(revertDeltas(applyDeltas(evaluator.func, EVALUATOR_DELTAS, "evaluator"), EVALUATOR_DELTAS, "evaluator"),
    evaluator.func);
  // The candidate that was published on 147 carries exactly this digest.
  assert.equal(built.candidateSha256, APPLIED_CANDIDATE_SHA256,
    "the composed candidate differs from the deployed one — re-review before any apply");
});

test("a drifted flow or node body is refused", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  flow.push({ id: "lk1-foreign-node", type: "function", func: "return msg;" });
  assert.throws(() => composeFriendshipTwoHoursArtifacts(
    Buffer.from(`${JSON.stringify(flow, null, 2)}\n`), "lk1-friendship-two-hours"), /preimage drift|node count drift/);
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === FRIENDSHIP_TWO_HOURS_TARGETS.evaluator.id).func += "\n// foreign edit\n";
  assert.throws(() => composeFriendshipTwoHoursArtifacts(
    Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`), "lk1-friendship-two-hours"), /preimage drift/);
});
