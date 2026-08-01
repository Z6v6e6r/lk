import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (name) => fs.readFileSync(`scripts/nodered_games_nodes/${name}`, "utf8");
const run = (name, msg) => new Function("msg", read(name))(msg);

test("roster and metadata patches require an explicit game version", () => {
  for (const payload of [
    { participants: [] },
    { waitlist: [] },
    { metadata: { leaveEvents: [] } },
    { organizer: { id: "org-1" } },
  ]) {
    const outputs = run("fn_patch_cas_guard.js", {
      req: { params: { gameId: "game-1" } },
      payload,
    });
    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 428);
    assert.equal(outputs[1].payload.code, "GAME_PATCH_PRECONDITION_REQUIRED");
  }
});

test("non-roster patch preserves the legacy path without a precondition", () => {
  const msg = { req: { params: { gameId: "game-1" } }, payload: { status: "PAID" } };
  const outputs = run("fn_patch_cas_guard.js", msg);
  assert.equal(outputs[0], msg);
  assert.equal(outputs[1], null);
});

test("CAS query binds the exact expected updatedAt and remembers the next version", () => {
  const guarded = run("fn_patch_cas_guard.js", {
    req: { params: { gameId: "game-1" } },
    payload: { expectedUpdatedAt: "2026-08-01T09:00:00.000Z", participants: [] },
  })[0];
  guarded.payload = [
    { id: "game-1", archived: { $ne: true } },
    { $set: { participants: [], updatedAt: "2026-08-01T10:00:00.000Z" } },
    { upsert: false },
  ];
  const next = run("fn_patch_cas_query.js", guarded);
  assert.equal(next.payload[0].updatedAt, "2026-08-01T09:00:00.000Z");
  assert.equal(next._gamePatchCas.nextUpdatedAt, "2026-08-01T10:00:00.000Z");
  assert.equal(next.payload[1].$inc.revision, 1);
});

test("expectedRevision is accepted as an alternative CAS and increments revision", () => {
  const guarded = run("fn_patch_cas_guard.js", {
    req: { params: { gameId: "game-1" } },
    payload: { expectedRevision: 4, waitlist: [] },
  })[0];
  guarded.payload = [
    { id: "game-1", archived: { $ne: true } },
    { $set: { waitlist: [], updatedAt: "2026-08-01T10:00:00.000Z" } },
    { upsert: false },
  ];
  const next = run("fn_patch_cas_query.js", guarded);
  assert.equal(next.payload[0].revision, 4);
  assert.equal(next.payload[1].$inc.revision, 1);
  assert.equal(next._gamePatchCas.nextRevision, 5);

  const outputs = run("fn_patch_after_write.js", {
    ...next,
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(outputs[0].payload.revision, 5);
  assert.equal(outputs[2]._gameAutojoinPatch.patch.revision, 5);
});

test("invalid expectedRevision fails before Mongo", () => {
  for (const expectedRevision of [null, "", -1, 1.5, "not-a-number"]) {
    const out = run("fn_patch_cas_guard.js", {
      req: { params: { gameId: "game-1" } },
      payload: { expectedRevision, participants: [] },
    });
    assert.equal(out[0], null);
    assert.equal(out[1].statusCode, 400);
    assert.equal(out[1].payload.code, "GAME_PATCH_PRECONDITION_INVALID");
  }
});

test("null expectedUpdatedAt is an exact precondition for a legacy record without a version", () => {
  const guarded = run("fn_patch_cas_guard.js", {
    req: { params: { gameId: "legacy-game" } },
    payload: { expectedUpdatedAt: null, waitlist: [] },
  })[0];
  guarded.payload = [
    { id: "legacy-game", archived: { $ne: true } },
    { $set: { waitlist: [], updatedAt: "2026-08-01T10:00:00.000Z" } },
    { upsert: false },
  ];
  const next = run("fn_patch_cas_query.js", guarded);
  assert.deepEqual(next.payload[0].updatedAt, { $exists: false });
});

test("CAS response and autojoin are suppressed before Mongo acknowledgement", () => {
  const msg = { _gamePatchCas: { required: true } };
  assert.equal(run("fn_patch_response_gate.js", msg), null);
  assert.equal(run("fn_patch_autojoin_gate.js", msg), null);
});

test("matched write returns one success response and releases autojoin", () => {
  const outputs = run("fn_patch_after_write.js", {
    _gamePatchCas: {
      required: true,
      gameId: "game-1",
      nextUpdatedAt: "2026-08-01T10:00:00.000Z",
    },
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
  });
  assert.equal(outputs[0].statusCode, 200);
  assert.deepEqual(outputs[0].payload, {
    id: "game-1",
    updatedAt: "2026-08-01T10:00:00.000Z",
  });
  assert.equal(outputs[2]._gameAutojoinPatch.gameId, "game-1");
});

test("stale version returns 409 and never releases autojoin", () => {
  const outputs = run("fn_patch_after_write.js", {
    _gamePatchCas: { required: true, gameId: "game-1" },
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
  });
  assert.equal(outputs[0].statusCode, 409);
  assert.equal(outputs[0].payload.code, "GAME_PATCH_VERSION_CONFLICT");
  assert.equal(outputs[2], null);
});

test("Mongo errors and malformed acknowledgements fail closed", () => {
  const errorOutputs = run("fn_patch_after_write.js", {
    _gamePatchCas: { required: true, gameId: "game-1" },
    error: { message: "write failed" },
    payload: null,
  });
  assert.equal(errorOutputs[0].statusCode, 503);
  assert.equal(errorOutputs[2], null);

  const malformedOutputs = run("fn_patch_after_write.js", {
    _gamePatchCas: { required: true, gameId: "game-1" },
    payload: { acknowledged: true },
  });
  assert.equal(malformedOutputs[0].statusCode, 503);
  assert.equal(malformedOutputs[2], null);
});
