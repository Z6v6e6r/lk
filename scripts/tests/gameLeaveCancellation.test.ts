import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { hasActiveGameLeaveMembership } from "../../src/components/games/gameLeaveMembership.ts";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const gamesEntrySource = fs.readFileSync("src/games.tsx", "utf8");
const selfLeavePreviewSource = fs.readFileSync("dev/self-leave-preview.html", "utf8");
const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");

const pageAst = ts.createSourceFile("GamesPage.tsx", gamesPageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function loadCallback(name: string, scope: Record<string, unknown>) {
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(pageAst) === name
      && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(pageAst);
  assert.ok(expression, `missing callback ${name}`);
  const compiled = ts.transpileModule(`return (${expression.getText(pageAst)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(scope), compiled)(...Object.values(scope));
}

async function organizerRemovalScenario(state: string, fresh: Record<string, unknown> | null, refreshError = false) {
  const player = { id: "fixture-player", name: "Fixture" };
  const calls = { exerciseReads: [] as string[], refreshes: 0, patches: 0, records: [] as unknown[], errors: [] as unknown[], updating: [] as boolean[] };
  const cancel = loadCallback("cancelVivaBookingsForPlayerFromDetails", {
    gameRecordId: "fixture-game", activeGameRecord: { id: "fixture-game", updatedAt: "old-version" },
    detailsSplitPaymentMetadata: {},
    normalizeBookingId: (value: unknown) => typeof value === "string" ? value.trim() || null : null,
    extractSplitPaymentBookingTargetsForPlayer: () => [{ bookingId: "fixture-booking", clientId: player.id }],
    resolveGameVivaExerciseId: () => "fixture-exercise",
    apiFetchTournamentParticipants: async (exercise: string) => {
      calls.exerciseReads.push(exercise);
      return { data: calls.exerciseReads.length === 1 ? [{ id: player.id }] : [], error: null };
    },
    extractExerciseBookingRows: (rows: unknown) => rows,
    vivaBookingMatchesPlayer: (row: { id: string }) => row.id === player.id,
    extractVivaBookingId: () => "fixture-booking", extractVivaBookingClientId: () => player.id,
    normalizePhoneForGame: () => null,
    apiCancelPadelSplitParticipantBookings: async () => ({ data: { ok: true, state, message: "server pending" }, error: null }),
    isRecordObject: (value: unknown) => Boolean(value) && typeof value === "object",
  });
  const remove = loadCallback("handleRemoveParticipantFromDetails", {
    gameRecordId: "fixture-game", canManagePlayersInDetails: true, updatingGameRoster: false,
    isDetailsOrganizerPlayer: () => false, detailsParticipants: [player],
    cancelVivaBookingsForPlayerFromDetails: cancel,
    setGameRosterError: (error: unknown) => calls.errors.push(error),
    setUpdatingGameRoster: (value: boolean) => calls.updating.push(value),
    apiFetchPadelGameRecord: async () => {
      calls.refreshes++;
      return { data: fresh, error: refreshError ? { message: "refresh unavailable" } : null };
    },
    upsertGameRecordInStores: (record: unknown, options: unknown) => calls.records.push({ record, options }),
    hasActiveGameLeaveMembership,
    patchGameRoster: async () => { calls.patches++; throw new Error("stale roster PATCH must not run"); },
  });
  await remove(player, 0);
  return calls;
}

for (const state of ["DONE", "RETURN_PENDING"]) {
  test(`organizer ${state} keeps exercise readback and refreshes canonical roster without a stale PATCH`, async () => {
    const fresh = { id: "fixture-game", updatedAt: "server-new-version", participants: [{ id: "fixture-other" }], metadata: { splitPayment: { payments: [{ clientId: "fixture-player", status: "LEFT" }] } } };
    const calls = await organizerRemovalScenario(state, fresh);
    assert.deepEqual(calls.exerciseReads, ["fixture-exercise", "fixture-exercise"]);
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.patches, 0);
    assert.deepEqual(calls.records, [{ record: fresh, options: { communityMode: "if_exists", recordMode: "replace" } }]);
    assert.equal(calls.errors.at(-1), null);
    assert.deepEqual(calls.updating, [true, false]);
  });
}

for (const state of ["IN_PROGRESS", "RETRY_REQUIRED", "VIVA_UNVERIFIED", "CONFLICT", "UNKNOWN"]) {
  test(`organizer ${state} cannot clear the local roster or issue another write`, async () => {
    const calls = await organizerRemovalScenario(state, null);
    assert.equal(calls.exerciseReads.length, 1, "pending is handled before success readback");
    assert.equal(calls.refreshes, 0);
    assert.equal(calls.patches, 0);
    assert.deepEqual(calls.records, []);
    assert.equal(calls.errors.at(-1), "server pending");
  });
}

test("organizer preserves concurrent rejoin and reports unresolved membership without retrying removal", async () => {
  const fresh = { id: "fixture-game", updatedAt: "rejoin-version", participants: [{ id: "fixture-player" }] };
  const calls = await organizerRemovalScenario("DONE", fresh);
  assert.equal(calls.patches, 0);
  assert.equal(calls.records.length, 1, "new canonical membership remains visible");
  assert.match(String(calls.errors.at(-1)), /записался снова/);
});

test("organizer completed cancellation does not manufacture success when canonical refresh fails or mismatches", async () => {
  for (const [fresh, error] of [[null, false], [{ id: "another-game" }, false], [{ id: "fixture-game" }, true]] as const) {
    const calls = await organizerRemovalScenario("DONE", fresh, error);
    assert.equal(calls.patches, 0);
    assert.deepEqual(calls.records, []);
    assert.ok(calls.errors.at(-1));
    assert.deepEqual(calls.updating, [true, false]);
  }
});

test("cabinet organizer remove still uses backend split leave helper", () => {
  const helperStart = gamesPageSource.indexOf("const cancelVivaBookingsForPlayerFromDetails = useCallback");
  const helperEnd = gamesPageSource.indexOf("const buildNextSetPairingsForTeamSlots", helperStart);
  assert.ok(helperStart >= 0, "leave helper should exist");
  assert.ok(helperEnd > helperStart, "leave helper should have a bounded source slice");

  const helperSource = gamesPageSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /apiFetchTournamentParticipants\(exerciseId,\s*\{\s*sanitize:\s*false\s*\}\)/);
  assert.match(helperSource, /extractExerciseBookingRows\(participantsResult\.data\)/);
  assert.match(helperSource, /apiCancelPadelSplitParticipantBookings\(gameRecordId/);
  assert.match(helperSource, /if \(!exerciseId\) \{/);
  assert.match(helperSource, /verificationResult\.error \|\| !verificationResult\.data/);
  assert.match(helperSource, /Viva ещё держит запись игрока, попробуйте повторить позже/);

  const apiHelperStart = apiClientSource.indexOf(
    "export async function apiCancelPadelSplitParticipantBookings",
  );
  const apiHelperEnd = apiClientSource.indexOf(
    "export async function apiCleanupPadelGameByOrganizer",
    apiHelperStart,
  );
  assert.ok(apiHelperStart >= 0);
  assert.ok(apiHelperEnd > apiHelperStart);
  assert.match(apiClientSource.slice(apiHelperStart, apiHelperEnd), /auth:\s*true/);
});

test("cabinet self-remove delegates the whole operation to authenticated server leave", () => {
  const leaveHandlerStart = gamesPageSource.indexOf("const handleLeaveCurrentUserFromDetails = useCallback");
  const leaveHandlerEnd = gamesPageSource.indexOf("const handleSplitJoinCurrentUserFromDetails = useCallback", leaveHandlerStart);
  assert.ok(leaveHandlerStart >= 0, "self leave handler should exist");
  assert.ok(leaveHandlerEnd > leaveHandlerStart, "self leave handler should have a bounded source slice");
  const leaveHandlerSource = gamesPageSource.slice(leaveHandlerStart, leaveHandlerEnd);
  assert.match(gamesPageSource, /selfLeavePreview\?\.request \?\? apiLeavePadelGameAsCurrentUser/);
  assert.match(leaveHandlerSource, /leaveCurrentUserRequest\(gameRecordId\)/);
  assert.doesNotMatch(leaveHandlerSource, /SELF_REMOVE_RETRY_DELAYS_MS|await delay/);
  assert.equal((leaveHandlerSource.match(/await leaveCurrentUserRequest\(gameRecordId\)/g) || []).length, 1);
  assert.match(leaveHandlerSource, /observeGameLeave\(/);
  assert.match(leaveHandlerSource, /setUpdatingGameRoster\(false\)/);
  assert.match(leaveHandlerSource, /setLeavePendingMessage\(SELF_REMOVE_START_NOTICE\)/);
  assert.doesNotMatch(leaveHandlerSource, /apiCancelPadelSelfRemovalBookings/);
  assert.doesNotMatch(leaveHandlerSource, /patchGameRoster\(/);
  assert.match(leaveHandlerSource, /pushCabinetFlashNotice\(finalMessage\)/);
  assert.match(leaveHandlerSource, /navigateToCabinetFromGamesDetails\(\)/);
});

test("completed self leave still verifies fresh membership before success", () => {
  const leaveHandlerStart = gamesPageSource.indexOf("const handleLeaveCurrentUserFromDetails = useCallback");
  const leaveHandlerEnd = gamesPageSource.indexOf("const handleSplitJoinCurrentUserFromDetails = useCallback", leaveHandlerStart);
  const leaveHandlerSource = gamesPageSource.slice(leaveHandlerStart, leaveHandlerEnd);
  // The unresolved branch must refresh the game, exit when the player is already gone and
  // otherwise clear the disabled "leaving" state with the real server message.
  assert.match(leaveHandlerSource, /const refreshed = await apiFetchPadelGameRecord\(gameRecordId\)/);
  assert.match(leaveHandlerSource, /upsertGameRecordInStores\(refreshedRecord, \{ communityMode: "if_exists", recordMode: "replace" \}\)/);
  assert.match(leaveHandlerSource, /hasActiveGameLeaveMembership\(refreshedRecord/);
  assert.match(leaveHandlerSource, /finalMessage = finalMessage \|\| SELF_REMOVE_SUCCESS_NOTICE/);
  assert.match(leaveHandlerSource, /setLeavePendingMessage\(null\)/);
  assert.match(leaveHandlerSource, /setGameRosterError\(SELF_REMOVE_PENDING_NOTICE\)/);
  assert.doesNotMatch(leaveHandlerSource, /if \(!finalMessage\) \{\s*setLeavePendingMessage\(SELF_REMOVE_PENDING_NOTICE\);\s*return;\s*\}/);
});

test("self leave renders an in-roster pending spinner and keeps the background state visible", () => {
  assert.match(gamesPageSource, /SELF_REMOVE_START_NOTICE/);
  assert.match(gamesPageSource, /Отправляем запрос на выход из игры/);
  assert.match(gamesPageSource, /details-roster-leave-spinner/);
  assert.match(gamesPageSource, /game-empty details-roster-leave-status/);
  assert.match(
    gamesPageSource,
    /details-roster-leave-status[\s\S]*details-roster-leave-spinner[\s\S]*leavePendingMessage/,
  );
  assert.match(gamesPageSource, /isCurrentUserLeaving \? "Покидает игру"/);
  assert.match(gamesPageSource, /Можно вернуться к другим играм/);
});

test("self leave browser preview is loopback-only and cannot call the real leave API", () => {
  assert.match(gamesEntrySource, /\["127\.0\.0\.1", "localhost", "::1"\]\.includes\(window\.location\.hostname\)/);
  assert.match(gamesEntrySource, /searchParams\.get\("leavePreview"\) === "1"/);
  assert.match(gamesEntrySource, /state: "IN_PROGRESS"/);
  assert.match(gamesEntrySource, /state: "DONE"/);
  assert.match(gamesEntrySource, /selfLeavePreview=\{selfLeavePreview\}/);
  assert.doesNotMatch(gamesEntrySource, /apiLeavePadelGameAsCurrentUser/);
  assert.doesNotMatch(gamesEntrySource, /Viva/);
  assert.match(gamesPageSource, /typeof window !== "undefined" && !isSelfLeavePreviewMode/);
  assert.match(selfLeavePreviewSource, /openGameId: "dev-self-leave-preview"/);
});
