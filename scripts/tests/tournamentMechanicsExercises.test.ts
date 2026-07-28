import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTournamentMechanicsFallbackExercises,
  mergeTournamentMechanicsExercises,
} from "../../src/utils/tournamentMechanicsExercises.ts";
import type { Exercise } from "../../src/utils/apiClient.ts";
import type { TournamentSignupSummary } from "../../src/utils/tournamentSignupApi.ts";

function makeSummary(overrides: Partial<TournamentSignupSummary> = {}): TournamentSignupSummary {
  return {
    id: "mongo_tournament_1",
    exerciseId: "92051094-9db6-4cfd-a400-b9ad360d0a4b",
    title: "Падел завтрак",
    startsAt: "2026-06-07T11:00:00+03:00",
    endsAt: "2026-06-07T13:00:00+03:00",
    date: "2026-06-07",
    timeLabel: "11:00-13:00",
    studioName: "Сириус",
    address: "Сириус, Олимпийский пр-кт, 2Б",
    format: "Американо",
    levelLabel: null,
    priceLabel: null,
    participantsCount: 8,
    maxParticipants: 16,
    waitlistCount: 0,
    status: "AVAILABLE",
    trainerName: "Иван Турнирный",
    trainerAvatarUrl: null,
    publicUrl: "/tournaments?tournamentId=mongo_tournament_1",
    storedPricingPreview: null,
    storedHasFriendlySubscriptionTag: false,
    storedSummerSubscriptionOffer: null,
    raw: {
      id: "mongo_tournament_1",
      sourceTournamentId: "92051094-9db6-4cfd-a400-b9ad360d0a4b",
      directionId: 4769,
      executor: {
        id: "trainer-42",
        firstName: "Иван",
        lastName: "Турнирный",
      },
      studio: {
        id: "233c1405-1eac-40de-8ec6-1cf7e24c9276",
        name: "Сириус",
        city: "Сочи",
        address: "Олимпийский пр-кт, 2Б",
      },
      room: {
        id: "court-1",
        name: "Корт 1",
      },
    },
    ...overrides,
  };
}

function makePrimaryExercise(): Exercise {
  return {
    id: "92051094-9db6-4cfd-a400-b9ad360d0a4b",
    direction: { id: 4769, name: "Падел завтрак" },
    type: { id: 4769, name: "Падел завтрак", color: "#000", format: "TOURNAMENT" },
    timeFrom: "2026-06-07T11:05:00+03:00",
    timeTo: "2026-06-07T13:05:00+03:00",
    clientsCount: 10,
    maxClientsCount: 16,
    girlsOnly: false,
    studio: {
      id: "233c1405-1eac-40de-8ec6-1cf7e24c9276",
      name: "Сириус из Viva",
      country: "Россия",
      city: "Сочи",
      address: "Олимпийский пр-кт, 2Б",
    },
    room: {
      id: "court-1",
      name: "Корт 1",
    },
    trainers: [],
  };
}

test("builds fallback exercises on exerciseId and preserves local tournament id as alias", () => {
  const [exercise] = buildTournamentMechanicsFallbackExercises([makeSummary()]);
  const extra = exercise as Exercise & Record<string, unknown>;

  assert.equal(exercise.id, "92051094-9db6-4cfd-a400-b9ad360d0a4b");
  assert.equal(extra.tournamentId, "mongo_tournament_1");
  assert.equal(exercise.trainers[0]?.id, "trainer-42");
  assert.equal(exercise.studio.name, "Сириус");
});

test("merge keeps fallback-only tournaments for the requested date", () => {
  const fallback = buildTournamentMechanicsFallbackExercises([makeSummary()]);
  const merged = mergeTournamentMechanicsExercises([], fallback, "2026-06-07");

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "92051094-9db6-4cfd-a400-b9ad360d0a4b");
});

test("merge prefers Viva exercise payload when both sources contain the same exerciseId", () => {
  const fallback = buildTournamentMechanicsFallbackExercises([makeSummary()]);
  const merged = mergeTournamentMechanicsExercises([makePrimaryExercise()], fallback, "2026-06-07");
  const extra = merged[0] as Exercise & Record<string, unknown>;

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.studio.name, "Сириус из Viva");
  assert.equal(merged[0]?.clientsCount, 10);
  assert.equal(merged[0]?.trainers[0]?.id, "trainer-42");
  assert.equal(extra.tournamentId, "mongo_tournament_1");
});
