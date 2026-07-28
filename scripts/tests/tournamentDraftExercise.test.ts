import test from "node:test";
import assert from "node:assert/strict";
import { buildTournamentDraftExercise } from "../../src/utils/tournamentDraftExercise.ts";

test("local tournament draft becomes a visible exercise with station and organizer metadata", () => {
  const exercise = buildTournamentDraftExercise({
    payload: {
      tournamentId: "manual-1",
      tenantKey: "tenant-1",
      createdAt: "2026-06-06T12:34:00.000Z",
      organizer: {
        id: "org-1",
        phone: "+79990000001",
        tenantKey: "tenant-1",
      },
      tournamentType: "americano_padelhub",
      targetScore: 21,
      courts: ["Корт 1", "Корт 2"],
      participants: [
        {
          id: "p-1",
          phone: "+79990000002",
          rating: "4.5",
          photo: null,
          name: "Игрок 1",
        },
      ],
      params: {
        manualTournament: true,
        localStatus: "conducted_local",
        syncStatus: "pending_viva",
        localDateKey: "2026-06-07",
        stationName: "Ск ПхАБ",
        organizerName: "Иван Петров",
      },
      rounds: [],
    },
    totals: null,
    playerLogs: null,
    updatedAt: "2026-06-06T13:00:00.000Z",
  }, {
    currentProfileId: "profile-1",
  });

  assert.ok(exercise);
  assert.equal(exercise?.id, "manual-1");
  assert.equal(exercise?.studio.name, "Ск ПхАБ");
  assert.equal(exercise?.room.name, "Корт 1");
  assert.equal(exercise?.trainers?.[0]?.id, "org-1");
  assert.equal(exercise?.trainers?.[0]?.firstName, "Иван");
  assert.equal(exercise?.trainers?.[0]?.lastName, "Петров");
  assert.equal(exercise?.status, "COMPLETED");
  assert.equal(exercise?.state, "COMPLETED");
  assert.match(exercise?.timeFrom ?? "", /^2026-06-07T\d{2}:\d{2}:00\+03:00$/);
});
