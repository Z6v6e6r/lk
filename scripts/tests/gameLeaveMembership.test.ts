import test from "node:test";
import { observeGameLeave } from "../../src/components/games/observeGameLeave.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import {
  findActiveSplitPaymentForLeave,
  hasActiveGameLeaveMembership,
} from "../../src/components/games/gameLeaveMembership.ts";

const actor = { id: "fixture-player", phone: "70000000001" };
const payment = { clientId: actor.id, phoneNorm: actor.phone, status: "WAITLIST", paymentRef: "fixture-join" };
const game = (payments: unknown[] = [payment]) => ({
  participants: [{ id: "fixture-organizer", status: "CONFIRMED" }],
  waitlist: [],
  metadata: { splitPayment: { payments } },
});

test("orphan WAITLIST remains a leave target and blocks a false exit even after its deadline", () => {
  const expiredWaitlist = { ...payment, deadlineAt: "2020-01-01T00:00:00Z" };
  assert.equal(findActiveSplitPaymentForLeave([expiredWaitlist], actor), expiredWaitlist);
  assert.equal(hasActiveGameLeaveMembership(game([expiredWaitlist]), actor), true);
});

test("active payment states block exit confirmation regardless of roster absence", () => {
  for (const status of ["WAITLIST", "RESERVE", "PAYMENT_PENDING", "PAID", "", "UNKNOWN"]) {
    assert.equal(hasActiveGameLeaveMembership(game([{ ...payment, status }]), actor), true, status);
  }
});

test("completed leave and terminal payments no longer keep the player active", () => {
  for (const status of ["LEFT", "CANCELLED", "REFUNDED", "EXPIRED", "REMOVED", "DECLINED"]) {
    assert.equal(hasActiveGameLeaveMembership(game([{ ...payment, status }]), actor), false, status);
    assert.equal(findActiveSplitPaymentForLeave([{ ...payment, status }], actor), null);
  }
});

test("same phone cannot make another client's payment or roster a leave target", () => {
  const other = { ...payment, clientId: "fixture-other" };
  assert.equal(findActiveSplitPaymentForLeave([other], actor), null);
  assert.equal(hasActiveGameLeaveMembership({ participants: [{ id: "fixture-other", phone: actor.phone }] }, actor), false);
});

test("server identity aliases and legacy phone-only membership are supported", () => {
  for (const key of ["clientId", "playerId", "userId", "id"]) {
    assert.ok(findActiveSplitPaymentForLeave([{ [key]: " FIXTURE-PLAYER ", status: "WAITLIST" }], actor));
  }
  assert.ok(findActiveSplitPaymentForLeave([{ mobile: `+${actor.phone}`, status: "WAITLIST" }], actor));
  assert.equal(hasActiveGameLeaveMembership(game(), {}), false);
});

test("all active roster representations must disappear before exit succeeds", () => {
  assert.equal(hasActiveGameLeaveMembership({ participants: [{ id: actor.id, status: "CONFIRMED" }] }, actor), true);
  assert.equal(hasActiveGameLeaveMembership({ waitlist: [{ id: actor.id, status: "WAITLIST" }] }, actor), true);
  assert.equal(hasActiveGameLeaveMembership({ waitlist: [{ id: actor.id, status: "LEFT" }] }, actor), false);
  assert.equal(hasActiveGameLeaveMembership({ metadata: null }, actor), false);
});

test("a new join remains active after an earlier leave of the same player", () => {
  assert.equal(hasActiveGameLeaveMembership(game([
    { ...payment, status: "LEFT", paymentRef: "fixture-old-join" },
    { ...payment, paymentRef: "fixture-new-join" },
  ]), actor), true);
});

test("server leave clears WAITLIST everywhere while preserving the payment audit and another player", () => {
  const other = { ...payment, clientId: "fixture-other", phoneNorm: "70000000002", paymentRef: "fixture-other-join" };
  const sourceGame = {
    ...game([payment, other]), id: "fixture-game", updatedAt: "2026-01-01T00:00:00Z",
    waitlist: [{ id: actor.id, phone: actor.phone, status: "WAITLIST" }],
    invitedPhones: [actor.phone],
  };
  const msg = { _splitLeaveCtx: {
    game: sourceGame, gameId: sourceGame.id, targetClientId: actor.id, targetPhoneNorm: actor.phone,
    operationId: "fixture-leave", mode: "SELF", vivaVerification: "active_absent_history_cancelled",
    subscriptionReturnState: "RETURN_PENDING",
  } };
  const run = new Function("msg", fs.readFileSync("scripts/nodered_games_nodes/fn_split_leave_game_update.js", "utf8"));
  const [updated] = run(msg);
  const [query, update] = updated.payload;
  const after = update.$set;
  assert.equal(query.updatedAt, sourceGame.updatedAt, "keep CAS concurrency protection");
  assert.equal(hasActiveGameLeaveMembership(after, actor), false);
  assert.equal(hasActiveGameLeaveMembership(after, { id: other.clientId }), true);
  assert.deepEqual(after.waitlist, []);
  assert.equal(after.waitlistPhones.includes(actor.phone), false);
  assert.equal(after.invitedPhones.includes(actor.phone), false);
  assert.equal(after.allRelatedPhones.includes(actor.phone), false);
  const removedPayment = after.metadata.splitPayment.payments[0];
  assert.equal(removedPayment.status, "LEFT");
  assert.equal(removedPayment.paymentRef, payment.paymentRef);
  assert.equal(removedPayment.leaveOperationId, "fixture-leave");
  assert.ok(removedPayment.leftAt);
  assert.equal(after.metadata.leaveOperations[0].state, "RETURN_PENDING", "leave does not claim refund completion");
  assert.equal(sourceGame.metadata.splitPayment.payments[0].status, "WAITLIST", "preimage remains intact");
});

// Execute the real callback with in-memory API/state boundaries. No server calls.
const page = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const handlerStart = page.indexOf("async () => {", page.indexOf("const handleLeaveCurrentUserFromDetails"));
const handlerEnd = page.indexOf("\n  }, [", handlerStart);
assert.ok(handlerStart > 0 && handlerEnd > handlerStart);
const callback = ts.transpileModule(`(${page.slice(handlerStart, handlerEnd + 4)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function leaveScenario(state: string, freshGame: unknown, refreshError: unknown = null, failure: number | "throw" | null = null) {
  const calls = { updating: [] as boolean[], requests: 0, refreshes: 0, navigations: 0, notices: [] as string[], errors: [] as unknown[] };
  const noop = () => {};
  const scope = {
    subscriptionUsageShadowEnabled: false, canCurrentUserLeaveGameInDetails: true, gameRecordId: "fixture-game",
    detailsParticipants: [], detailsWaitlist: [], detailsCurrentUserLeavePayment: payment,
    profileId: actor.id, profileName: "Fixture", profilePhoneNorm: actor.phone, profilePhone: actor.phone,
    profilePhoto: null, profileGrade: null, profileRatingNumeric: null,
    isCurrentUserPlayer: (row: { id: string }) => row.id === actor.id,
    isDetailsOrganizerPlayer: () => false, isSelfLeavePreviewMode: false, selfLeaveAttemptRef: { current: 0 },
    setUpdatingGameRoster: (value: boolean) => calls.updating.push(value), setGameRosterError: (error: unknown) => calls.errors.push(error), setLeavePendingMessage: noop,
    SELF_REMOVE_START_NOTICE: "starting", SELF_REMOVE_PENDING_NOTICE: "pending", SELF_REMOVE_SUCCESS_NOTICE: "left",
    leavePendingMessage: null, selfLeavePostInFlightRef: { current: false },
    selfLeaveObservationRef: { current: null }, observeGameLeave: () => new Promise(() => {}),
    leaveCurrentUserRequest: async () => {
      calls.requests++;
      if (failure === "throw") throw new Error("offline");
      return failure === null ? { data: { state }, error: null }
        : { data: null, error: { status: failure, message: "unavailable" }, status: failure };
    },
    apiFetchPadelGameRecord: async () => { calls.refreshes++; return { data: freshGame, error: refreshError }; },
    upsertGameRecordInStores: noop, hasActiveGameLeaveMembership,
    navigateToCabinetFromGamesDetails: () => { calls.navigations++; return true; },
    pushCabinetFlashNotice: (message: string) => calls.notices.push(message), onBack: noop,
  };
  const execute = new Function("scope", `with (scope) { return ${callback}; }`)(scope);
  await execute();
  return calls;
}

for (const state of ["DONE", "RETURN_PENDING"]) {
  test(`${state} cannot announce exit while refreshed split WAITLIST remains`, async () => {
    const calls = await leaveScenario(state, { ...game(), id: "fixture-game" });
    assert.equal(calls.requests, 1, "orphan WAITLIST invokes authenticated server leave");
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.navigations, 0);
    assert.deepEqual(calls.notices, []);
    assert.ok(calls.errors.at(-1));
  });
}

test("completed server cleanup navigates only after WAITLIST becomes LEFT", async () => {
  const calls = await leaveScenario("DONE", { ...game([{ ...payment, status: "LEFT" }]), id: "fixture-game" });
  assert.equal(calls.navigations, 1);
  assert.deepEqual(calls.notices, ["left"]);
});

test("pending refund does not retain membership or claim the refund was completed", async () => {
  const calls = await leaveScenario("RETURN_PENDING", { ...game([]), id: "fixture-game" });
  assert.equal(calls.navigations, 1);
  assert.match(calls.notices[0], /Возврат посещения проверяется/);
});

test("read failure or a different game cannot confirm an exit", async () => {
  for (const [data, error] of [[null, { message: "offline" }], [{ ...game([]), id: "fixture-other-game" }, null]]) {
    const calls = await leaveScenario("DONE", data, error);
    assert.equal(calls.navigations, 0);
    assert.deepEqual(calls.notices, []);
  }
});

test("orphan leave action is rendered separately from payment checkout", () => {
  assert.match(page, /detailsCurrentUserLeavePayment \? \(\s*<button[\s\S]*?handleLeaveCurrentUserFromDetails\(\)/);
});


test("numeric provider IDs follow the same strong identity rule", () => {
  assert.ok(findActiveSplitPaymentForLeave([{ clientId: 42, status: "WAITLIST" }], { id: "42" }));
  assert.equal(findActiveSplitPaymentForLeave([{ clientId: 43, phone: actor.phone, status: "WAITLIST" }],
    { id: "42", phone: actor.phone }), null);
});

test("leave cannot race the current page's unfinished split join", () => {
  const start = page.indexOf("const canCurrentUserLeaveGameInDetails = Boolean(");
  const end = page.indexOf("const detailsTeamSlotKeys", start);
  assert.match(page.slice(start, end), /&& !joiningSplitPayment/);
});


test("pending leave returns after one POST without blocking on another write or read", async () => {
  const calls = await leaveScenario("RETRY_REQUIRED", { ...game(), id: "fixture-game" });
  assert.equal(calls.requests, 1);
  assert.equal(calls.refreshes, 0);
  assert.deepEqual(calls.updating, [true, false], "GET observation never holds the roster lock");
  assert.equal(calls.navigations, 0);
  assert.deepEqual(calls.notices, []);
});

const observerActor = { id: "fixture-client" };
const observedRecord = (status: string) => ({ id: "fixture-game", participants: [], waitlist: [],
  metadata: { splitPayment: { payments: [{ clientId: observerActor.id, status }] } } });

test("read-only observation waits for split payment membership as well as roster", async () => {
  const states = ["WAITLIST", "PAYMENT_PENDING", "LEFT"];
  const observed: string[] = [];
  const result = await observeGameLeave({ gameId: "fixture-game", identity: observerActor,
    signal: new AbortController().signal, intervalMs: 0, attempts: 3,
    read: async () => ({ data: observedRecord(states.shift()!), error: null }),
    onRecord: data => observed.push(data.metadata.splitPayment.payments[0].status),
  });
  assert.equal(result, "complete");
  assert.deepEqual(observed, ["WAITLIST", "PAYMENT_PENDING", "LEFT"]);
});

test("errors, wrong game and thrown reads cannot confirm exit; observation is bounded", async () => {
  let reads = 0;
  const result = await observeGameLeave({ gameId: "fixture-game", identity: observerActor,
    signal: new AbortController().signal, intervalMs: 0, attempts: 3,
    read: async () => {
      reads++;
      if (reads === 1) throw new Error("offline");
      return reads === 2 ? { data: observedRecord("LEFT"), error: "unavailable" }
        : { data: { ...observedRecord("LEFT"), id: "another-game" }, error: null };
    }, onRecord: () => assert.fail("no valid read"),
  });
  assert.equal(result, "unconfirmed");
  assert.equal(reads, 3);
});

test("unmount or game switch cancels stale read without updating stores", async () => {
  const controller = new AbortController();
  const result = await observeGameLeave({ gameId: "fixture-game", identity: observerActor,
    signal: controller.signal,
    read: async () => { controller.abort(); return { data: observedRecord("LEFT"), error: null }; },
    onRecord: () => assert.fail("cancelled result cannot update UI"),
  });
  assert.equal(result, "cancelled");
});

test("cancelling during delay stops the next GET immediately", async () => {
  const controller = new AbortController();
  let reads = 0;
  const result = await observeGameLeave({ gameId: "fixture-game", identity: observerActor,
    signal: controller.signal, intervalMs: 60_000,
    read: async () => { reads++; setTimeout(() => controller.abort(), 0); return { data: observedRecord("WAITLIST"), error: null }; },
    onRecord: () => {},
  });
  assert.equal(result, "cancelled");
  assert.equal(reads, 1);
});


test("network failures and permission errors unlock without POST retries or false success", async () => {
  for (const failure of ["throw", 0, 403, 408, 429, 500] as const) {
    const calls = await leaveScenario("RETRY_REQUIRED", null, null, failure);
    assert.equal(calls.requests, 1);
    assert.equal(calls.refreshes, 0);
    assert.deepEqual(calls.updating, [true, false]);
    assert.deepEqual(calls.notices, []);
    assert.equal(calls.navigations, 0);
    assert.ok(calls.errors.at(-1));
  }
});
