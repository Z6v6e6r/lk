import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrainingVisitBulkPlan,
  buildTrainingVisitRecordsFromExercises,
  buildVivaPublicExercisesUrl,
  enumerateDates,
} from "../sync_training_visits_from_viva.mjs";

const syncedAt = "2026-07-07T13:00:00.000Z";

test("builds current-state training visit records only for confirmed past group bookings", () => {
  const result = buildTrainingVisitRecordsFromExercises([
    {
      id: "exercise-1",
      type: { id: 605, name: "Group training" },
      direction: { id: 1001, name: "Padel training" },
      studio: { id: "0d5504f6-ea6f-44bb-a9e4-947faf0273ab", name: "Nagatinskaya" },
      room: { id: "court-1", name: "Court 1" },
      timeFrom: "2026-07-07T10:00:00.000Z",
      timeTo: "2026-07-07T12:00:00.000Z",
      bookings: [
        {
          id: "booking-1",
          visitConfirmed: true,
          client: {
            id: "client-1",
            firstName: "Anna",
            lastName: "Ivanova",
            phone: "+7 (900) 000-00-01",
          },
        },
        {
          id: "booking-1-duplicate",
          visitConfirmed: true,
          client: {
            id: "client-1",
            firstName: "Anna",
            lastName: "Ivanova",
            phone: "+7 (900) 000-00-01",
          },
        },
        {
          id: "booking-2",
          visitConfirmed: false,
          client: {
            id: "client-2",
            phone: "+7 (900) 000-00-02",
          },
        },
        {
          id: "booking-3",
          visitConfirmed: true,
          status: "CANCELLED",
          client: {
            id: "client-3",
            phone: "+7 (900) 000-00-03",
          },
        },
        {
          id: "booking-4",
          status: "ATTENDED",
          client: {
            phone: "8 900 000 00 04",
            displayName: "Phone Only",
          },
        },
      ],
    },
    {
      id: "exercise-future",
      type: { id: 847, name: "Game plus trainer" },
      studio: { id: "0d5504f6-ea6f-44bb-a9e4-947faf0273ab" },
      timeFrom: "2026-07-07T14:00:00.000Z",
      timeTo: "2026-07-07T15:00:00.000Z",
      bookings: [
        {
          id: "booking-future",
          visitConfirmed: true,
          client: {
            id: "client-future",
            phone: "+7 (900) 000-00-05",
          },
        },
      ],
    },
    {
      id: "tournament-1",
      type: { id: 839, name: "Tournament" },
      studio: { id: "0d5504f6-ea6f-44bb-a9e4-947faf0273ab" },
      timeFrom: "2026-07-07T10:00:00.000Z",
      timeTo: "2026-07-07T12:00:00.000Z",
      bookings: [
        {
          id: "booking-tournament",
          visitConfirmed: true,
          client: {
            id: "client-tournament",
            phone: "+7 (900) 000-00-06",
          },
        },
      ],
    },
  ], { syncedAt });

  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.id).sort(), [
    "viva:exercise-1:client:client-1",
    "viva:exercise-1:phone:79000000004",
  ]);
  assert.deepEqual(result.scannedExerciseIds.sort(), ["exercise-1", "exercise-future"]);
  assert.equal(result.stats.eligibleExercises, 2);
  assert.equal(result.stats.confirmedBookings, 3);
  assert.equal(result.stats.deduplicatedBookings, 1);
  assert.equal(result.stats.futureBookings, 1);
  assert.equal(result.stats.skippedBookings, 3);

  const phoneOnly = result.records.find((record) => record.bookingId === "booking-4");
  assert.equal(phoneOnly?.phoneNorm, "79000000004");
  assert.equal(phoneOnly?.client?.phoneNorm, "79000000004");
  assert.equal(phoneOnly?.visitConfirmed, true);
  assert.equal(phoneOnly?.sourceKind, "group_training_visit");
});

test("builds idempotent upserts and archives stale rows for scanned exercises", () => {
  const records = buildTrainingVisitRecordsFromExercises([
    {
      id: "exercise-1",
      typeId: 605,
      studioId: "0d5504f6-ea6f-44bb-a9e4-947faf0273ab",
      timeFrom: "2026-07-07T10:00:00.000Z",
      timeTo: "2026-07-07T12:00:00.000Z",
      bookings: [
        {
          id: "booking-1",
          visitConfirmed: true,
          client: { id: "client-1", phone: "+7 900 000-00-01" },
        },
      ],
    },
  ], { syncedAt }).records;

  const plan = buildTrainingVisitBulkPlan({
    records,
    scannedExerciseIds: ["exercise-1"],
    archiveMissing: true,
    syncedAt,
  });

  assert.equal(plan.operations.length, 2);
  assert.deepEqual(plan.activeIds, ["viva:exercise-1:client:client-1"]);
  assert.deepEqual(plan.operations[0]?.updateOne?.filter, { id: "viva:exercise-1:client:client-1" });
  assert.equal(plan.operations[0]?.updateOne?.upsert, true);
  assert.deepEqual(plan.operations[1]?.updateMany?.filter, {
    source: "viva",
    sourceExerciseId: { $in: ["exercise-1"] },
    archived: { $ne: true },
    id: { $nin: ["viva:exercise-1:client:client-1"] },
  });
  assert.equal(plan.operations[1]?.updateMany?.update?.$set?.archived, true);
  assert.equal(plan.operations[1]?.updateMany?.update?.$set?.visitConfirmed, false);
});

test("enumerates explicit and ranged sync dates deterministically", () => {
  assert.deepEqual(enumerateDates({ dates: "2026-07-03,2026-07-01,2026-07-03" }), [
    "2026-07-01",
    "2026-07-03",
  ]);
  assert.deepEqual(enumerateDates({ dateFrom: "2026-07-01", dateTo: "2026-07-03" }), [
    "2026-07-01",
    "2026-07-02",
    "2026-07-03",
  ]);
  assert.deepEqual(enumerateDates({ dateFrom: "2026-07-03", dateTo: "2026-07-01" }), [
    "2026-07-01",
    "2026-07-02",
    "2026-07-03",
  ]);
});

test("builds public historical exercise URL with past flags", () => {
  const url = buildVivaPublicExercisesUrl({
    vivaPublicBase: "https://api.vivacrm.ru/end-user/api/v1/iSkq6G",
    date: "2026-07-06",
  });

  assert.equal(
    url,
    "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/exercises?date=2026-07-06&includePast=true&past=true",
  );
});
