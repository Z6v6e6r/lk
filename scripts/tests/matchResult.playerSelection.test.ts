import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const ast = ts.createSourceFile("GamesPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(name: string): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) result = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, `Missing ${name}`);
  return result;
}
function callback(name: string) {
  const node = findNode(name) as ts.VariableDeclaration;
  return (node.initializer as ts.CallExpression).arguments[0].getText(ast);
}
function runtime(code: string, context: Record<string, unknown> = {}) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(context), js)(...Object.values(context));
}
const player = (id: string) => ({ id, name: id, memberKey: `id:${id}` });
const players = [player("p1"), player("p2"), player("p3"), player("organizer")];
const key = (p: any) => p?.memberKey || (p?.id ? `id:${p.id}` : "");
const helpers = {
  DETAILS_TEAM_SLOTS_COUNT: 4,
  getPadelPlayerIdentityKey: key,
  cloneTeamSlots: (slots: any[]) => Array.from({ length: 4 }, (_, i) => slots[i] ?? null),
};
const replace = runtime(`${findNode("replaceMatchResultTeamSlot").getText(ast)}; return replaceMatchResultTeamSlot;`, helpers);
const sameSlots = (left: any[], right: any[]) => left.every((p, i) => key(p) === key(right[i]));
const replacePairings = runtime(`${findNode("replaceMatchResultStartingPairings").getText(ast)}; return replaceMatchResultStartingPairings;`, { ...helpers, areTeamSlotsEqualByIdentity: sameSlots });


function menuContext(overrides = {}) {
  return {
    detailsTeamMenuSlotIndex: 1, detailsActiveTab: "result", canEditMatchResultTeamsInDetails: true,
    detailsMatchResultSession: { rosterSnapshot: { members: players } },
    extractMatchResultSnapshotPlayers: (s: any) => s?.members || [],
    dedupePlayersByIdentity: (ps: any[]) => [...new Map(ps.map(p => [key(p), p])).values()],
    detailsSourceParticipants: players, detailsParticipants: players.slice(0, 3), detailsWaitlist: [], detailsPlayerPool: [],
    getPadelPlayerIdentityKey: key, detailsOrganizerInMatch: false, detailsOrganizerKey: "id:organizer",
    detailsOrganizerPlayer: players[3], detailsHasFreeSlots: true,
    detailsTeamSlotKeys: ["id:p1", null, "id:p2", "id:p3"], ...overrides,
  };
}

test("result picker includes the actual participating organizer despite organizerInMatch=false", () => {
  for (let slot = 0; slot < 4; slot++) {
    const options = runtime(`return (${callback("detailsTeamMenuOptions")})();`, menuContext({ detailsTeamMenuSlotIndex: slot }));
    assert.deepEqual(options.map(key), players.map(key));
  }
});

test("result picker respects the authoritative session roster instead of arbitrary metadata pool", () => {
  const options = runtime(`return (${callback("detailsTeamMenuOptions")})();`, menuContext({ detailsPlayerPool: [player("outsider")] }));
  assert.equal(options.some((p: any) => p.id === "outsider"), false);
});

test("duplicate legacy slots can be filled and occupied result positions swap without dropping players", () => {
  const broken = [players[0], null, players[1], players[2]];
  const fixed = replace(broken, 1, players[3]);
  assert.deepEqual(fixed.map(key), ["id:p1", "id:organizer", "id:p2", "id:p3"]);
  assert.equal(broken[1], null, "input is immutable");
  const swapped = replace(fixed, 0, players[1]);
  assert.deepEqual(swapped.map(key), ["id:p2", "id:organizer", "id:p1", "id:p3"]);
  assert.equal(new Set(swapped.map(key)).size, 4);
  assert.equal(replace(fixed, 0, null)[0], null, "first slot is editable independently of organizer membership");
});

function pick(overrides: Record<string, unknown> = {}) {
  const state: any = { dirty: { current: false } };
  const initial = [players[0], null, players[1], players[2]];
  const context = {
    ...helpers, canEditMatchResultTeamsInDetails: true, updatingGameMeta: false,
    detailsTeamMenuOptions: players, detailsMatchResultSetPairings: [], detailsTeamSlots: initial,
    replaceMatchResultTeamSlot: replace, replaceMatchResultStartingPairings: replacePairings, areTeamSlotsEqualByIdentity: sameSlots, detailsMatchResultDraftDirtyRef: state.dirty,
    setDetailsMatchResultSetPairings: (p: any) => { state.pairings = p; },
    setDetailsTeamSlots: (p: any) => { state.slots = p; },
    setDetailsTeamMenuSlotIndex: (p: any) => { state.menu = p; },
    setGameDetailsMetaError: () => {},
    patchGameRoster: () => assert.fail("result selection must never PATCH roster"),
    saveDetailsMetadata: () => assert.fail("result selection must never PATCH booking metadata"),
    ...overrides,
  };
  const handler = runtime(`return ${callback("handleResultTeamSlotPick")};`, context);
  return { state, handler };
}

test("adding a result player changes only local draft pairings, even for a non-organizer", () => {
  const { state, handler } = pick();
  handler(1, players[3]);
  assert.deepEqual(state.pairings[0].map(key), ["id:p1", "id:organizer", "id:p2", "id:p3"]);
  assert.equal(state.dirty.current, true);
  assert.equal(state.menu, null);
});

test("editing the first set preserves an explicitly changed later lineup", () => {
  const later = [players[1], players[0], players[2], players[3]];
  const { state, handler } = pick({ detailsMatchResultSetPairings: [[players[0], null, players[1], players[2]], later] });
  handler(1, players[3]);
  assert.deepEqual(state.pairings[1], later);
  assert.equal(state.slots, undefined, "current later lineup stays intact");
});

test("read-only, saving and non-roster result selections are rejected", () => {
  for (const overrides of [{ canEditMatchResultTeamsInDetails: false }, { updatingGameMeta: true }, {}]) {
    const { state, handler } = pick(overrides);
    handler(1, Object.keys(overrides).length ? players[3] : player("outsider"));
    assert.equal(state.dirty.current, false);
    assert.equal(state.pairings, undefined);
  }
});

test("entering scores does not remove the starting-lineup repair controls", () => {
  const editable = findNode("isEditableStartPairing") as ts.VariableDeclaration;
  assert.equal(runtime(`return ${editable.initializer!.getText(ast)};`, { canEditMatchResult: true, index: 0, detailsCompletedMatchResultSets: [1, 2] }), true);
  assert.equal(runtime(`return ${editable.initializer!.getText(ast)};`, { canEditMatchResult: false, index: 0 }), false);
  const resultPicker = source.slice(source.indexOf('{isEditableStartPairing && detailsTeamMenuSlotIndex'));
  assert.match(resultPicker, /handleResultTeamSlotPick\(detailsTeamMenuSlotIndex, player\)/);
});


test("repair propagates through restored inherited sets and stops at a distinct later lineup", () => {
  const start = [players[0], null, players[1], players[2]];
  const later = [players[0], players[1], players[2], players[3]];
  const { state, handler } = pick({ detailsMatchResultSetPairings: [start, [...start], later, [...later]] });
  handler(1, players[3]);
  assert.deepEqual(state.pairings[0].map(key), ["id:p1", "id:organizer", "id:p2", "id:p3"]);
  assert.deepEqual(state.pairings[1], state.pairings[0]);
  assert.deepEqual(state.pairings[2], later);
  assert.deepEqual(state.pairings[3], later);
});

test("actual participant can enter a result when excluded by the organizer UI flag", () => {
  const node = findNode("isCurrentUserResultParticipant") as ts.VariableDeclaration;
  const eligible = (roster: any[]) => runtime(`return ${node.initializer!.getText(ast)};`, {
    isCurrentUserConfirmedParticipant: false, detailsSourceParticipants: roster,
    isCurrentUserPlayer: (p: any) => p.id === "organizer",
  });
  assert.equal(eligible(players), true);
  assert.equal(eligible(players.slice(0, 3)), false);
  assert.equal(eligible([{ ...players[3], status: "PENDING" }]), false);
});
