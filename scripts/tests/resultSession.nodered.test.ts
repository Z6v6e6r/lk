import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function readNodeRedFunctionSource(file: string) {
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8");
  }

  if (file.endsWith("fn_result_session_update_build.js")) {
    const flow = JSON.parse(fs.readFileSync("node-red/modular/source.flow.json", "utf8"));
    const node = Array.isArray(flow)
      ? flow.find((item) => item?.id === "result_session_update_build_002")
      : null;
    if (node?.func) {
      return String(node.func);
    }
  }

  throw new Error(`Node-RED function source not found for ${file}`);
}

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = readNodeRedFunctionSource(file);
  return new Function("msg", source)(msg);
}

function sessionGame(overrides: Record<string, unknown> = {}) {
  return {
    id: "game-1",
    booking: {
      date: "2026-06-03",
      timeFrom: "19:00",
      timeTo: "20:30",
      endTs: Date.now() - 60_000,
      vivaExerciseId: "viva-1",
    },
    participants: [
      { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
      { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3.2 },
      { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: 3.3 },
      { id: "p4", phoneNorm: "79000000004", name: "B2", ratingNumeric: 3.4 },
    ],
    waitlist: [
      { id: "p5", phoneNorm: "79000000005", name: "WL", ratingNumeric: 3.5 },
    ],
    ...overrides,
  };
}

function openResultSession(gameOverrides: Record<string, unknown> = {}) {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_session_open_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: { phone: "79000000001" },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [sessionGame(gameOverrides)];

  const sessionQueryOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_prepare_session_query.js",
    prepared,
  ) as any[];
  const sessionQueryMsg = sessionQueryOut[0] as Record<string, any>;
  sessionQueryMsg.payload = [];

  const buildOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_build.js",
    sessionQueryMsg,
  ) as any[];
  const writeMsg = buildOut[0] as Record<string, any>;
  const afterWriteOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_after_write.js",
    {
      ...writeMsg,
      payload: [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }],
    },
  ) as any[];

  return {
    prepared,
    sessionQueryMsg,
    writeMsg,
    responseMsg: afterWriteOut[0] as Record<string, any>,
  };
}

function materializeInsertedSession(writeMsg: Record<string, any>) {
  const updateDoc = writeMsg.payload[1];
  return {
    _id: writeMsg.payload[0]._id,
    id: writeMsg.payload[0]._id,
    gameId: "game-1",
    revision: updateDoc.$setOnInsert?.revision ?? updateDoc.$set?.revision ?? 1,
    resultRosterSnapshot: updateDoc.$setOnInsert?.resultRosterSnapshot ?? updateDoc.$set?.resultRosterSnapshot,
    rosterSnapshot: updateDoc.$setOnInsert?.rosterSnapshot ?? updateDoc.$set?.rosterSnapshot,
    draftSets: updateDoc.$setOnInsert?.draftSets ?? [],
    draftPairings: updateDoc.$setOnInsert?.draftPairings ?? [],
    attachments: updateDoc.$setOnInsert?.attachments ?? [],
    openedBy: updateDoc.$setOnInsert?.openedBy ?? null,
  };
}

test("open session upsert does not send conflicting set and setOnInsert paths", () => {
  const { writeMsg } = openResultSession();
  const updateDoc = writeMsg.payload[1];
  const setPaths = new Set(Object.keys(updateDoc.$set || {}));
  const insertPaths = Object.keys(updateDoc.$setOnInsert || {});
  const conflicts = insertPaths.filter((path) => setPaths.has(path));

  assert.deepEqual(conflicts, []);
  assert.ok(updateDoc.$set.resultRosterSnapshot);
  assert.ok(updateDoc.$set.rosterSnapshot);
  assert.equal(updateDoc.$setOnInsert.resultRosterSnapshot, undefined);
  assert.equal(updateDoc.$setOnInsert.rosterSnapshot, undefined);
});

test("open session returns opaque member keys and strips private identifiers from public dto", () => {
  const { writeMsg, responseMsg } = openResultSession();

  assert.equal(responseMsg.payload.sessionId, "result_session_game-1");
  assert.equal(responseMsg.payload.isRestored, false);
  assert.equal(responseMsg.payload.rosterSnapshot.playerPool.length, 5);
  assert.equal(responseMsg.payload.draftPairings.length, 1);
  assert.equal(writeMsg.payload[2].upsert, true);

  const publicJson = JSON.stringify(responseMsg.payload);
  assert.doesNotMatch(publicJson, /7900000000|"id":|participantPhones|waitlistPhones|allRelatedPhones/);
  responseMsg.payload.rosterSnapshot.playerPool.forEach((player: any) => {
    assert.match(player.memberKey, /^rm_[a-z0-9]+$/i);
  });
  responseMsg.payload.draftPairings[0].teamSlots.forEach((slot: any) => {
    assert.match(slot.memberKey, /^rm_[a-z0-9]+$/i);
    assert.equal("id" in slot, false);
  });
});

test("open session restores existing legacy pairings and remaps them to opaque member keys", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_session_open_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: { phone: "79000000001" },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [sessionGame()];

  const sessionQueryOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_prepare_session_query.js",
    prepared,
  ) as any[];
  const sessionQueryMsg = sessionQueryOut[0] as Record<string, any>;
  sessionQueryMsg.payload = [
    {
      _id: "result_session_game-1",
      id: "result_session_game-1",
      gameId: "game-1",
      revision: 5,
      draftSets: [{ left: 6, right: 4 }],
      draftPairings: [
        {
          setIndex: 0,
          teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }],
        },
        {
          setIndex: 2,
          teamSlots: [{ id: "p1" }, { id: "p3" }, { id: "p2" }, { id: "p4" }],
        },
      ],
      attachments: [{ id: "photo-1" }],
      resultRosterSnapshot: {
        members: [
          { memberKey: "id:p1", id: "p1", phoneNorm: "79000000001", name: "A1" },
          { memberKey: "id:p2", id: "p2", phoneNorm: "79000000002", name: "A2" },
          { memberKey: "id:p3", id: "p3", phoneNorm: "79000000003", name: "B1" },
          { memberKey: "id:p4", id: "p4", phoneNorm: "79000000004", name: "B2" },
        ],
        initialTeamMemberKeys: ["id:p1", "id:p2", "id:p3", "id:p4"],
      },
      openedBy: { memberKey: "id:p1", name: "A1" },
    },
  ];

  const buildOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_build.js",
    sessionQueryMsg,
  ) as any[];
  const writeMsg = buildOut[0] as Record<string, any>;
  const afterWriteOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_after_write.js",
    {
      ...writeMsg,
      payload: [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }],
    },
  ) as any[];
  const responseMsg = afterWriteOut[0] as Record<string, any>;

  assert.equal(responseMsg.payload.isRestored, true);
  assert.equal(responseMsg.payload.revision, 5);
  assert.equal(responseMsg.payload.draftPairings.length, 2);
  responseMsg.payload.draftPairings[1].teamSlots.forEach((slot: any) => {
    assert.match(slot.memberKey, /^rm_[a-z0-9]+$/i);
    assert.equal("id" in slot, false);
  });
});

test("open session reconciles a stale legacy snapshot by clientId without duplicating the actor", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_session_open_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    _resultActor: { id: "p1", phoneNorm: null, name: "P1", verified: true },
    payload: { actor: { id: "p1" } },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [sessionGame({
    participants: [
      { clientId: "p1", phoneNorm: "79000000001", name: "P1" },
      { clientId: "p2", phoneNorm: null, name: "P2" },
      { clientId: "p3", phoneNorm: null, name: "P3" },
      { clientId: "p4", phoneNorm: null, name: "P4" },
    ],
    waitlist: [],
    resultRosterSnapshot: {
      version: 1,
      playerPool: [
        { memberKey: "phone:79000000001", clientId: "p1", phoneNorm: "79000000001", name: "P1" },
      ],
      initialTeamSlots: [
        { clientId: "p1" },
        { clientId: "p2" },
        { clientId: "p3" },
        { clientId: "p4" },
      ],
    },
  })];

  const queryOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_prepare_session_query.js",
    prepared,
  ) as any[];
  const queryMsg = queryOut[0];
  queryMsg.payload = [{
    _id: "result_session_game-1",
    gameId: "game-1",
    revision: 13,
    draftSets: [{ left: 6, right: 2 }, { left: 6, right: 3 }, { left: 4, right: 3 }],
    draftPairings: [],
    attachments: [],
    resultRosterSnapshot: {
      version: "result-roster-snapshot-v1",
      members: [
        { memberKey: "phone:79000000001", clientId: "p1", phoneNorm: "79000000001", name: "P1" },
      ],
      initialTeamMemberKeys: ["phone:79000000001"],
    },
  }];

  const buildOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_build.js",
    queryMsg,
  ) as any[];
  const writeMsg = buildOut[0];
  const internalSnapshot = writeMsg.payload[1].$set.resultRosterSnapshot;
  assert.equal(internalSnapshot.version, "result-roster-snapshot-v3");
  assert.equal(internalSnapshot.members.length, 4);
  assert.equal(internalSnapshot.members.filter((member: any) => member.id === "p1").length, 1);
  assert.deepEqual(writeMsg._resultSessionResponse.draftSets, [
    { left: 6, right: 2 },
    { left: 6, right: 3 },
    { left: 4, right: 3 },
  ]);
});

test("session update accepts opaque member keys for substitutions and increments revision", () => {
  const { writeMsg, responseMsg } = openResultSession();
  const storedSession = materializeInsertedSession(writeMsg);
  const rosterPlayers = responseMsg.payload.rosterSnapshot.playerPool as Array<Record<string, any>>;
  const byName = new Map(rosterPlayers.map((player) => [player.name, player]));

  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_session_update_prepare.js", {
    req: { params: { gameId: "game-1", sessionId: "result_session_game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      revision: 1,
      draftSets: [{ left: 6, right: 4 }, { left: 4, right: 6 }, { left: 6, right: 1 }],
      draftPairings: [
        { setIndex: 0, slots: [byName.get("A1")?.memberKey, byName.get("A2")?.memberKey, byName.get("B1")?.memberKey, byName.get("B2")?.memberKey] },
        { setIndex: 1, slots: [byName.get("WL")?.memberKey, byName.get("A2")?.memberKey, byName.get("B1")?.memberKey, byName.get("B2")?.memberKey] },
        { setIndex: 2, slots: [byName.get("WL")?.memberKey, byName.get("B1")?.memberKey, byName.get("A1")?.memberKey, byName.get("B2")?.memberKey] },
      ],
    },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [storedSession];

  const buildOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_update_build.js",
    prepared,
  ) as any[];
  const writeUpdate = buildOut[0] as Record<string, any>;
  const afterWriteOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_update_after_write.js",
    {
      ...writeUpdate,
      payload: [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }],
    },
  ) as any[];
  const responseUpdate = afterWriteOut[0] as Record<string, any>;

  assert.equal(responseUpdate.payload.revision, 2);
  assert.equal(responseUpdate.payload.draftPairings.length, 3);
  assert.deepEqual(
    responseUpdate.payload.draftPairings[1].teamSlots.map((slot: any) => slot.name),
    ["WL", "A2", "B1", "B2"],
  );
  assert.equal(writeUpdate.payload[1].$set.revision, 2);
});

test("session update rejects stale revision conflicts when actor belongs to the stored roster", () => {
  const { writeMsg } = openResultSession();
  const storedSession = materializeInsertedSession(writeMsg);

  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_session_update_prepare.js", {
    req: { params: { gameId: "game-1", sessionId: "result_session_game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      revision: 1,
      draftSets: [{ left: 6, right: 4 }],
    },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [{ ...storedSession, revision: 3 }];

  const buildOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_update_build.js",
    prepared,
  ) as any[];

  assert.equal(buildOut[0], null);
  assert.equal(buildOut[1].statusCode, 409);
  assert.equal(buildOut[1].payload.error, "Result session revision conflict");
});

test("submit persists session metadata and stores only sanitized roster snapshot in immutable result doc", () => {
  const { responseMsg } = openResultSession();
  const rosterPlayers = responseMsg.payload.rosterSnapshot.playerPool as Array<Record<string, any>>;
  const pairings = rosterPlayers.slice(0, 4).map((player) => player.memberKey);

  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sessionId: "result_session_game-1",
      sessionRevision: 7,
      sets: [{ left: 6, right: 4 }],
      setPairings: [{ setIndex: 0, teamSlots: pairings }],
    },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [sessionGame()];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as any[];
  const ratingsQueryMsg = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_prepare_ratings_query.js",
    { ...queryOut[0], payload: [] },
  ) as any[];
  const queried = ratingsQueryMsg[0] as Record<string, any>;
  queried.payload = [];

  const insertOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", queried) as any[];
  const resultDoc = insertOut[0].payload[1].$setOnInsert;

  assert.equal(resultDoc.sourceSessionId, "result_session_game-1");
  assert.equal(resultDoc.sourceSessionRevision, 7);
  assert.equal(resultDoc.resultPayload.sessionId, "result_session_game-1");
  assert.equal(resultDoc.resultPayload.sessionRevision, 7);
  assert.equal(resultDoc.resultRosterSnapshot.members.length, 5);
  resultDoc.rosterSnapshot.playerPool.forEach((player: any) => {
    assert.match(player.memberKey, /^rm_[a-z0-9]+$/i);
    assert.equal("id" in player, false);
  });
});
