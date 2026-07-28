import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  RATING_LEDGER_INDEXES,
  buildInitialImportMutation,
  findDuplicateIdentities,
} from "../migrate_player_rating_ledger.mjs";
import {
  compatibilityProjectionNeedsReconciliation,
  resolveTournamentRevisionCanonicalBefore,
  selectCompatibilityProjectionTarget,
} from "../rating_worker.mjs";

test("compatibility projection updates the existing client row when the phone changed", () => {
  const target = selectCompatibilityProjectionTarget([{
    _id: "compat-client",
    clientId: "client-1",
    phoneNorm: "79000000001",
  }], {
    playerKey: "client:client-1",
    clientId: "client-1",
    phoneNorm: "79000000002",
  });

  assert.deepEqual(target.filter, { _id: "compat-client" });
});

test("compatibility projection promotes a phone-only row instead of inserting a duplicate phone", () => {
  const target = selectCompatibilityProjectionTarget([{
    _id: "compat-phone",
    clientId: null,
    phoneNorm: "79000000001",
  }], {
    playerKey: "client:client-1",
    clientId: "client-1",
    phoneNorm: "79000000001",
  });

  assert.deepEqual(target.filter, { _id: "compat-phone" });
});

test("compatibility projection rejects conflicting client and phone rows", () => {
  assert.throws(() => selectCompatibilityProjectionTarget([
    { _id: "compat-client", clientId: "client-1", phoneNorm: "79000000001" },
    { _id: "compat-phone", clientId: "client-2", phoneNorm: "79000000002" },
  ], {
    playerKey: "client:client-1",
    clientId: "client-1",
    phoneNorm: "79000000002",
  }), (error) => error?.code === "PLAYER_RATING_COMPATIBILITY_IDENTITY_CONFLICT");
});

test("full reconciliation detects historical client and player key drift", () => {
  assert.equal(compatibilityProjectionNeedsReconciliation({
    playerKey: "client:client-1",
    clientId: "client-1",
    phoneNorm: "79000000001",
    ratingNumeric: 3.25,
    rating: "C",
    lastEventId: "event-1",
  }, {
    playerKey: "phone:79000000001",
    clientId: null,
    phoneNorm: "79000000001",
    ratingNumeric: 3.25,
    rating: "C",
    lastEventId: "event-1",
  }), true);
});

test("full reconciliation ignores an already synchronized projection", () => {
  const state = {
    playerKey: "client:client-1",
    clientId: "client-1",
    phoneNorm: "79000000001",
    ratingNumeric: 3.25,
    rating: "C",
    lastEventId: "event-1",
  };
  assert.equal(compatibilityProjectionNeedsReconciliation(state, { ...state }), false);
});

test("tournament correction keeps the canonical baseline from the event it replaces", () => {
  const first = {
    id: "first",
    change: {
      before: 1.83677,
      after: 1.88275,
    },
    source: {},
  };
  const brokenCorrection = {
    id: "broken-correction",
    change: {
      before: 1.88275,
      after: 1.88275,
    },
    source: {
      supersedesEventId: "first",
    },
  };

  assert.equal(resolveTournamentRevisionCanonicalBefore(
    brokenCorrection,
    1.88275,
    [first, brokenCorrection],
  ), 1.83677);
  assert.equal(resolveTournamentRevisionCanonicalBefore(first, 1.88275), 1.83677);
  assert.equal(resolveTournamentRevisionCanonicalBefore(null, 1.83677), 1.83677);
});

test("tournament worker does not use document updatedAt as the rating event revision", () => {
  const worker = fs.readFileSync("scripts/rating_worker.mjs", "utf8");

  assert.match(worker, /finishedAt,\n {8}standing,/);
  assert.doesNotMatch(worker, /finishedAt: active \? changedAt : finishedAt/);
  assert.match(worker, /const sourceRevision = buildTournamentRatingRevision/);
  assert.match(worker, /resolveCanonicalRatingBefore\([\s\S]*identity,[\s\S]*finishedAt,[\s\S]*newEvents,/);
  assert.match(worker, /active\?\.source\?\.sourceRevision === sourceRevision\) continue;[\s\S]*resolveCanonicalRatingBefore/);
  assert.match(worker, /resolveTournamentRevisionCanonicalBefore\([\s\S]*active,[\s\S]*resolvedCanonicalBefore,[\s\S]*allTournamentEvents,/);
  assert.match(worker, /canonicalBefore,/);
  assert.match(worker, /lastStatus: "SUCCEEDED",[\s\S]*lastError: null,/);
  assert.match(worker, /for \(const startChange of asArray\(tournament\.startRatingChanges\)\)/);
  assert.match(worker, /buildTournamentStartOverrideEvent/);
  assert.match(worker, /\["TOURNAMENT", "TOURNAMENT_START"\]\.includes\(lastEvent\?\.source\?\.domain\)/);

  const wrapper = fs.readFileSync("scripts/run_rating_worker_147.mjs", "utf8");
  assert.match(wrapper, /VIVA_ATTENDANCE_SYNC_FAILED/);
  assert.match(wrapper, /continuing canonical rating run/);
  assert.match(wrapper, /const worker = runNode\(/);
});

test("initial import creates immutable event without overwriting the current rating", () => {
  const mutation = buildInitialImportMutation({
    _id: "legacy-1",
    id: "client-1",
    phoneNorm: "+7 (900) 000-00-01",
    name: "Игрок 1",
    ratingNumeric: 3.25,
    rating: "C",
    updatedAt: "2026-07-09T20:00:00.000Z",
  }, "2026-07-10T09:00:00.000Z") as any;

  assert.equal(mutation.skipped, false);
  assert.equal(mutation.playerKey, "client:client-1");
  assert.equal(mutation.eventOperation.updateOne.update.$setOnInsert.eventType, "RATING_INITIAL_IMPORTED");
  assert.equal(mutation.eventOperation.updateOne.update.$setOnInsert.change.after, 3.25);
  assert.equal(mutation.stateOperation.updateOne.filter.lastEventId.$exists, false);
  assert.equal("ratingNumeric" in mutation.stateOperation.updateOne.update.$set, false);
  assert.equal("rating" in mutation.stateOperation.updateOne.update.$set, false);
});

test("initial import is deterministic and maps a legacy grade when numeric value is absent", () => {
  const row = { _id: "legacy-2", phoneNorm: "79000000002", rating: "B+" };
  const first = buildInitialImportMutation(row, "2026-07-10T09:00:00.000Z") as any;
  const second = buildInitialImportMutation(row, "2026-07-11T09:00:00.000Z") as any;

  assert.equal(first.eventOperation.updateOne.filter._id, second.eventOperation.updateOne.filter._id);
  assert.equal(first.eventOperation.updateOne.update.$setOnInsert.change.after, 5);
  assert.equal(first.playerKey, "phone:79000000002");
});

test("initial import event ids preserve distinct player identity characters", () => {
  const colon = buildInitialImportMutation({ id: "client:A:B", ratingNumeric: 3 }) as any;
  const underscore = buildInitialImportMutation({ id: "client:A_B", ratingNumeric: 3 }) as any;

  assert.notEqual(
    colon.eventOperation.updateOne.filter._id,
    underscore.eventOperation.updateOne.filter._id,
  );
});

test("migration detects duplicate phone and client identities before unique indexes", () => {
  const duplicates = findDuplicateIdentities([
    { id: "client-1", phoneNorm: "79000000001", ratingNumeric: 3 },
    { id: "client-1", phoneNorm: "79000000002", ratingNumeric: 3.1 },
    { id: "client-3", phoneNorm: "79000000001", ratingNumeric: 3.2 },
  ]);

  assert.deepEqual(duplicates, [
    { kind: "phoneNorm", value: "79000000001", count: 2 },
    { kind: "clientId", value: "client-1", count: 2 },
  ]);
  assert.equal(RATING_LEDGER_INDEXES.ratingEvents[0].options.unique, true);
  assert.equal(RATING_LEDGER_INDEXES.playerRatings.every((item) => item.options.unique), true);
});

test("migration skips rows that have neither identity nor usable rating", () => {
  assert.equal((buildInitialImportMutation({ ratingNumeric: 3 }) as any).reason, "MISSING_PLAYER_IDENTITY");
  assert.equal((buildInitialImportMutation({ phoneNorm: "79000000001" }) as any).reason, "MISSING_RATING");
});
