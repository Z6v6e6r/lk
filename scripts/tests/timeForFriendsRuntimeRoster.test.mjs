import assert from "node:assert/strict";
import test from "node:test";
import { loadTimeForFriendsProviderEnrollment } from "../lib/timeForFriendsRuntimeRoster.mjs";

const EXERCISE_ID = "77777777-7777-4777-8777-777777777777";
const PLAYER_ID = "11111111-1111-4111-8111-111111111111";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(payload),
  };
}

test("provider runtime roster keeps exact Viva identity and active spot proof", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/end-user/")) {
      return response({
        id: EXERCISE_ID,
        direction: { id: 5278 },
        studio: { id: "station-a" },
        maxClientsCount: 8,
      });
    }
    return response([{
      id: "booking-id",
      spot: 4,
      isCancelled: false,
      client: { id: PLAYER_ID, firstName: "Тест", lastName: "Игрок" },
    }]);
  };
  const result = await loadTimeForFriendsProviderEnrollment({
    tournamentId: EXERCISE_ID,
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.exerciseId, EXERCISE_ID);
  assert.equal(result.directionId, "5278");
  assert.equal(result.stationId, "station-a");
  assert.equal(result.maxParticipants, 8);
  assert.deepEqual(result.participants, [{
    clientId: PLAYER_ID,
    name: "Тест Игрок",
    spot: 4,
    isCancelled: false,
  }]);
});

test("provider runtime roster fails closed on id conflict and missing capacity", async () => {
  await assert.rejects(
    loadTimeForFriendsProviderEnrollment({
      tournamentId: EXERCISE_ID,
      fetchImpl: async (url) => String(url).includes("/end-user/")
        ? response({
          id: "88888888-8888-4888-8888-888888888888",
          direction: { id: 5278 },
          studio: { id: "station-a" },
          maxClientsCount: 8,
        })
        : response([]),
    }),
    (error) => error?.code === "PROVIDER_EXERCISE_ID_CONFLICT",
  );

  await assert.rejects(
    loadTimeForFriendsProviderEnrollment({
      tournamentId: EXERCISE_ID,
      fetchImpl: async (url) => String(url).includes("/end-user/")
        ? response({ id: EXERCISE_ID, direction: { id: 5278 }, studio: { id: "station-a" } })
        : response([]),
    }),
    (error) => error?.code === "PROVIDER_CAPACITY_NOT_PROVEN",
  );
});

test("provider runtime roster does not invent active state when cancellation proof is absent", async () => {
  await assert.rejects(
    loadTimeForFriendsProviderEnrollment({
      tournamentId: EXERCISE_ID,
      fetchImpl: async (url) => String(url).includes("/end-user/")
        ? response({
          id: EXERCISE_ID,
          direction: { id: 5278 },
          studio: { id: "station-a" },
          maxClientsCount: 8,
        })
        : response([{
          spot: 4,
          client: { id: PLAYER_ID, firstName: "Тест", lastName: "Игрок" },
        }]),
    }),
    (error) => error?.code === "PROVIDER_ACTIVE_STATUS_NOT_PROVEN",
  );
});

test("provider runtime roster rejects malformed identities and duplicate active spots", async () => {
  const exercise = {
    id: EXERCISE_ID,
    direction: { id: 5278 },
    studio: { id: "station-a" },
    maxClientsCount: 8,
  };
  await assert.rejects(
    loadTimeForFriendsProviderEnrollment({
      tournamentId: EXERCISE_ID,
      fetchImpl: async (url) => String(url).includes("/end-user/")
        ? response(exercise)
        : response([{ spot: 1, isCancelled: false, client: { id: "not-a-viva-uuid" } }]),
    }),
    (error) => error?.code === "PROVIDER_PLAYER_ID_INVALID",
  );

  await assert.rejects(
    loadTimeForFriendsProviderEnrollment({
      tournamentId: EXERCISE_ID,
      fetchImpl: async (url) => String(url).includes("/end-user/")
        ? response(exercise)
        : response([
          { spot: 1, isCancelled: false, client: { id: PLAYER_ID } },
          { spot: 1, isCancelled: false, client: { id: "22222222-2222-4222-8222-222222222222" } },
        ]),
    }),
    (error) => error?.code === "PROVIDER_ACTIVE_SPOT_DUPLICATE",
  );
});

test("provider runtime roster rejects an unknown successful JSON shape", async () => {
  await assert.rejects(
    loadTimeForFriendsProviderEnrollment({
      tournamentId: EXERCISE_ID,
      fetchImpl: async (url) => String(url).includes("/end-user/")
        ? response({
          id: EXERCISE_ID,
          direction: { id: 5278 },
          studio: { id: "station-a" },
          maxClientsCount: 8,
        })
        : response({ unexpected: [] }),
    }),
    (error) => error?.code === "PROVIDER_PARTICIPANTS_SCHEMA_INVALID",
  );
});
