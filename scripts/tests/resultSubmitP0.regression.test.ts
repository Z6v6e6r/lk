import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  const env = { get: (name: string) => name === "PADLHUB_PLATFORM_TENANT_KEY" ? "tenant" : undefined };
  const input = file.endsWith("fn_result_submit_prepare.js")
    ? {
        ...msg,
        payload: {
          idempotencyKey: "test-result-idempotency-key",
          ...(msg.payload as Record<string, unknown>),
        },
      }
    : file.endsWith("fn_result_submit_build_insert.js")
      ? {
          ...msg,
          _resultSubmit: {
            idempotencyKey: "test-result-idempotency-key",
            ...(msg._resultSubmit as Record<string, unknown>),
          },
        }
    : msg;
  return new Function("msg", "env", source)(input, env);
}

function extractBalancedBlock(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `Cannot find marker: ${marker}`);

  const bodyStart = source.indexOf("{", markerIndex);
  assert.ok(bodyStart >= 0, `Cannot find body for marker: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(markerIndex, index + 1);
    }
  }

  assert.fail(`Cannot extract balanced block for marker: ${marker}`);
}

function extractEffectContaining(source: string, marker: string) {
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex >= 0, `Cannot find effect marker: ${marker}`);

  const effectStart = source.lastIndexOf("  useEffect(() => {", markerIndex);
  assert.ok(effectStart >= 0, `Cannot find effect start for marker: ${marker}`);

  const nextEffect = source.indexOf("\n  useEffect(() => {", markerIndex + marker.length);
  return source.slice(effectStart, nextEffect >= 0 ? nextEffect : source.length);
}

function mongoOperatorPathConflicts(leftPaths: string[], rightPaths: string[]) {
  return leftPaths.flatMap((left) => rightPaths
    .filter((right) => (
      left === right
      || left.startsWith(`${right}.`)
      || right.startsWith(`${left}.`)
    ))
    .map((right) => [left, right] as const));
}

test("result submit upsert has no conflicting setOnInsert and set paths", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_build_insert.js",
    {
      payload: [],
      _resultSubmit: {
        gameId: "game-p0",
        phone: "79000000001",
        scoreA: 6,
        scoreB: 4,
        sets: [{ left: 6, right: 4 }],
        scoringSets: [{ left: 6, right: 4 }],
        setPairings: [],
        resolvedSetPairings: [],
        attachments: [],
        ratingEnabled: false,
        game: { id: "game-p0", tenantKey: "tenant" },
        teams: { teamA: [], teamB: [], source: "test" },
        actorMember: {
          memberKey: "id:p1",
          id: "p1",
          phoneNorm: "79000000001",
          name: "Player 1",
        },
      },
    },
  ) as any[];

  const resultWrite = out[0];
  assert.ok(resultWrite, "result submit must emit the canonical result write first");
  const update = resultWrite.payload[1] || {};
  const conflicts = mongoOperatorPathConflicts(
    Object.keys(update.$setOnInsert || {}),
    Object.keys(update.$set || {}),
  );

  assert.deepEqual(
    conflicts,
    [],
    `Mongo rejects paths present in both $setOnInsert and $set: ${JSON.stringify(conflicts)}`,
  );
  assert.equal(update.$setOnInsert.status, "PENDING_REVIEW");
});

test("result session update uses revision in the Mongo write filter", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_update_build.js",
    {
      payload: [
        {
          _id: "result_session_game-p0",
          id: "result_session_game-p0",
          gameId: "game-p0",
          revision: 4,
          draftSets: [],
          draftPairings: [],
          attachments: [],
          resultRosterSnapshot: {
            members: [
              {
                memberKey: "id:p1",
                id: "p1",
                phoneNorm: "79000000001",
                name: "Player 1",
              },
            ],
            allowedMemberKeys: ["id:p1"],
            participantMemberKeys: ["id:p1"],
            waitlistMemberKeys: [],
            initialTeamMemberKeys: ["id:p1"],
          },
        },
      ],
      _resultSessionPatch: {
        gameId: "game-p0",
        sessionId: "result_session_game-p0",
        phone: "79000000001",
        actor: { id: "p1", phone: "79000000001", name: "Player 1" },
        expectedRevision: 4,
        hasDraftSets: true,
        draftSets: [{ left: 6, right: 4 }],
        hasDraftPairings: false,
        hasAttachments: false,
      },
    },
  ) as any[];

  const write = out[0];
  assert.ok(write, "valid session update must emit a Mongo write");
  assert.deepEqual(write.payload[0], {
    _id: "result_session_game-p0",
    revision: 4,
  });
  assert.equal(write.payload[1].$set.revision, 5);
});

test("submit emits no projections or success response when the durable result write fails", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_after_write.js",
    {
      payload: [{ acknowledged: false, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }],
      _resultSubmitDoc: {
        id: "result-p0",
        gameId: "game-p0",
        submittedAt: "2026-07-12T09:00:00.000Z",
        updatedAt: "2026-07-12T09:00:00.000Z",
      },
    },
  ) as any[];

  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], null);
  assert.equal(out[3].statusCode, 503);
  assert.equal(out[3].payload.code, "RESULT_PERSISTENCE_FAILED");
});

test("fast submit acknowledgement returns the complete saved result draft", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_submit_response.js",
    {
      statusCode: 202,
      _resultSubmitDoc: {
        id: "result-p0",
        gameId: "game-p0",
        status: "PENDING_REVIEW",
        lifecycleState: "PENDING_REVIEW",
        score: { teamA: 6, teamB: 4 },
        sets: [{ left: 6, right: 4 }],
        setPairings: [{
          setIndex: 0,
          teamSlots: [
            { memberKey: "rm_p1", name: "P1" },
            { memberKey: "rm_p2", name: "P2" },
            { memberKey: "rm_p3", name: "P3" },
            { memberKey: "rm_p4", name: "P4" },
          ],
        }],
        rosterSnapshot: { members: [], initialTeamSlots: [] },
        submittedBy: { memberKey: "id:p1", name: "P1", phoneNorm: "79000000001" },
        submittedAt: "2026-07-12T09:00:00.000Z",
        submittedAtTs: Date.parse("2026-07-12T09:00:00.000Z"),
        disputeDeadlineAt: "2026-07-13T09:00:00.000Z",
        resultPayload: {
          attachments: [{ id: "photo-1", dataUrl: "data:image/jpeg;base64,AA==" }],
        },
        ratingImpact: [],
        ratingEvent: null,
      },
    },
  ) as any[];

  const response = out[0];
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.payload.result.sets, [{ left: 6, right: 4 }]);
  assert.equal(response.payload.result.setPairings[0].teamSlots[1].name, "P2");
  assert.equal(response.payload.result.attachments[0].id, "photo-1");
  assert.equal(response.payload.result.submittedAt, "2026-07-12T09:00:00.000Z");
  assert.notEqual(response.payload.result.submittedBy.memberKey, "id:p1");
  assert.equal(response.payload.result.viewer.role, "AUTHOR");

  const stateResponseSource = fs.readFileSync(
    "scripts/nodered_result_nodes/fn_result_state_response.js",
    "utf8",
  );
  assert.match(
    stateResponseSource,
    /attachments:\s*asArray\(latest\.resultPayload\?\.attachments\)/,
    "result state must preserve saved attachments after reload",
  );
});

test("session update acknowledges only the winning revision CAS write", () => {
  const baseMsg = {
    _resultSessionExpectedRevision: 4,
    _resultSessionResponse: {
      gameId: "game-p0",
      sessionId: "result_session_game-p0",
      revision: 5,
    },
  };
  const conflict = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_update_after_write.js",
    {
      ...baseMsg,
      payload: [{ acknowledged: true, matchedCount: 0, modifiedCount: 0 }],
    },
  ) as any[];
  assert.equal(conflict[0].statusCode, 409);
  assert.equal(conflict[0].payload.code, "RESULT_SESSION_REVISION_CONFLICT");

  const saved = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_update_after_write.js",
    {
      ...baseMsg,
      payload: [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }],
    },
  ) as any[];
  assert.equal(saved[0].statusCode, 200);
  assert.equal(saved[0].payload.revision, 5);
});

test("new result session preserves the canonical initial team order", () => {
  const participants = [
    { memberKey: "id:p1", id: "p1", phoneNorm: "79000000001", name: "P1" },
    { memberKey: "id:p2", id: "p2", phoneNorm: "79000000002", name: "P2" },
    { memberKey: "id:p3", id: "p3", phoneNorm: "79000000003", name: "P3" },
    { memberKey: "id:p4", id: "p4", phoneNorm: "79000000004", name: "P4" },
  ];
  const initialTeamMemberKeys = ["id:p1", "id:p3", "id:p2", "id:p4"];
  const game = {
    id: "game-p0-team-order",
    booking: {
      date: "2026-07-10",
      timeFrom: "18:00",
      timeTo: "19:30",
      vivaExerciseId: "viva-team-order",
    },
    participants,
    waitlist: [],
    metadata: {
      teamSlots: [participants[0], participants[2], participants[1], participants[3]],
    },
    resultRosterSnapshot: {
      members: participants,
      allowedMemberKeys: participants.map((participant) => participant.memberKey),
      participantMemberKeys: participants.map((participant) => participant.memberKey),
      waitlistMemberKeys: [],
      initialTeamMemberKeys,
      initialTeamSlots: [participants[0], participants[2], participants[1], participants[3]],
    },
  };

  const prepareOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_prepare.js",
    {
      req: { params: { gameId: game.id }, query: {} },
      payload: {
        phone: "79000000001",
        submittedBy: { id: "p1", phone: "79000000001", name: "P1" },
      },
    },
  ) as any[];
  const prepared = prepareOut[0];
  prepared.payload = [game];

  const queryOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_prepare_session_query.js",
    prepared,
  ) as any[];
  const sessionQuery = queryOut[0];
  sessionQuery.payload = [];

  const buildOut = runNodeRedFunction(
    "scripts/nodered_result_nodes/fn_result_session_open_build.js",
    sessionQuery,
  ) as any[];
  const response = buildOut[0]?._resultSessionResponse;

  assert.ok(response, "session open write must retain its post-write response payload");
  assert.deepEqual(
    response.rosterSnapshot.initialTeamSlots.map((slot: any) => slot?.name ?? null),
    ["P1", "P3", "P2", "P4"],
  );
  assert.deepEqual(
    response.draftPairings[0].teamSlots.map((slot: any) => slot?.name ?? null),
    ["P1", "P3", "P2", "P4"],
  );
});

test("session open effect is not cancelled by its own loading state update", () => {
  const sessionOpenEffect = extractEffectContaining(
    gamesPageSource,
    "void apiOpenPadelGameResultSession",
  );

  assert.doesNotMatch(
    sessionOpenEffect,
    /\|\|\s*detailsMatchResultSessionLoading/,
    "loading state in the open guard reruns cleanup and discards the successful response",
  );
  assert.doesNotMatch(
    sessionOpenEffect,
    /\n\s*detailsMatchResultSessionLoading,\s*\n/,
    "loading state must not be an open-effect dependency",
  );
  assert.match(
    sessionOpenEffect,
    /detailsMatchResultSession\?\.sessionId/,
    "clearing a conflicted session must retrigger the open effect",
  );
});

test("session CAS conflict reloads the winning draft instead of overwriting it", () => {
  const persistStart = gamesPageSource.indexOf("const persistMatchResultSessionDraft = useCallback");
  const persistEnd = gamesPageSource.indexOf("\n  useEffect(() => {", persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart);
  const persistDraft = gamesPageSource.slice(persistStart, persistEnd);
  const conflictIndex = persistDraft.indexOf("result.error?.status === 409");
  const clearDirtyIndex = persistDraft.indexOf("detailsMatchResultDraftDirtyRef.current = false", conflictIndex);
  const clearSessionIndex = persistDraft.indexOf("setDetailsMatchResultSession(null)", conflictIndex);

  assert.ok(conflictIndex >= 0);
  assert.ok(clearDirtyIndex > conflictIndex);
  assert.ok(
    clearSessionIndex > clearDirtyIndex,
    "the stale local draft must lose dirty authority before the server session is reopened",
  );
});

test("result team changes use session autosave without blocking on game metadata PATCH", () => {
  const persistStart = gamesPageSource.indexOf("const persistTeamSlots = useCallback");
  const persistEnd = gamesPageSource.indexOf("\n  const handleTeamSlotPick", persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart);
  const persistTeams = gamesPageSource.slice(persistStart, persistEnd);
  const resultFastPathIndex = persistTeams.indexOf("if (canEditMatchResult)");
  const metadataPatchIndex = persistTeams.indexOf("saveDetailsMetadata");

  assert.ok(resultFastPathIndex >= 0);
  assert.ok(metadataPatchIndex > resultFastPathIndex);
  assert.match(
    persistTeams.slice(resultFastPathIndex, metadataPatchIndex),
    /return true;/,
  );
});

test("dirty result draft is guarded before initial team hydration", () => {
  const hydrationEffect = extractEffectContaining(
    gamesPageSource,
    "setDetailsTeamSlots(nextSlotPlayers);",
  );
  const dirtyGuardIndex = hydrationEffect.indexOf("detailsMatchResultDraftDirtyRef.current");
  const teamHydrationIndex = hydrationEffect.indexOf("setDetailsTeamSlots(nextSlotPlayers);");

  assert.ok(dirtyGuardIndex >= 0, "result hydration must check the local dirty draft");
  assert.ok(teamHydrationIndex >= 0, "result hydration must populate initial team slots");
  assert.ok(
    dirtyGuardIndex < teamHydrationIndex,
    "dirty draft guard must run before team hydration can reset user-selected teams",
  );
});

test("restored result draft hydrates current teams from the latest saved pairing", () => {
  const hydrationEffect = extractEffectContaining(
    gamesPageSource,
    "setDetailsTeamSlots(nextSlotPlayers);",
  );
  const latestPairingIndex = hydrationEffect.indexOf("const latestDraftPairing");
  const latestPairingSlotsIndex = hydrationEffect.indexOf("Array.isArray(latestDraftPairing?.teamSlots)");
  const initialSlotsIndex = hydrationEffect.indexOf("sessionRosterSnapshot?.initialTeamSlots");

  assert.ok(latestPairingIndex >= 0, "session draft must select its latest explicit pairing");
  assert.ok(latestPairingSlotsIndex > latestPairingIndex);
  assert.ok(
    initialSlotsIndex > latestPairingSlotsIndex,
    "immutable initial teams must only be the fallback when no draft pairing was saved",
  );
});

test("result submit has stable client idempotency and no automatic POST retry", () => {
  const resultPayloadInterface = extractBalancedBlock(
    apiClientSource,
    "export interface PadelGameResultSubmitPayload",
  );
  const resultRequest = extractBalancedBlock(
    apiClientSource,
    "async function requestPadelGameResultAction",
  );
  const sessionRequestStart = apiClientSource.indexOf("async function requestPadelGameResultSession");
  const sessionRequestEnd = apiClientSource.indexOf("\nexport async function apiFetchPadelGameResultState", sessionRequestStart);
  assert.ok(sessionRequestStart >= 0 && sessionRequestEnd > sessionRequestStart);
  const sessionRequest = apiClientSource.slice(sessionRequestStart, sessionRequestEnd);
  const submitHandler = extractBalancedBlock(
    gamesPageSource,
    "const handleSubmitMatchResult = useCallback",
  );

  assert.match(resultPayloadInterface, /idempotencyKey:\s*string\s*;/);
  assert.match(resultRequest, /retries:\s*action\s*===\s*["']submit["']\s*\?\s*0\s*:\s*1/);
  assert.match(resultRequest, /action\s*===\s*["']submit["']\s*\?\s*new AbortController\(\)/);
  assert.match(resultRequest, /submitController\.abort\(\)/);
  assert.match(resultRequest, /10_000/);
  assert.match(resultRequest, /auth:\s*true/);
  assert.match(sessionRequest, /new AbortController\(\)/);
  assert.match(sessionRequest, /8_000/);
  assert.match(sessionRequest, /signal:\s*controller\.signal/);
  assert.match(sessionRequest, /auth:\s*true/);
  assert.match(gamesPageSource, /const detailsMatchResultSubmissionRef\s*=\s*useRef/);
  assert.match(submitHandler, /detailsMatchResultSubmissionRef\.current/);
  assert.match(submitHandler, /draftKey/);
  assert.match(submitHandler, /idempotencyKey/);
  assert.match(
    submitHandler,
    /apiSubmitPadelGameResult[\s\S]*?\{[\s\S]*?idempotencyKey[,\s]/,
    "submit payload must carry the stable idempotency key",
  );
  assert.match(
    submitHandler,
    /setDetailsMatchResultSession\(null\);[\s\S]*?detailsMatchResultDraftDirtyRef\.current = false/,
    "successful submit must stop a stale session draft from overriding the canonical result response",
  );
});

test("live Node-RED snapshots stay outside the repository", () => {
  const tracked = spawnSync("git", ["ls-files", "node-red/modular"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const ignored = spawnSync("git", ["check-ignore", "-q", "node-red/modular/source.flow.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), "");
  assert.equal(ignored.status, 0, "node-red/modular must remain ignored");
});
