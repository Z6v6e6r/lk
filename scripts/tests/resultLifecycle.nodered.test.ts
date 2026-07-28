import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

function withFixedNow<T>(nowIso: string, callback: () => T): T {
  const originalDateNow = Date.now;
  const fixedNowTs = Date.parse(nowIso);
  Date.now = () => fixedNowTs;
  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
  }
}

function finishedGame(overrides: Record<string, unknown> = {}) {
  return {
    id: "game-1",
    booking: { endTs: Date.now() - 60_000, vivaExerciseId: "viva-1" },
    participants: [
      { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
      { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3.2 },
      { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: 3.3 },
    ],
    waitlist: [{ id: "p4", phoneNorm: "79000000004", name: "B2", ratingNumeric: 3.4 }],
    ...overrides,
  };
}

function publicMemberKey(internalMemberKey: string) {
  let hash = 2166136261;
  for (let index = 0; index < internalMemberKey.length; index += 1) {
    hash ^= internalMemberKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rm_${(hash >>> 0).toString(36)}`;
}

test("state prepare does not reject invite viewers before phone is known", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
  }) as any[];

  assert.ok(out[0]);
  assert.equal(out[0]._resultState.gameId, "game-1");
  assert.equal(out[0]._resultState.phone, null);
  assert.equal(out[1], null);
});

test("result auth verifies Bearer profile and restores the original request payload", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_auth_prepare.js", {
    req: {
      params: { gameId: "game-1" },
      route: { path: "/lk/games/:gameId/result/submit" },
      headers: { authorization: "Bearer token-1" },
    },
    payload: {
      submittedBy: { id: "p1", name: "Player 1" },
      sets: [{ left: 6, right: 4 }],
    },
  }) as any[];
  assert.ok(prepareOut[0]);
  assert.equal(prepareOut[0]._resultAuth.target, "submit");
  assert.equal(prepareOut[0].url, "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile");

  const profileOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_auth_profile.js", {
    ...prepareOut[0],
    statusCode: 200,
    payload: { id: "p1", name: "Player 1" },
  }) as any[];
  assert.ok(profileOut[1]);
  assert.equal(profileOut[1]._resultActor.id, "p1");
  assert.equal(profileOut[1]._resultActor.verified, true);
  assert.deepEqual(profileOut[1].payload.sets, [{ left: 6, right: 4 }]);
});

test("result auth rejects a payload actor that differs from the verified profile", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_auth_prepare.js", {
    req: {
      route: { path: "/lk/games/:gameId/result/confirm" },
      headers: { authorization: "Bearer token-1" },
    },
    payload: { actor: { id: "p-spoofed" } },
  }) as any[];
  const profileOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_auth_profile.js", {
    ...prepareOut[0],
    statusCode: 200,
    payload: { id: "p1" },
  }) as any[];
  assert.equal(profileOut[0], null);
  assert.equal(profileOut[5].statusCode, 403);
  assert.equal(profileOut[5].payload.code, "RESULT_AUTH_ID_MISMATCH");
});

test("submit authorizes a verified clientId when phones are absent and reconciles a stale roster snapshot", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    _resultActor: { id: "p1", phoneNorm: null, name: "P1", verified: true },
    payload: {
      submittedBy: { id: "p1" },
      sets: [{ left: 6, right: 4 }],
      setPairings: [{
        setIndex: 0,
        teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }],
      }],
    },
  }) as any[];
  const prepared = prepareOut[0];
  assert.equal(prepared._resultSubmit.phone, null);
  assert.equal(prepared._resultSubmit.actor.id, "p1");
  prepared.payload = [finishedGame({
    participants: [
      { id: "p1", phoneNorm: null, name: "P1" },
      { id: "p2", phoneNorm: null, name: "P2" },
      { id: "p3", phoneNorm: null, name: "P3" },
      { id: "p4", phoneNorm: null, name: "P4" },
    ],
    waitlist: [],
    resultRosterSnapshot: {
      version: 1,
      playerPool: [{ memberKey: "phone:legacy", clientId: "p1", phoneNorm: null, name: "P1" }],
      initialTeamSlots: [{ clientId: "p1" }, { clientId: "p2" }, { clientId: "p3" }, { clientId: "p4" }],
    },
  })];

  const queryOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_build_query.js",
    prepared,
  ) as any[];
  assert.ok(queryOut[0]);
  assert.equal(queryOut[0]._resultSubmit.actorMember.id, "p1");
  assert.equal(queryOut[0]._resultSubmit.resultRosterSnapshot.members.length, 4);
  assert.deepEqual(queryOut[0]._resultSubmit.activeIds.sort(), ["p1", "p2", "p3", "p4"]);
});

test("submit stores immutable pairings and rating facts before rating calculation", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }, { left: 4, right: 6 }, { left: 7, right: 6 }],
      setPairings: [{ setIndex: 2, teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }] }],
    },
  }) as unknown[];
  const prepared = prepareOut[0] as Record<string, unknown>;
  prepared.payload = [finishedGame()];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as unknown[];
  const queried = queryOut[0] as Record<string, unknown> & { _resultSubmit: any };
  assert.equal(queried._resultSubmit.teams.source, "setPairings");
  assert.deepEqual(queried._resultSubmit.teams.teamB.map((p: any) => p.phoneNorm), ["79000000003", "79000000004"]);
  queried.payload = [];

  const insertOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", queried) as unknown[];
  const resultMsg = insertOut[0] as Record<string, any>;
  const afterWriteOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_after_write.js",
    {
      ...resultMsg,
      payload: [{ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }],
    },
  ) as unknown[];
  const acceptedMsg = afterWriteOut[0] as Record<string, any>;
  const gameMsg = afterWriteOut[1] as Record<string, any>;
  const eventMsg = afterWriteOut[2] as Record<string, any>;
  assert.equal(resultMsg.payload[1].$setOnInsert.status, "PENDING_REVIEW");
  assert.equal(resultMsg.payload[1].$setOnInsert.revision, 1);
  assert.equal(resultMsg.payload[1].$setOnInsert.ratingEvent.status, "PENDING_CONFIRMATION");
  assert.equal(resultMsg.payload[1].$setOnInsert.ratingFormula, null);
  assert.deepEqual(resultMsg.payload[1].$setOnInsert.ratingImpact, []);
  assert.equal(resultMsg.payload[1].$setOnInsert.ratingFacts.version, "game-result-rating-facts-v1");
  assert.equal(resultMsg.payload[1].$setOnInsert.ratingFacts.effectiveSetPairings.length, 3);
  assert.equal(acceptedMsg.statusCode, 202);
  assert.equal(gameMsg.payload[1].$set.resultStatus, "PENDING_REVIEW");
  assert.equal(insertOut[3], null);
  assert.equal(eventMsg.payload[1].$set.status, "PENDING_CONFIRMATION");
});

test("submit rejects aggregate-only payloads and malformed explicit 2v2 pairings", () => {
  const noSetsOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      scoreA: 6,
      scoreB: 4,
    },
  }) as any[];
  assert.equal(noSetsOut[0], null);
  assert.equal(noSetsOut[1].statusCode, 400);
  assert.match(noSetsOut[1].payload.error, /At least one valid set is required/);

  const brokenPairingOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }],
      setPairings: [{ setIndex: 0, teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }],
    },
  }) as any[];
  assert.equal(brokenPairingOut[0], null);
  assert.equal(brokenPairingOut[1].statusCode, 400);
  assert.match(brokenPairingOut[1].payload.error, /exactly four player references/);
});

test("submit prepare rejects score-only payloads without normalized sets", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      scoreA: 12,
      scoreB: 10,
    },
  }) as any[];

  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 400);
  assert.match(out[1].payload.error, /At least one valid set is required/);
});

test("submit prepare accepts flexible non-draw integer set scores", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 5 }, { left: 12, right: 3 }],
    },
  }) as any[];

  assert.ok(out[0]);
  assert.deepEqual(out[0]._resultSubmit.sets, [{ left: 6, right: 5 }, { left: 12, right: 3 }]);
  assert.equal(out[0]._resultSubmit.scoreA, 18);
  assert.equal(out[0]._resultSubmit.scoreB, 8);
});

test("submit prepare rejects draw or malformed set scores", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 6 }],
    },
  }) as any[];

  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 400);
  assert.match(out[1].payload.error, /cannot end in a draw/i);
});

test("submit resolves opaque member-key pairings and queries live ratings for every played participant", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000003",
      sets: [{ left: 4, right: 6 }, { left: 6, right: 2 }],
      setPairings: [
        { setIndex: 0, slots: [publicMemberKey("id:p1"), publicMemberKey("id:p3"), publicMemberKey("id:p4"), publicMemberKey("id:p2")] },
        { setIndex: 1, slots: [publicMemberKey("id:p5"), publicMemberKey("id:p3"), publicMemberKey("id:p4"), publicMemberKey("id:p2")] },
      ],
    },
  }) as unknown[];
  const prepared = prepareOut[0] as Record<string, unknown> & { _resultSubmit: any };

  assert.equal(prepared._resultSubmit.setPairings.length, 2);
  prepared.payload = [
    finishedGame({
      participants: [
        { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
        { id: "p2", phoneNorm: "79000000002", name: "B2", ratingNumeric: 3.2 },
        { id: "p3", phoneNorm: "79000000003", name: "A2", ratingNumeric: 3.3 },
        { id: "p4", phoneNorm: "79000000004", name: "B1", ratingNumeric: 3.4 },
      ],
      waitlist: [{ id: "p5", phoneNorm: "79000000005", name: "WL", ratingNumeric: 3.5 }],
      resultRosterSnapshot: {
        members: [
          { memberKey: "id:p1", id: "p1", phoneNorm: "79000000001", name: "A1" },
          { memberKey: "id:p2", id: "p2", phoneNorm: "79000000002", name: "B2" },
          { memberKey: "id:p3", id: "p3", phoneNorm: "79000000003", name: "A2" },
          { memberKey: "id:p4", id: "p4", phoneNorm: "79000000004", name: "B1" },
          { memberKey: "id:p5", id: "p5", phoneNorm: "79000000005", name: "WL" },
        ],
        initialTeamMemberKeys: ["id:p1", "id:p2", "id:p3", "id:p4"],
        participantMemberKeys: ["id:p1", "id:p2", "id:p3", "id:p4"],
        waitlistMemberKeys: ["id:p5"],
        allowedMemberKeys: ["id:p1", "id:p2", "id:p3", "id:p4", "id:p5"],
      },
    }),
  ];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as unknown[];
  const queried = queryOut[0] as Record<string, unknown> & { _resultSubmit: any };
  assert.equal(queried._resultSubmit.submitterTeam, "A");
  assert.equal(queried._resultSubmit.teams.source, "setPairings");
  assert.deepEqual(queried._resultSubmit.teams.teamA.map((player: any) => player.phoneNorm), [
    "79000000005",
    "79000000003",
  ]);
  assert.deepEqual(queried._resultSubmit.teams.teamB.map((player: any) => player.phoneNorm), [
    "79000000004",
    "79000000002",
  ]);

  const ratingsQueryOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_prepare_ratings_query.js",
    { ...queried, payload: [] },
  ) as unknown[];
  const ratingQueryMsg = ratingsQueryOut[0] as Record<string, any>;
  const phoneClause = ratingQueryMsg.payload.$or.find((clause: any) => clause.phoneNorm);
  assert.deepEqual(
    [...phoneClause.phoneNorm.$in].sort(),
    ["79000000001", "79000000002", "79000000003", "79000000004", "79000000005"],
  );
  const clientIdClause = ratingQueryMsg.payload.$or.find((clause: any) => clause.clientId);
  assert.deepEqual([...clientIdClause.clientId.$in].sort(), ["p1", "p2", "p3", "p4", "p5"]);
});

test("submit accepts ID-backed played lineups when a player has no phoneNorm", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }],
      setPairings: [{ setIndex: 0, teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }] }],
    },
  }) as unknown[];
  const prepared = prepareOut[0] as Record<string, unknown>;
  prepared.payload = [
    finishedGame({
      participants: [
        { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
        { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3.2 },
        { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: 3.3 },
      ],
      waitlist: [{ id: "p4", phoneNorm: null, name: "B2", ratingNumeric: 3.4 }],
    }),
  ];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as any[];
  assert.ok(queryOut[0]);
  assert.equal(queryOut[0]._resultSubmit.activeMembers.length, 4);
  assert.equal(queryOut[0]._resultSubmit.activeMembers.find((member: any) => member.id === "p4").phoneNorm, null);
});

test("submit does not depend on roster ratings and confirm requires complete live rating state", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }],
      setPairings: [{ setIndex: 0, teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }] }],
    },
  }) as unknown[];
  const prepared = prepareOut[0] as Record<string, unknown>;
  prepared.payload = [
    finishedGame({
      participants: [
        { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
        { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3.2 },
        { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: null, rating: null },
      ],
      waitlist: [{ id: "p4", phoneNorm: "79000000004", name: "B2", ratingNumeric: 3.4 }],
    }),
  ];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as any[];
  const queried = queryOut[0] as Record<string, unknown>;
  queried.payload = [];

  const insertOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", queried) as any[];
  const resultDoc = insertOut[0].payload[1].$setOnInsert;
  assert.equal(resultDoc.status, "PENDING_REVIEW");
  assert.deepEqual(resultDoc.ratingImpact, []);

  const confirmPrepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js", {
    _resultConfirm: { action: "CONFIRM", phone: "79000000002", game: finishedGame() },
    payload: [resultDoc],
  }) as any[];
  const confirmMsg = confirmPrepareOut[0];
  confirmMsg.payload = [
    { phoneNorm: "79000000001", ratingNumeric: 3.1 },
    { phoneNorm: "79000000002", ratingNumeric: 3.2 },
    { phoneNorm: "79000000004", ratingNumeric: 3.4 },
  ];
  const calculateOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_confirm_calculate_rating.js",
    confirmMsg,
  ) as any[];
  assert.equal(calculateOut[0], null);
  assert.equal(calculateOut[1].statusCode, 409);
  assert.equal(calculateOut[1].payload.code, "RATING_STATE_INCOMPLETE");
});

test("submit allows non-rating games without rating impact and confirm path skips rating query", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 7, right: 5 }],
      setPairings: [{ setIndex: 0, teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }] }],
    },
  }) as unknown[];
  const prepared = prepareOut[0] as Record<string, unknown>;
  prepared.payload = [
    finishedGame({
      settings: { ratingGame: false },
      participants: [
        { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: null, rating: null },
        { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: null, rating: null },
        { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: null, rating: null },
      ],
      waitlist: [{ id: "p4", phoneNorm: "79000000004", name: "B2", ratingNumeric: null, rating: null }],
    }),
  ];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as any[];
  const queried = queryOut[0] as Record<string, unknown>;
  queried.payload = [];

  const insertOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", queried) as any[];
  const resultMsg = insertOut[0] as any;
  assert.equal(resultMsg.payload[1].$setOnInsert.ratingEnabled, false);
  assert.deepEqual(resultMsg.payload[1].$setOnInsert.ratingImpact, []);

  const confirmPrepOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js", {
    _resultConfirm: {
      action: "CONFIRM",
      phone: "79000000002",
      game: { settings: { ratingGame: false } },
    },
    payload: [resultMsg.payload[1].$setOnInsert],
  }) as any[];
  assert.deepEqual(confirmPrepOut[0].payload, { phoneNorm: { $in: [] } });
});

test("confirm calculates rating from live state for per-set partner changes", () => {
  const pending = {
    id: "res-pair-change",
    gameId: "game-1",
    status: "PENDING_REVIEW",
    lifecycleState: "PENDING_REVIEW",
    revision: 1,
    ratingEnabled: true,
    submittedBy: { memberKey: "id:p1", phoneNorm: "79000000001" },
    ratingEvent: { id: "rate-pair-change", status: "PENDING_CONFIRMATION", ratingEnabled: true },
    ratingFacts: {
      version: "game-result-rating-facts-v1",
      algorithm: "game-rating-v1",
      sets: [{ left: 6, right: 4 }, { left: 3, right: 6 }],
      effectiveSetPairings: [
        {
          setIndex: 0,
          teamA: [
            { memberKey: "id:p1", id: "p1", phoneNorm: "79000000001", name: "P1" },
            { memberKey: "id:p2", id: "p2", phoneNorm: "79000000002", name: "P2" },
          ],
          teamB: [
            { memberKey: "id:p3", id: "p3", phoneNorm: "79000000003", name: "P3" },
            { memberKey: "id:p4", id: "p4", phoneNorm: "79000000004", name: "P4" },
          ],
        },
        {
          setIndex: 1,
          teamA: [
            { memberKey: "id:p1", id: "p1", phoneNorm: "79000000001", name: "P1" },
            { memberKey: "id:p3", id: "p3", phoneNorm: "79000000003", name: "P3" },
          ],
          teamB: [
            { memberKey: "id:p2", id: "p2", phoneNorm: "79000000002", name: "P2" },
            { memberKey: "id:p4", id: "p4", phoneNorm: "79000000004", name: "P4" },
          ],
        },
      ],
      params: { K: 0.3, D: 3, B: 0.3, minRating: 1, maxRating: 7, round: 5 },
    },
    sets: [{ left: 6, right: 4 }, { left: 3, right: 6 }],
    ratingImpact: [],
  };
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js", {
    _resultConfirm: {
      action: "CONFIRM",
      phone: "79000000004",
      actorMember: { memberKey: "id:p4", phoneNorm: "79000000004", name: "P4" },
      game: finishedGame(),
    },
    payload: [pending],
  }) as any[];
  const phoneClause = prepareOut[0].payload.$or.find((clause: any) => clause.phoneNorm);
  assert.deepEqual(
    [...phoneClause.phoneNorm.$in].sort(),
    ["79000000001", "79000000002", "79000000003", "79000000004"],
  );
  const clientIdClause = prepareOut[0].payload.$or.find((clause: any) => clause.clientId);
  assert.deepEqual([...clientIdClause.clientId.$in].sort(), ["p1", "p2", "p3", "p4"]);

  const calculateMsg = prepareOut[0];
  calculateMsg.payload = [
    { phoneNorm: "79000000001", ratingNumeric: 2.9 },
    { phoneNorm: "79000000002", ratingNumeric: 3.1 },
    { phoneNorm: "79000000003", ratingNumeric: 3.7 },
    { phoneNorm: "79000000004", ratingNumeric: 4.0 },
  ];
  const calculateOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_confirm_calculate_rating.js",
    calculateMsg,
  ) as any[];
  const calculated = calculateOut[0];
  assert.equal(calculated._resultLiveRatingCalculated, true);
  assert.equal(calculated._resultPending.intermediateResults.length, 2);
  assert.equal(
    calculated._resultPending.intermediateResults[1].impact.find((item: any) => item.phoneNorm === "79000000002").team,
    "B",
  );
  assert.equal(
    calculated._resultPending.ratingImpact.find((item: any) => item.phoneNorm === "79000000002").team,
    null,
  );
  assert.equal(
    calculated._resultPending.ratingImpact.find((item: any) => item.phoneNorm === "79000000001").before,
    2.9,
  );

  const applyOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_confirm_apply.js",
    calculated,
  ) as any[];
  assert.equal(applyOut[0].payload[1].$set.status, "CONFIRMED");
  assert.equal(applyOut[0].payload[1].$set.ratingImpact.length, 4);
  assert.equal(applyOut[0].payload[1].$set.ratingFormula.ratingSource, "player_rating_state_at_confirm");
  assert.equal(applyOut[1].payload.length, 4);
});

test("submit prefers initial lineup from submitted result session snapshot over mutable game team slots", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }, { left: 4, right: 6 }],
      setPairings: [
        {
          setIndex: 1,
          slots: [
            publicMemberKey("id:p1"),
            publicMemberKey("id:p3"),
            publicMemberKey("id:p2"),
            publicMemberKey("id:p4"),
          ],
        },
      ],
      resultSession: {
        rosterSnapshot: {
          initialTeamMemberKeys: [
            publicMemberKey("id:p1"),
            publicMemberKey("id:p2"),
            publicMemberKey("id:p3"),
            publicMemberKey("id:p4"),
          ],
        },
      },
    },
  }) as unknown[];
  const prepared = prepareOut[0] as Record<string, unknown>;
  prepared.payload = [
    finishedGame({
      participants: [
        { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
        { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3.2 },
        { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: 3.3 },
        { id: "p4", phoneNorm: "79000000004", name: "B2", ratingNumeric: 3.4 },
      ],
      waitlist: [],
      metadata: {
        teamSlots: [{ id: "p1" }, { id: "p3" }, { id: "p2" }, { id: "p4" }],
      },
    }),
  ];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as unknown[];
  const queried = queryOut[0] as Record<string, unknown> & { _resultSubmit: any };
  assert.deepEqual(queried._resultSubmit.resolvedSetPairings[0].teamA.map((player: any) => player.phoneNorm), [
    "79000000001",
    "79000000002",
  ]);
  assert.deepEqual(queried._resultSubmit.resolvedSetPairings[0].teamB.map((player: any) => player.phoneNorm), [
    "79000000003",
    "79000000004",
  ]);
  assert.deepEqual(queried._resultSubmit.resolvedSetPairings[1].teamA.map((player: any) => player.phoneNorm), [
    "79000000001",
    "79000000003",
  ]);
  assert.deepEqual(queried._resultSubmit.resolvedSetPairings[1].teamB.map((player: any) => player.phoneNorm), [
    "79000000002",
    "79000000004",
  ]);
});

test("submit keeps ID-backed members without phoneNorm in resolved lineups", () => {
  const prepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }],
      setPairings: [{ setIndex: 0, teamSlots: [{ id: "p1" }, { id: "p2" }, { id: "p3" }, { id: "p4" }] }],
    },
  }) as any[];
  const prepared = prepareOut[0] as Record<string, any>;
  prepared.payload = [
    finishedGame({
      participants: [
        { id: "p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3.1 },
        { id: "p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3.2 },
        { id: "p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: 3.3 },
      ],
      waitlist: [{ id: "p4", phoneNorm: null, name: "B2", ratingNumeric: 3.4 }],
    }),
  ];

  const queryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", prepared) as any[];
  assert.ok(queryOut[0]);
  assert.equal(queryOut[0]._resultSubmit.resolvedSetPairings[0].teamB[1].id, "p4");
  assert.equal(queryOut[0]._resultSubmit.resolvedSetPairings[0].teamB[1].phoneNorm, null);
});

test("state response treats hanging legacy inline results as no-result until immutable rows exist", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", {
    payload: [],
    _resultState: {
      gameId: "game-1",
      phone: "79000000001",
      isFinished: true,
      endTs: Date.now() - 60_000,
      game: {
        booking: {
          date: "2026-06-11",
          timeTo: "18:30",
        },
        metadata: {
          matchResult: {
            status: "PENDING_REVIEW",
            sets: [{ left: 6, right: 4 }],
            setPairings: [{ slots: ["p1", "p2", "p3", "p4"] }],
          },
        },
      },
      teams: {
        teamA: [{ phoneNorm: "79000000001" }],
        teamB: [{ phoneNorm: "79000000002" }],
      },
    },
  }) as any[];

  assert.equal(out[0].payload.state, "NO_RESULT");
  assert.equal(out[0].payload.latestResult, null);
  assert.equal(out[0].payload.canSubmit, true);
});

test("state response does not leak private helper arrays in public payload", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", {
    payload: [
      {
        id: "res-1",
        gameId: "game-1",
        status: "PENDING_REVIEW",
        submittedAtTs: Date.now(),
        disputeDeadlineTs: Date.now() + 60_000,
        submittedByTeam: "A",
        submittedBy: { phoneNorm: "79000000001" },
        teams: {
          teamA: [{ phoneNorm: "79000000001" }],
          teamB: [{ phoneNorm: "79000000002" }],
        },
      },
    ],
    _resultState: {
      gameId: "game-1",
      phone: "79000000002",
      isFinished: true,
      endTs: Date.now() - 60_000,
      game: {
        allRelatedPhones: ["79000000001", "79000000002", "79000000003"],
        participantPhones: ["79000000001", "79000000002"],
        waitlistPhones: ["79000000003"],
      },
      teams: {
        teamA: [{ phoneNorm: "79000000001" }],
        teamB: [{ phoneNorm: "79000000002" }],
      },
    },
  }) as any[];

  const json = JSON.stringify(out[0].payload);
  assert.doesNotMatch(json, /allRelatedPhones|participantPhones|waitlistPhones|allowedPhoneNorms/);
});

test("submit extends dispute deadline to June 10 for games from May 31 to June 10", () => {
  withFixedNow("2026-06-02T07:00:00.000Z", () => {
    const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", {
      _resultExistingRows: [],
      _resultSubmit: {
        gameId: "game-1",
        phone: "79000000001",
        scoreA: 6,
        scoreB: 4,
        sets: [{ left: 6, right: 4 }],
        setPairings: [],
        submitterTeam: "A",
        game: finishedGame({
          booking: {
            endTs: Date.parse("2026-06-01T16:00:00+03:00"),
            date: "2026-06-01",
            timeTo: "16:00",
            vivaExerciseId: "viva-1",
          },
        }),
        teams: {
          teamA: [
            { memberKey: "id:p1", phoneNorm: "79000000001", name: "A1", ratingNumeric: 3 },
            { memberKey: "id:p2", phoneNorm: "79000000002", name: "A2", ratingNumeric: 3 },
          ],
          teamB: [
            { memberKey: "id:p3", phoneNorm: "79000000003", name: "B1", ratingNumeric: 3 },
            { memberKey: "id:p4", phoneNorm: "79000000004", name: "B2", ratingNumeric: 3 },
          ],
        },
      },
      payload: [],
    }) as any[];

    const resultMsg = out[0] as any;
    assert.equal(resultMsg.payload[1].$setOnInsert.disputeDeadlineAt, "2026-06-10T20:59:59.999Z");
    assert.equal(resultMsg.payload[1].$setOnInsert.disputeDeadlineTs, Date.parse("2026-06-10T20:59:59.999Z"));
  });
});

test("repeat submit with same payload is idempotent and emits no second rating update", () => {
  const latest = {
    id: "res-1",
    gameId: "game-1",
    status: "PENDING_REVIEW",
    resultSignature: JSON.stringify({ scoreA: 7, scoreB: 6, sets: [{ left: 7, right: 6 }], setPairings: [] }),
    submittedAtTs: Date.now(),
  };
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", {
    _resultSubmit: { gameId: "game-1", scoreA: 7, scoreB: 6, sets: [{ left: 7, right: 6 }], setPairings: [] },
    payload: [latest],
  }) as unknown[];
  assert.equal(out[0], null);
  assert.equal((out[1] as any).statusCode, 200);
  assert.equal((out[1] as any).payload.idempotent, true);
  assert.equal(out[3], null);
});

test("state response keeps launch-period results disputable until June 10 end", () => {
  withFixedNow("2026-06-09T09:00:00.000Z", () => {
    const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", {
      payload: [
        {
          id: "res-1",
          gameId: "game-1",
          status: "PENDING_REVIEW",
          submittedAtTs: Date.parse("2026-06-01T10:00:00+03:00"),
          disputeDeadlineTs: Date.parse("2026-06-02T10:00:00+03:00"),
          submittedByTeam: "A",
          submittedBy: { phoneNorm: "79000000001" },
          teams: {
            teamA: [{ phoneNorm: "79000000001" }],
            teamB: [{ phoneNorm: "79000000002" }],
          },
        },
      ],
      _resultState: {
        gameId: "game-1",
        phone: "79000000002",
        isFinished: true,
        endTs: Date.parse("2026-06-01T16:00:00+03:00"),
        game: {
          booking: {
            date: "2026-06-01",
            timeTo: "16:00",
          },
        },
        teams: {
          teamA: [{ phoneNorm: "79000000001" }],
          teamB: [{ phoneNorm: "79000000002" }],
        },
      },
    }) as any[];

    assert.equal(out[0].payload.disputeDeadlineAt, "2026-06-10T20:59:59.999Z");
    assert.equal(out[0].payload.canDispute, true);
    assert.equal(out[0].payload.latestResult.viewer.canDispute, true);
  });
});

test("state response is viewer-aware for author, other participant, and spectator", () => {
  const latest = {
    id: "res-1",
    gameId: "game-1",
    status: "PENDING_REVIEW",
    submittedBy: { phoneNorm: "79000000001" },
    submittedByTeam: "A",
    submittedAtTs: Date.now(),
    disputeDeadlineTs: Date.now() + 60_000,
  };
  const base = {
    payload: [latest],
    _resultState: {
      gameId: "game-1",
      isFinished: true,
      teams: {
        teamA: [{ phoneNorm: "79000000001" }],
        teamB: [{ phoneNorm: "79000000002" }],
      },
    },
  };
  const author = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", { ...base, _resultState: { ...(base as any)._resultState, phone: "79000000001" } }) as any[];
  const other = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", { ...base, _resultState: { ...(base as any)._resultState, phone: "79000000002" } }) as any[];
  const spectator = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", { ...base, _resultState: { ...(base as any)._resultState, phone: "79999999999" } }) as any[];
  assert.equal(author[0].payload.viewerState.role, "AUTHOR");
  assert.equal(author[0].payload.canDispute, false);
  assert.equal(other[0].payload.viewerState.role, "PARTICIPANT");
  assert.equal(other[0].payload.canDispute, true);
  assert.equal(spectator[0].payload.viewerState.role, "SPECTATOR");
  assert.equal(spectator[0].payload.canConfirm, false);
});

test("dispute prepare keeps launch-period results open until June 10 end", () => {
  withFixedNow("2026-06-09T09:00:00.000Z", () => {
    const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js", {
      _resultConfirm: {
        action: "DISPUTE",
        phone: "79000000002",
        game: {
          booking: {
            date: "2026-06-01",
            timeTo: "16:00",
          },
        },
      },
      payload: [
        {
          id: "res-1",
          gameId: "game-1",
          status: "PENDING_REVIEW",
          submittedByTeam: "A",
          submittedBy: { phoneNorm: "79000000001" },
          ratingImpact: [
            { phoneNorm: "79000000001", team: "A", before: 3, after: 3.1, delta: 0.1 },
            { phoneNorm: "79000000002", team: "B", before: 3, after: 2.9, delta: -0.1 },
          ],
          submittedAtTs: Date.parse("2026-06-01T10:00:00+03:00"),
          disputeDeadlineTs: Date.parse("2026-06-02T10:00:00+03:00"),
          teams: {
            teamA: [{ phoneNorm: "79000000001" }],
            teamB: [{ phoneNorm: "79000000002" }],
          },
        },
      ],
    }) as any[];

    assert.ok(out[0]);
    assert.equal(out[0]._resultPending.disputeDeadlineTs, Date.parse("2026-06-10T20:59:59.999Z"));
    assert.deepEqual(out[0].payload, { phoneNorm: { $in: [] } });
    assert.equal(out[0]._resultRatingCalculationRequired, false);
  });
});

test("dispute on pending review opens correction context without rating rollback for new flow", () => {
  const pending = {
    id: "res-1",
    gameId: "game-1",
    status: "PENDING_REVIEW",
    submittedByTeam: "A",
    submittedBy: { phoneNorm: "79000000001" },
    ratingEvent: { id: "rate-1", status: "PENDING_CONFIRMATION" },
    ratingImpact: [
      { phoneNorm: "79000000001", name: "A1", team: "A", before: 3, after: 3.1, delta: 0.1, gradeBefore: "C", gradeAfter: "C" },
      { phoneNorm: "79000000002", name: "B1", team: "B", before: 3, after: 2.9, delta: -0.1, gradeBefore: "C", gradeAfter: "D+" },
    ],
    teams: { teamA: [{ phoneNorm: "79000000001" }], teamB: [{ phoneNorm: "79000000002" }] },
  };
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_apply.js", {
    _resultConfirm: { game: finishedGame(), phone: "79000000002", action: "DISPUTE", viewerTeam: "B", reason: "score" },
    _resultPending: pending,
    payload: [],
  }) as any[];
  assert.equal(out[0].payload[1].$set.status, "CORRECTION_PENDING");
  assert.equal(out[0].payload[1].$set.disputeState, "DISPUTED");
  assert.equal(out[0].payload[1].$set["ratingEvent.status"], "DISPUTED");
  assert.equal(Array.isArray(out[0].payload[0].$or), true);
  assert.equal(out[0].payload[1].$set.revision, 2);
  assert.equal(out[0]._resultConfirmBundle.syncBatch, null);
  assert.equal(out[1].payload.length, 0);
  assert.equal(out[4].payload.ratingEventStatus, "DISPUTED");
  assert.equal(out[4].payload.rollbackApplied, false);
});

test("dispute rolls provisional impact back for legacy provisional-applied results", () => {
  const pending = {
    id: "res-1",
    gameId: "game-1",
    status: "PENDING_REVIEW",
    submittedByTeam: "A",
    submittedBy: { phoneNorm: "79000000001" },
    ratingEvent: { id: "rate-1", status: "PROVISIONAL_APPLIED" },
    ratingImpact: [
      { phoneNorm: "79000000001", name: "A1", team: "A", before: 3, after: 3.1, delta: 0.1, gradeBefore: "C", gradeAfter: "C" },
      { phoneNorm: "79000000002", name: "B1", team: "B", before: 3, after: 2.9, delta: -0.1, gradeBefore: "C", gradeAfter: "D+" },
    ],
    teams: { teamA: [{ phoneNorm: "79000000001" }], teamB: [{ phoneNorm: "79000000002" }] },
  };
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_apply.js", {
    _resultConfirm: { game: finishedGame(), phone: "79000000002", action: "DISPUTE", viewerTeam: "B", reason: "score" },
    _resultPending: pending,
    payload: [],
  }) as any[];
  assert.equal(out[0].payload[1].$set.status, "CORRECTION_PENDING");
  assert.equal(out[0].payload[1].$set.disputeState, "DISPUTED");
  assert.equal(out[0].payload[1].$set["ratingEvent.status"], "REVERTED");
  assert.equal(Array.isArray(out[0].payload[0].$or), true);
  assert.equal(out[0].payload[1].$set.revision, 2);
  assert.equal(out[0]._resultConfirmBundle.syncBatch.tasks.length, 2);
  assert.equal(out[1].payload[0].update.$set.ratingNumeric, 3);
  assert.equal(out[4].payload.ratingEventStatus, "REVERTED");
});

test("confirm prepare maps accept-correction and expire routes to dedicated actions", () => {
  const accept = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare.js", {
    req: {
      params: { gameId: "game-1" },
      route: { path: "/lk/games/:gameId/result/accept-correction" },
    },
    payload: { phone: "79000000001" },
  }) as any[];
  const expire = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare.js", {
    req: {
      params: { gameId: "game-1" },
      route: { path: "/lk/games/:gameId/result/expire" },
    },
    payload: { phone: "79000000001" },
  }) as any[];

  assert.equal(accept[0]._resultConfirm.action, "ACCEPT_CORRECTION");
  assert.equal(expire[0]._resultConfirm.action, "EXPIRE");
});

test("accept-correction is allowed only for result author", () => {
  const latest = {
    id: "res-1",
    gameId: "game-1",
    status: "CORRECTION_PENDING",
    submittedByTeam: "A",
    submittedBy: { phoneNorm: "79000000001" },
    ratingImpact: [
      { phoneNorm: "79000000001", team: "A", before: 3, after: 3.1, delta: 0.1 },
      { phoneNorm: "79000000002", team: "B", before: 3, after: 2.9, delta: -0.1 },
    ],
    teams: {
      teamA: [
        { memberKey: "id:p1", id: "p1", phoneNorm: "79000000001" },
        { memberKey: "id:p3", id: "p3", phoneNorm: "79000000003" },
      ],
      teamB: [
        { memberKey: "id:p2", id: "p2", phoneNorm: "79000000002" },
        { memberKey: "id:p4", id: "p4", phoneNorm: "79000000004" },
      ],
    },
  };

  const allowed = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js", {
    _resultConfirm: { action: "ACCEPT_CORRECTION", phone: "79000000001" },
    payload: [latest],
  }) as any[];
  const blocked = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js", {
    _resultConfirm: { action: "ACCEPT_CORRECTION", phone: "79000000002" },
    payload: [latest],
  }) as any[];

  assert.ok(allowed[0]);
  assert.equal(allowed[0]._resultPending.id, "res-1");
  assert.equal(blocked[0], null);
  assert.equal(blocked[1].statusCode, 409);
  assert.match(blocked[1].payload.error, /author/i);
});

test("accept-correction reapplies ratings and finalizes result", () => {
  const pending = {
    id: "res-2",
    gameId: "game-1",
    status: "CORRECTION_PENDING",
    submittedByTeam: "A",
    submittedBy: { phoneNorm: "79000000001" },
    ratingEvent: { id: "rate-2", status: "REVERTED" },
    ratingFormula: { version: "game-rating-v1", K: 0.3, D: 3, B: 0.3, minRating: 1, maxRating: 7, round: 5 },
    ratingImpact: [
      { phoneNorm: "79000000001", name: "A1", team: "A", before: 3, after: 3.2, delta: 0.2, gradeBefore: "C", gradeAfter: "C+" },
      { phoneNorm: "79000000002", name: "B1", team: "B", before: 3, after: 2.8, delta: -0.2, gradeBefore: "C", gradeAfter: "D+" },
    ],
    teams: { teamA: [{ phoneNorm: "79000000001" }], teamB: [{ phoneNorm: "79000000002" }] },
  };

  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_apply.js", {
    _resultConfirm: { game: finishedGame(), phone: "79000000001", action: "ACCEPT_CORRECTION", viewerTeam: "A" },
    _resultPending: pending,
    payload: [],
  }) as any[];

  assert.equal(out[0].payload[1].$set.status, "CONFIRMED");
  assert.equal(Array.isArray(out[0].payload[0].$or), true);
  assert.equal(out[0].payload[1].$set.revision, 2);
  assert.equal(out[0]._resultConfirmBundle.syncBatch.tasks.length, 2);
  assert.equal(out[1].payload[0].update.$set.ratingNumeric, 3.2);
  const ledgerMutation = out[1].payload[0];
  const ledgerEvent = ledgerMutation.eventOperation.update.$setOnInsert;
  assert.equal(ledgerEvent.eventType, "GAME_RESULT_CORRECTION_APPLIED");
  assert.equal(ledgerEvent.source.domain, "GAME_RESULT");
  assert.equal(ledgerEvent.source.resultId, "res-2");
  assert.equal(ledgerEvent.source.resultRevision, 2);
  assert.equal(ledgerEvent.actor.type, "PLAYER");
  assert.equal(ledgerEvent.actor.phoneNorm, "79000000001");
  assert.equal(ledgerEvent.change.before, 3);
  assert.equal(ledgerEvent.change.delta, 0.2);
  assert.equal(ledgerEvent.change.after, 3.2);
  assert.equal(ledgerEvent.formula.version, "game-rating-v1");
  assert.equal(ledgerEvent.formula.K, 0.3);
  assert.equal(ledgerEvent.projectionIntent.viva, "REQUIRED_DURING_MIGRATION");
  assert.equal(ledgerMutation.stateOperation.update.$set.ownership, "CUP_CANONICAL");
  assert.equal(ledgerMutation.stateOperation.update.$set.lastEventId, ledgerEvent.id);
  assert.equal(out[2].payload[1].$set.resultStatus, "CONFIRMED");
  assert.equal(out[4].payload.ratingApplied, true);
});

test("canonical rating writer appends immutable event before preparing current state", () => {
  const mutation = {
    eventId: "rating_evt:game_result:res-2:2:apply:client_p1",
    eventOperation: {
      query: { _id: "rating_evt:game_result:res-2:2:apply:client_p1" },
      update: { $setOnInsert: { id: "rating_evt:game_result:res-2:2:apply:client_p1" } },
    },
    stateOperation: {
      query: { phoneNorm: "79000000001" },
      update: {
        $set: { ratingNumeric: 3.2, lastEventId: "rating_evt:game_result:res-2:2:apply:client_p1" },
        $setOnInsert: { createdAt: "2026-07-10T00:00:00.000Z" },
      },
    },
    projectionTask: { outboxId: "viva-task-1", player: { id: "p1" } },
  };
  const eventMsg = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_rating_ledger_event_msg.js", {
    payload: mutation,
    _resultVivaSyncBatch: { batchId: "sync-1", tasks: [mutation.projectionTask] },
  }) as any;

  assert.deepEqual(eventMsg.payload, [
    mutation.eventOperation.query,
    mutation.eventOperation.update,
    { upsert: true },
  ]);
  assert.deepEqual(eventMsg._ratingLedgerStateOperation, mutation.stateOperation);

  eventMsg.payload = { acknowledged: true, upsertedCount: 1 };
  const stateMsg = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_rating_ledger_state_msg.js", eventMsg) as any;
  assert.deepEqual(stateMsg.payload, [
    mutation.stateOperation.query,
    mutation.stateOperation.update,
    { upsert: true },
  ]);
  assert.equal(stateMsg._ratingLedgerStateOperation, undefined);

  stateMsg.payload = { acknowledged: true, matchedCount: 1 };
  const projectionMsg = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_rating_ledger_projection_msg.js", stateMsg) as any;
  assert.equal(projectionMsg.payload.outboxId, "viva-task-1");
  assert.equal(projectionMsg._ratingLedgerProjectionTask, undefined);
});

test("expire overdue correction marks NO_RESULT_EXPIRED without rollback for new flow", () => {
  const pending = {
    id: "res-3",
    gameId: "game-1",
    status: "CORRECTION_PENDING",
    submittedByTeam: "A",
    submittedBy: { phoneNorm: "79000000001" },
    ratingEvent: { id: "rate-3", status: "DISPUTED" },
    ratingImpact: [
      { phoneNorm: "79000000001", name: "A1", team: "A", before: 3, after: 3.2, delta: 0.2, gradeBefore: "C", gradeAfter: "C+" },
      { phoneNorm: "79000000002", name: "B1", team: "B", before: 3, after: 2.8, delta: -0.2, gradeBefore: "C", gradeAfter: "D+" },
    ],
    teams: { teamA: [{ phoneNorm: "79000000001" }], teamB: [{ phoneNorm: "79000000002" }] },
    expiredToNoResult: true,
  };

  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_apply.js", {
    _resultConfirm: { game: finishedGame(), action: "EXPIRE_CRON" },
    _resultPending: pending,
    payload: [],
  }) as any[];

  assert.equal(out[0].payload[1].$set.status, "NO_RESULT_EXPIRED");
  assert.equal(out[0]._resultConfirmBundle.ratingsPayload.length, 0);
  assert.equal(out[0]._resultConfirmBundle.gamePayload[1].$set.resultStatus, "NO_RESULT_EXPIRED");
  assert.equal(out[3], null);
  assert.equal(out[4].payload.rollbackApplied, false);
});

test("expire overdue correction rolls ratings back for legacy provisional-applied flow", () => {
  const pending = {
    id: "res-3",
    gameId: "game-1",
    status: "CORRECTION_PENDING",
    submittedByTeam: "A",
    submittedBy: { phoneNorm: "79000000001" },
    ratingEvent: { id: "rate-3", status: "PROVISIONAL_APPLIED" },
    ratingImpact: [
      { phoneNorm: "79000000001", name: "A1", team: "A", before: 3, after: 3.2, delta: 0.2, gradeBefore: "C", gradeAfter: "C+" },
      { phoneNorm: "79000000002", name: "B1", team: "B", before: 3, after: 2.8, delta: -0.2, gradeBefore: "C", gradeAfter: "D+" },
    ],
    teams: { teamA: [{ phoneNorm: "79000000001" }], teamB: [{ phoneNorm: "79000000002" }] },
    expiredToNoResult: true,
  };

  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_apply.js", {
    _resultConfirm: { game: finishedGame(), action: "EXPIRE_CRON" },
    _resultPending: pending,
    payload: [],
  }) as any[];

  assert.equal(out[0].payload[1].$set.status, "NO_RESULT_EXPIRED");
  assert.equal(out[0]._resultConfirmBundle.ratingsPayload[0].update.$set.ratingNumeric, 3);
  assert.equal(out[0]._resultConfirmBundle.gamePayload[1].$set.resultStatus, "NO_RESULT_EXPIRED");
  assert.equal(out[0]._resultConfirmBundle.syncBatch.tasks.length, 2);
  assert.equal(out[3], null);
  assert.equal(out[4].payload.rollbackApplied, true);
});

test("full lifecycle: submit -> dispute -> accept-correction applies rating only on final confirm", () => {
  const submitPrepareOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_prepare.js", {
    req: { params: { gameId: "game-1" }, query: {} },
    payload: {
      phone: "79000000001",
      sets: [{ left: 6, right: 4 }],
      setPairings: [],
    },
  }) as any[];
  const submitPrepared = submitPrepareOut[0];
  submitPrepared.payload = [finishedGame()];

  const submitQueryOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_query.js", submitPrepared) as any[];
  const submitQueryMsg = submitQueryOut[0];
  submitQueryMsg.payload = [];

  const submitInsertOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_submit_build_insert.js", submitQueryMsg) as any[];
  const createdResult = submitInsertOut[0].payload[1].$setOnInsert;

  const disputeOut = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_apply.js", {
    _resultConfirm: { game: finishedGame(), phone: "79000000003", action: "DISPUTE", viewerTeam: "B", reason: "score mismatch" },
    _resultPending: createdResult,
    payload: [],
  }) as any[];
  const correctionSet = disputeOut[0].payload[1].$set;
  const correctionPending = {
    ...createdResult,
    ...correctionSet,
    status: "CORRECTION_PENDING",
    lifecycleState: "CORRECTION_PENDING",
    ratingEvent: {
      ...(createdResult.ratingEvent || {}),
      status: "DISPUTED",
    },
  };

  const acceptPrepareOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js",
    {
      _resultConfirm: { game: finishedGame(), phone: "79000000001", action: "ACCEPT_CORRECTION", viewerTeam: "A" },
      payload: [correctionPending],
    },
  ) as any[];
  const acceptRatingMsg = acceptPrepareOut[0];
  acceptRatingMsg.payload = [
    { phoneNorm: "79000000001", ratingNumeric: 3.1 },
    { phoneNorm: "79000000002", ratingNumeric: 3.2 },
    { phoneNorm: "79000000003", ratingNumeric: 3.3 },
    { phoneNorm: "79000000004", ratingNumeric: 3.4 },
  ];
  const acceptCalculateOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_confirm_calculate_rating.js",
    acceptRatingMsg,
  ) as any[];
  const acceptOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_confirm_apply.js",
    acceptCalculateOut[0],
  ) as any[];

  assert.equal(acceptOut[0].payload[1].$set.status, "CONFIRMED");
  assert.equal(acceptOut[1].payload.length > 0, true);
  assert.equal(acceptOut[4].payload.ratingApplied, true);
});

test("CAS router blocks downstream side effects on concurrent confirm conflict", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_route_after_cas.js", {
    payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
    _resultConfirmBundle: {
      response: { statusCode: 200, payload: { status: "CONFIRMED" } },
      syncBatch: { resultId: "res-1", gameId: "game-1" },
    },
  }) as any[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2].statusCode, 409);
  assert.equal(out[2].payload.code, "RESULT_CAS_CONFLICT");
  assert.equal(out[5], null);
});

test("CAS router attaches Viva projection to canonical mutations instead of running it in parallel", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_confirm_route_after_cas.js", {
    payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 },
    _resultConfirmBundle: {
      ratingsPayload: [{ query: { phoneNorm: "79000000001" }, update: { $set: { ratingNumeric: 3.1 } } }],
      gamePayload: [{ id: "game-1" }, { $set: { resultStatus: "CONFIRMED" } }, { upsert: false }],
      eventPayload: [{ _id: "rate-1" }, { $set: { status: "FINAL" } }, { upsert: true }],
      response: { statusCode: 200, payload: { status: "CONFIRMED" } },
      syncBatch: {
        batchId: "sync-1",
        syncSignature: "sync-1",
        resultId: "res-1",
        resultRevision: 2,
        tasks: [{ outboxId: "task-1", player: { id: "p1" }, payload: { clientId: "p1" } }],
      },
    },
  }) as any[];

  assert.equal(out[0].payload.length, 1);
  assert.equal(out[1].payload[1].$set.resultStatus, "CONFIRMED");
  assert.equal(out[2], null);
  assert.equal(out[4].payload[1].$set.status, "FINAL");
  assert.equal(out[0]._resultVivaSyncBatch.response.payload.status, "CONFIRMED");
  assert.equal(out[0].payload[0].projectionTask.outboxId, "task-1");
  assert.equal(out[5], null);
});

test("Viva sync finalize summarizes partial failures and prepares result summary update", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_viva_sync_finalize_batch.js", {
    _resultVivaSyncBatch: {
      syncSignature: "sync-1",
      resultId: "res-1",
      resultRevision: 2,
      startedAt: "2026-06-21T08:00:00.000Z",
      tasks: [{ outboxId: "1" }, { outboxId: "2" }],
      pendingState: { auditEventIds: ["evt-1", "evt-2"] },
      response: {
        statusCode: 200,
        payload: {
          status: "CONFIRMED",
          result: { id: "res-1", status: "CONFIRMED", vivaSync: { status: "PENDING" } },
        },
      },
    },
    payload: [
      { ok: true, attemptedAt: "2026-06-21T08:00:01.000Z", lastSuccessAt: "2026-06-21T08:00:01.000Z", auditEventId: "evt-1", player: { id: "p1", name: "A1" } },
      { ok: false, attemptedAt: "2026-06-21T08:00:02.000Z", error: "Missing clientId for Viva sync", auditEventId: "evt-2", player: { id: null, name: "A2" } },
    ],
  }) as any[];

  assert.equal(out[0].payload[0].revision, 2);
  assert.equal(out[0].payload[1].$set.vivaSync.status, "PARTIAL_SUCCESS");
  assert.equal(out[0].payload[1].$set.vivaSync.syncedPlayers, 1);
  assert.equal(out[1].payload.vivaSync.status, "PARTIAL_SUCCESS");
  assert.equal(out[1].payload.result.vivaSync.failures[0].reason, "Missing clientId for Viva sync");
});

test("state response returns sanitized vivaSync summary for latest result", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_state_response.js", {
    payload: [
      {
        id: "res-1",
        gameId: "game-1",
        status: "CONFIRMED",
        submittedAtTs: Date.now(),
        vivaSync: {
          status: "PARTIAL_SUCCESS",
          attempts: 1,
          lastAttemptAt: "2026-06-21T08:00:02.000Z",
          totalPlayers: 2,
          syncedPlayers: 1,
          failures: [{ id: "p2", phone: "79000000002", name: "A2", reason: "Missing clientId for Viva sync" }],
          auditEventIds: ["evt-1", "evt-2"],
        },
      },
    ],
    _resultState: {
      gameId: "game-1",
      phone: "79000000001",
      isFinished: true,
      endTs: Date.now() - 60_000,
      game: {},
      teams: {
        teamA: [{ phoneNorm: "79000000001" }],
        teamB: [{ phoneNorm: "79000000002" }],
      },
    },
  }) as any[];

  assert.equal(out[0].payload.latestResult.vivaSync.status, "PARTIAL_SUCCESS");
  assert.equal(out[0].payload.latestResult.vivaSync.syncedPlayers, 1);
  assert.equal(out[0].payload.latestResult.vivaSync.failures[0].reason, "Missing clientId for Viva sync");
});

test("retry query selects failed retryable outbox rows below 30 attempts", () => {
  const out = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_viva_sync_retry_query.js", {
    payload: {},
  }) as any[];

  assert.equal(out[0].payload.kind, "VIVA_ONBOARDING_LEVEL");
  assert.equal(out[0].payload.status, "FAILED");
  assert.deepEqual(out[0].payload.retryable, { $ne: false });
  assert.deepEqual(out[0].payload.attempts, { $lt: 30 });
});

test("retry prepare maps stored outbox row into sync task and skips exhausted rows", () => {
  const prepared = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_viva_sync_retry_prepare.js", {
    payload: {
      _id: "out-1",
      syncSignature: "sync-1",
      mode: "apply",
      source: "game_result_confirm",
      gameId: "game-1",
      resultId: "res-1",
      resultRevision: 2,
      player: { id: "p1", name: "A1", phoneNorm: "79000000001" },
      requestPayload: { clientId: "p1", levelNumeric: "3.10000" },
      attempts: 2,
      retryable: true,
    },
  }) as any[];
  assert.equal(prepared[0].payload.outboxId, "out-1");
  assert.equal(prepared[0].payload.attempts, 2);
  assert.equal(prepared[0].payload.payload.clientId, "p1");

  const exhausted = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_viva_sync_retry_prepare.js", {
    payload: {
      _id: "out-2",
      requestPayload: { clientId: "p2" },
      attempts: 30,
      retryable: true,
    },
  }) as any[];
  assert.equal(exhausted[0], null);
  assert.match(exhausted[1].payload.reason, /exhausted retry limit/i);
});

test("viva sync response increments attempts and summary rebuild reflects recovered success", () => {
  const handled = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_viva_sync_handle_response.js", {
    statusCode: 200,
    payload: { ok: true, auditEventId: "evt-1" },
    _resultVivaSyncAttemptedAt: "2026-06-21T09:00:00.000Z",
    _resultVivaSyncTask: {
      outboxId: "out-1",
      auditEventId: "evt-1",
      player: { id: "p1", name: "A1", phoneNorm: "79000000001" },
      resultId: "res-1",
      resultRevision: 2,
      syncSignature: "sync-1",
      attempts: 2,
    },
  }) as any[];

  assert.equal(handled[0].payload[1].$set.attempts, 3);
  assert.equal(handled[2].payload.attempts, 3);

  const rebuilt = runNodeRedFunction("scripts/nodered_result_nodes/fn_result_viva_sync_rebuild_summary.js", {
    payload: [
      {
        status: "SYNCED",
        resultId: "res-1",
        syncSignature: "sync-1",
        attempts: 3,
        lastAttemptAt: "2026-06-21T09:00:00.000Z",
        lastSuccessAt: "2026-06-21T09:00:00.000Z",
        auditEventId: "evt-1",
        player: { id: "p1", name: "A1", phoneNorm: "79000000001" },
      },
      {
        status: "SYNCED",
        resultId: "res-1",
        syncSignature: "sync-1",
        attempts: 1,
        lastAttemptAt: "2026-06-21T08:00:00.000Z",
        lastSuccessAt: "2026-06-21T08:00:00.000Z",
        auditEventId: "evt-2",
        player: { id: "p2", name: "A2", phoneNorm: "79000000002" },
      },
    ],
  }) as any[];

  assert.equal(rebuilt[0].payload[1].$set.vivaSync.status, "SUCCESS");
  assert.equal(rebuilt[0].payload[1].$set.vivaSync.syncedPlayers, 2);
  assert.equal(rebuilt[0].payload[1].$set.vivaSync.attempts, 3);
});
