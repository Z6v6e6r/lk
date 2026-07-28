import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildGameRepairFilter,
  buildRatingEventRevertOperation,
  buildResultSessionResetOperation,
} from "../lib/resultRepairPartialSubmit.mjs";

const repairScriptSource = readFileSync(new URL("../repair_result_launch_period.mjs", import.meta.url), "utf8");

const common = {
  gameId: "pay_partial",
  nowIso: "2026-07-12T10:00:00.000Z",
  nowTs: 1783850400000,
  reason: "RESULT_LAUNCH_PERIOD_RESET",
  source: "repair_result_launch_period",
};

test("game repair filter guards the exact scanned result state", () => {
  const filter = buildGameRepairFilter({
    gameId: common.gameId,
    game: {
      id: common.gameId,
      resultId: "result_partial",
      resultStatus: "PENDING_REVIEW",
      resultLifecycleState: "PENDING_REVIEW",
      lastResultAt: "2026-07-10T14:00:00.000Z",
    },
  });

  assert.deepEqual(filter, {
    id: common.gameId,
    archived: { $ne: true },
    resultId: "result_partial",
    resultStatus: "PENDING_REVIEW",
    resultLifecycleState: "PENDING_REVIEW",
    lastResultAt: "2026-07-10T14:00:00.000Z",
  });
});

test("game repair filter also guards fields that were absent at scan time", () => {
  const filter = buildGameRepairFilter({ gameId: common.gameId, game: { id: common.gameId } });

  assert.deepEqual(filter.resultId, { $exists: false });
  assert.deepEqual(filter.resultStatus, { $exists: false });
  assert.deepEqual(filter.resultLifecycleState, { $exists: false });
  assert.deepEqual(filter.lastResultAt, { $exists: false });
});

test("apply claims the scanned game state before rating rollback and only deletes scanned results", () => {
  const gameUpdateIndex = repairScriptSource.indexOf("const gameResult = await games.updateOne(");
  const ratingUpdateIndex = repairScriptSource.indexOf("await ratings.bulkWrite(");

  assert.ok(gameUpdateIndex >= 0);
  assert.ok(ratingUpdateIndex > gameUpdateIndex);
  assert.match(repairScriptSource, /if \(Number\(gameResult\.matchedCount \|\| 0\) === 0\)/);
  assert.match(repairScriptSource, /\{ gameId, id: \{ \$in: resultIds \}, deleted: \{ \$ne: true \} \}/);
});

test("pending orphan rating event is reverted with an optimistic status guard", () => {
  const operation = buildRatingEventRevertOperation({
    ...common,
    event: {
      _id: "rate_partial",
      id: "rate_partial",
      gameId: common.gameId,
      resultId: "result_missing",
      status: "PENDING_CONFIRMATION",
    },
    activeResultIds: [],
  });

  assert.deepEqual(operation?.updateOne.filter, {
    _id: "rate_partial",
    gameId: common.gameId,
    status: "PENDING_CONFIRMATION",
  });
  assert.equal(operation?.updateOne.update.$set.status, "REVERTED");
  assert.equal(operation?.updateOne.update.$set.repair.orphanedResult, true);
  assert.equal(operation?.updateOne.update.$set.repair.previousStatus, "PENDING_CONFIRMATION");
  assert.equal(operation?.updateOne.upsert, false);
});

test("already reverted rating event is not rewritten", () => {
  const operation = buildRatingEventRevertOperation({
    ...common,
    event: { _id: "rate_done", gameId: common.gameId, status: "REVERTED" },
    activeResultIds: [],
  });

  assert.equal(operation, null);
});

test("active session reset clears drafts and snapshots and invalidates stale revision", () => {
  const operation = buildResultSessionResetOperation({
    ...common,
    session: {
      _id: "result_session_pay_partial",
      gameId: common.gameId,
      status: "ACTIVE",
      revision: 7,
      deleted: false,
    },
    resultIds: ["result_partial"],
  });

  assert.deepEqual(operation?.updateOne.filter, {
    _id: "result_session_pay_partial",
    gameId: common.gameId,
    deleted: { $ne: true },
    revision: 7,
  });
  assert.equal(operation?.updateOne.update.$set.status, "RESET_FOR_REOPEN");
  assert.equal(operation?.updateOne.update.$set.revision, 8);
  assert.deepEqual(operation?.updateOne.update.$set.draftSets, []);
  assert.deepEqual(operation?.updateOne.update.$set.draftPairings, []);
  assert.deepEqual(operation?.updateOne.update.$set.attachments, []);
  assert.equal(operation?.updateOne.update.$unset.resultRosterSnapshot, "");
  assert.equal(operation?.updateOne.update.$unset.rosterSnapshot, "");
  assert.deepEqual(operation?.updateOne.update.$set.resultRepair.resultIds, ["result_partial"]);
  assert.equal(operation?.updateOne.upsert, false);
});

test("deleted session is never reset", () => {
  const operation = buildResultSessionResetOperation({
    ...common,
    session: { _id: "deleted", gameId: common.gameId, deleted: true, revision: 1 },
    resultIds: [],
  });

  assert.equal(operation, null);
});
