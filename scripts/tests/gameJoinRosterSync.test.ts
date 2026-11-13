import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { PadelGamePlayer } from "../../src/utils/apiClient.ts";
import { clearPreviousLeaveEventsForLocalJoin } from "../../src/components/games/localMembershipGeneration.ts";
import { reconcileRosterWithViva, type RosterSyncLeaveEvent } from "../../src/components/games/rosterSyncReconcile.ts";

// Source-level contract for the invite/join page, which keeps its own roster
// projection and its own join/decline entry points. The leave decision itself was
// moved to the durable server saga: this page only calls the leaf endpoint and
// reacts to its state, so the assertions below track that contract.
const gameJoinPageSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");

test("game join page syncs split roster with live Viva participants", () => {
  assert.match(gameJoinPageSource, /apiFetchTournamentParticipants\(exerciseId,\s*\{\s*sanitize:\s*false\s*\}\)/);
  assert.match(gameJoinPageSource, /reconcileRosterWithViva\(/);
  assert.match(gameJoinPageSource, /const splitPaymentGame = isSplitPaymentGame\(game\)/);
  assert.match(gameJoinPageSource, /shouldSkipRecentSplitGameRosterSync\(/);
  assert.match(gameJoinPageSource, /const nextWaitlist = excludePlayersAlreadyInRoster\(/);
  assert.match(gameJoinPageSource, /waitlistChanged = !arePlayersEqualByIdentity\(/);
  assert.match(gameJoinPageSource, /waitlistChanged \? \{ waitlist: nextWaitlist \} : \{\}/);
  assert.match(
    gameJoinPageSource,
    /useEffect\(\(\) => \{\s*if \(subscriptionUsageShadowEnabled\) return;\s*if \(!game \|\| !profile\) return;/,
  );
});

test("game join leave decision uses the durable leave saga and surfaces every state", () => {
  assert.match(gameJoinPageSource, /apiLeavePadelGameAsCurrentUser\(actualGame\.id\)/);
  // A failed request surfaces the server message instead of a silent no-op.
  assert.match(gameJoinPageSource, /setDecisionError\(leaveResult\.error\?\.message \|\| "Не удалось покинуть игру"\)/);
  // Pending work is reported as pending, never as success.
  assert.match(
    gameJoinPageSource,
    /leaveResult\.data\.state === "RETRY_REQUIRED" \|\| leaveResult\.data\.state === "IN_PROGRESS"/,
  );
  assert.match(gameJoinPageSource, /pushCabinetFlashNotice\(leaveResult\.data\.message \|\| SELF_REMOVE_PENDING_NOTICE\)/);
  // Anything that is not DONE keeps the player on the page with an explanation.
  assert.match(gameJoinPageSource, /if \(leaveResult\.data\.state !== "DONE"\) \{/);
  // The authoritative record is re-read before the success path completes.
  assert.match(gameJoinPageSource, /apiFetchPadelGameRecord\(actualGame\.id\)/);
  assert.match(gameJoinPageSource, /decisionError && \(/);
});

test("game join page does not carry the removed client-side cancellation ladder", () => {
  // These helpers belonged to the pre-saga flow and exist nowhere in the tree.
  for (const removed of [
    "resolveLeaveBookingTargetsForProfile",
    "vivaBookingMatchesProfile",
    "apiCancelPadelSelfRemovalBookings",
    "selfRemovalAuditLog",
    "lastSelfRemovalAuditAt",
    "Не удалось проверить Viva exerciseId для leave",
  ]) {
    assert.equal(
      gameJoinPageSource.includes(removed),
      false,
      `${removed} reappeared in GameJoinPage`,
    );
  }
});

const rejoinPlayer: PadelGamePlayer = {
  id: "rejoined-client", name: "Fixture rejoiner", phone: "70000000001",
  membershipId: "local:new-generation", source: "INVITE_LINK", status: "CONFIRMED",
};
const priorLeave = {
  playerId: rejoinPlayer.id, playerPhone: rejoinPlayer.phone,
  leftAt: "2026-11-11T20:21:15.894Z", reason: "PLAYER_LEFT",
};
const otherLeave = { playerId: "other-client", leftAt: priorLeave.leftAt };
const metadataFixture = () => ({
  leaveEvents: [{ ...priorLeave }, { ...otherLeave }],
  playerLeaveEvents: [{ ...priorLeave }],
  leftPlayers: [{ id: rejoinPlayer.id, phone: rejoinPlayer.phone }],
  selfRemovalAuditLog: [{ operationId: "historic-leave", at: priorLeave.leftAt }],
  leaveOperations: [{ operationId: "historic-leave", state: "DONE" }],
  splitPayment: { payments: [{ clientId: "organizer", status: "PAID" }] },
  joinResponses: { "70000000001": { status: "DECLINED" } },
});

test("new local membership clears its old blockers in every alias without altering audit or input", () => {
  const metadata = metadataFixture();
  const before = structuredClone(metadata);
  const cleaned = clearPreviousLeaveEventsForLocalJoin(metadata, rejoinPlayer);
  assert.deepEqual(metadata, before);
  assert.notEqual(cleaned, metadata);
  assert.deepEqual(cleaned.leaveEvents, [otherLeave]);
  assert.deepEqual(cleaned.playerLeaveEvents, []);
  assert.deepEqual(cleaned.leftPlayers, []);
  for (const key of ["selfRemovalAuditLog", "leaveOperations", "splitPayment", "joinResponses"] as const) {
    assert.equal(cleaned[key], metadata[key], `${key} must be retained untouched`);
  }
  assert.deepEqual(clearPreviousLeaveEventsForLocalJoin(cleaned, rejoinPlayer), cleaned);
});

test("leave cleanup uses strong ID precedence, phone fallback and no actor/name matching", () => {
  const sameIdChangedPhone = { playerId: " REJOINED-CLIENT ", playerPhone: "70000000002" };
  const onlyPhone = { playerPhone: ["8", "000", "000", "00", "01"].join("") };
  const legacyPhone = { phone: "0000000001" };
  const differentIdSamePhone = { playerId: "other-client", playerPhone: rejoinPlayer.phone };
  const sameName = { playerName: rejoinPlayer.name };
  const actorOnly = { byId: rejoinPlayer.id, byPhone: rejoinPlayer.phone };
  const malformed = [null, 0, "unknown", [], { playerId: {}, playerPhone: {} }];
  const retained = [differentIdSamePhone, sameName, actorOnly, ...malformed];
  const result = clearPreviousLeaveEventsForLocalJoin({
    leaveEvents: [sameIdChangedPhone, onlyPhone, legacyPhone, ...retained],
    playerLeaveEvents: "malformed-legacy-field",
  }, rejoinPlayer);
  assert.deepEqual(result.leaveEvents, retained);
  assert.equal(result.playerLeaveEvents, "malformed-legacy-field");
  assert.equal(Object.hasOwn(result, "leftPlayers"), false);
  assert.deepEqual(clearPreviousLeaveEventsForLocalJoin({ leaveEvents: [priorLeave] }, {}), {
    leaveEvents: [priorLeave],
  });
  assert.deepEqual(clearPreviousLeaveEventsForLocalJoin({ leaveEvents: [priorLeave] }, {
    phone: rejoinPlayer.phone,
  }).leaveEvents, []);
});

function rosterSync(participants: PadelGamePlayer[], metadata: Record<string, unknown>, viva = participants.slice(0, 3)) {
  return reconcileRosterWithViva({
    sourceParticipants: participants,
    vivaParticipants: viva,
    leaveEvents: (metadata.leaveEvents ?? []) as RosterSyncLeaveEvent[],
  });
}

test("rejoin survives repeated Viva reconciliation, but a later genuine leave still removes it", () => {
  const existing = ["organizer", "second-client", "third-client"].map((id) => ({
    id, name: id, source: "INVITE_LINK", status: "CONFIRMED",
  } satisfies PadelGamePlayer));
  const participants = [...existing, rejoinPlayer];
  const metadata = { leaveEvents: [priorLeave] };
  // The unchanged reconciliation reproduces the reported loss before cleanup.
  assert.equal(rosterSync(participants, metadata).mergedCandidates.length, 3);
  const joinedMetadata = clearPreviousLeaveEventsForLocalJoin(metadata, rejoinPlayer);
  const first = rosterSync(participants, joinedMetadata);
  assert.equal(first.mergedCandidates.length, 4);
  assert.equal(first.filteredSourcePlayersCount, 0);
  assert.deepEqual(rosterSync(first.mergedCandidates, joinedMetadata).mergedCandidates, first.mergedCandidates);
  const leftMetadata = { ...joinedMetadata, leaveEvents: [{ ...priorLeave, leftAt: "2026-11-13T10:00:00.000Z" }] };
  assert.equal(rosterSync(first.mergedCandidates, leftMetadata).mergedCandidates.length, 3);
  // Metadata alone never recreates an absent participant from a historic JOINED.
  assert.equal(rosterSync(existing, { ...joinedMetadata, joinResponses: { fixture: { status: "JOINED" } } }).mergedCandidates.length, 3);
});

// Execute the actual ordinary-join branch up to its write. The React shell and
// transport are fixtures; the production payload construction is not duplicated.
function localJoinBranch(file: string, endMarker: string): string {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let statements: readonly ts.Statement[] | undefined;
  let start = -1;
  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name) && declaration.name.text === "localMembershipId"
    )) && ts.isBlock(node.parent)) {
      statements = node.parent.statements;
      start = statements.indexOf(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(statements && start >= 0, "actual local membership branch");
  const end = statements.findIndex((statement, index) => index >= start && statement.getText(source).includes(endMarker));
  assert.ok(end >= start, "actual versioned write");
  return ts.transpileModule(`(async () => { ${statements.slice(start, end + 1).map((statement) => statement.getText(source)).join("\n")} })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const inviteBranch = localJoinBranch("src/components/games/GameJoinPage.tsx", "const updateResult = await apiUpdatePadelGameRecord");
const detailsBranch = localJoinBranch("src/components/games/GamesPage.tsx", "await patchGameRoster(nextParticipants");

for (const route of ["invite", "details"]) {
  for (const hasSlot of [true, false]) {
    test(`${route} ordinary ${hasSlot ? "roster" : "waitlist"} rejoin writes cleanup with the new membership`, async () => {
      const metadata = metadataFixture();
      const participants = ["organizer", "second-client", "third-client", ...(!hasSlot ? ["fourth-client"] : [])]
        .map((id) => ({ id, name: id, status: "CONFIRMED", source: "INVITE_LINK" } satisfies PadelGamePlayer));
      const writes: Array<{ participants: PadelGamePlayer[]; waitlist: PadelGamePlayer[]; metadata: Record<string, unknown>; expectedUpdatedAt?: string }> = [];
      const context = vm.createContext({
        participants: structuredClone(participants), waitlist: [], myPlayer: rejoinPlayer,
        maxPlayers: 4, waitlistEnabled: true, appliedStatus: null,
        actualGame: { id: "fixture-game", updatedAt: "fixture-version", metadata },
        createLocalMembershipId: () => rejoinPlayer.membershipId,
        clearPreviousLeaveEventsForLocalJoin, isRecord: (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v),
        isRecordObject: (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v),
        myPhoneNorm: rejoinPlayer.phone, comment: "", setSubmitting: () => {}, setDecisionError: assert.fail,
        apiUpdatePadelGameRecord: async (_id: string, payload: typeof writes[number]) => { writes.push(payload); return {}; },
        normalizedProfileId: rejoinPlayer.id, normalizedPhone: rejoinPlayer.phone, profileName: rejoinPlayer.name,
        profilePhoto: null, profileGrade: null, profileRatingNumeric: null, detailsHasFreeSlots: hasSlot,
        detailsParticipants: participants, detailsWaitlist: [], detailsMetadata: metadata,
        isCurrentUserPlayer: (p: PadelGamePlayer) => p.id === rejoinPlayer.id,
        dedupePlayersByIdentity: (players: PadelGamePlayer[]) => players,
        buildDetailsRosterMetadata: (_p: unknown, _w: unknown, options: { extraMetadata?: Record<string, unknown> }) => ({ ...metadata, ...options.extraMetadata }),
        patchGameRoster: async (p: PadelGamePlayer[], w: PadelGamePlayer[], options: { metadata: Record<string, unknown> }) => {
          writes.push({ participants: p, waitlist: w, metadata: options.metadata });
        },
      });
      await vm.runInContext(route === "invite" ? inviteBranch : detailsBranch, context);
      assert.equal(writes.length, 1);
      const write = writes[0];
      assert.deepEqual(write.metadata.leaveEvents, [otherLeave]);
      assert.deepEqual(write.metadata.playerLeaveEvents, []);
      assert.deepEqual(write.metadata.leftPlayers, []);
      assert.equal(write.metadata.selfRemovalAuditLog, metadata.selfRemovalAuditLog);
      assert.equal(write.metadata.leaveOperations, metadata.leaveOperations);
      const joined = [...write.participants, ...write.waitlist].find((p) => p.id === rejoinPlayer.id);
      assert.equal(joined?.membershipId, rejoinPlayer.membershipId);
      assert.equal(joined?.status, hasSlot ? "CONFIRMED" : "WAITLIST");
      const response = (write.metadata.joinResponses as Record<string, { status: string; membershipId: string }>)[rejoinPlayer.phone!];
      assert.equal(response.status, hasSlot ? "JOINED" : "WAITLIST");
      assert.equal(response.membershipId, rejoinPlayer.membershipId);
      assert.equal(metadata.leaveEvents.length, 2, "input snapshot must stay unchanged");
      if (route === "invite") assert.equal(write.expectedUpdatedAt, "fixture-version");
      const promoted = hasSlot ? write.participants : [...participants.slice(0, 3), joined!];
      assert.equal(rosterSync(promoted, write.metadata, participants.slice(0, 3)).mergedCandidates.length, 4);
    });
  }
}
