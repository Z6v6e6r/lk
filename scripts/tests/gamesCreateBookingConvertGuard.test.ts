import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  const env = { get: (key: string) => key === "PADLHUB_PLATFORM_TENANT_KEY" ? "tenant-test" : undefined };
  return new Function("msg", "env", source)(msg, env);
}

type NodeRedFunctionResponse = {
  statusCode?: number;
  payload?: {
    code?: string;
    category?: string;
    metadata?: Record<string, unknown>;
  };
};

test("backend blocks cabinet booking convert for game plus trainer", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_create.js", {
    req: { path: "/lk/games", query: {} },
    payload: {
      organizer: {
        id: "organizer-1",
        name: "Organizer",
        phone: "79850000000",
      },
      booking: {
        studioId: "studio-1",
        studioName: "Studio",
        roomId: "room-1",
        roomName: "Court",
        date: "2026-07-06",
        timeFrom: "12:00",
        timeTo: "13:00",
      },
      metadata: {
        source: "cabinet_booking_convert",
        bookingId: "booking-1",
        bookingIds: ["booking-1"],
        vivaExerciseId: "exercise-1",
        typeId: 847,
        typeName: "Игра+Тренер",
        directionId: 3935,
        directionName: "Игра+Тренер. Уровень D",
      },
      payment: {
        paid: true,
      },
      settings: {
        payMode: "self",
      },
      participants: [
        {
          id: "organizer-1",
          name: "Organizer",
          phone: "79850000000",
        },
      ],
    },
  }) as unknown[];

  const dbMsg = out[0];
  const response = out[1] as NodeRedFunctionResponse;
  assert.equal(dbMsg, null);
  assert.equal(response.statusCode, 409);
  assert.equal(response.payload?.code, "BOOKING_CONVERT_CATEGORY_NOT_ALLOWED");
  assert.equal(response.payload?.category, "group_training");
});

test("backend allows cabinet booking convert for open game", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_create.js", {
    req: { path: "/lk/games", query: {} },
    payload: {
      organizer: {
        id: "organizer-1",
        name: "Organizer",
        phone: "79850000000",
      },
      booking: {
        studioId: "studio-1",
        studioName: "Studio",
        roomId: "room-1",
        roomName: "Court",
        date: "2026-07-06",
        timeFrom: "12:00",
        timeTo: "13:00",
      },
      metadata: {
        source: "cabinet_booking_convert",
        bookingId: "booking-1",
        bookingIds: ["booking-1"],
        vivaExerciseId: "exercise-1",
        typeId: 1613,
        typeName: "Открытая игра",
        directionId: 4588,
        directionName: "Открытая игра",
      },
      payment: {
        paid: true,
      },
      settings: {
        payMode: "self",
      },
      participants: [
        {
          id: "organizer-1",
          name: "Organizer",
          phone: "79850000000",
        },
      ],
    },
  }) as unknown[];

  const dbMsg = out[0] as Record<string, unknown>;
  const response = out[1] as NodeRedFunctionResponse;
  assert.ok(dbMsg);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload?.metadata?.source, "cabinet_booking_convert");
  assert.equal(response.payload?.metadata?.typeId, 1613);
  assert.equal(response.payload?.metadata?.directionId, 4588);
});

test("backend allows cabinet booking convert for a court rental", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_create.js", {
    req: { path: "/lk/games", query: {} },
    payload: {
      organizer: {
        id: "organizer-1",
        name: "Organizer",
        phone: "79850000000",
      },
      booking: {
        studioId: "studio-1",
        studioName: "Studio",
        roomId: "room-1",
        roomName: "Court",
        date: "2026-07-22",
        timeFrom: "12:00",
        timeTo: "13:00",
      },
      metadata: {
        source: "cabinet_booking_convert",
        bookingId: "booking-rental-1",
        bookingIds: ["booking-rental-1"],
        vivaExerciseId: "exercise-rental-1",
        typeId: 9002,
        typeName: "Падел — аренда",
        directionId: 9001,
        directionName: "Аренда корта",
      },
      payment: {
        paid: true,
      },
      settings: {
        payMode: "self",
      },
      participants: [
        {
          id: "organizer-1",
          name: "Organizer",
          phone: "79850000000",
        },
      ],
    },
  }) as unknown[];

  const dbMsg = out[0] as Record<string, unknown>;
  const response = out[1] as NodeRedFunctionResponse;
  assert.ok(dbMsg);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload?.metadata?.source, "cabinet_booking_convert");
  assert.equal(response.payload?.metadata?.typeName, "Падел — аренда");
  assert.equal(response.payload?.metadata?.directionName, "Аренда корта");
});

test("backend still blocks an unknown booking category", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_create.js", {
    req: { path: "/lk/games", query: {} },
    payload: {
      organizer: { id: "organizer-1", name: "Organizer", phone: "79850000000" },
      booking: {
        studioId: "studio-1",
        studioName: "Studio",
        roomId: "room-1",
        roomName: "Court",
        date: "2026-07-22",
        timeFrom: "12:00",
        timeTo: "13:00",
      },
      metadata: {
        source: "cabinet_booking_convert",
        bookingId: "booking-unknown-1",
        bookingIds: ["booking-unknown-1"],
        vivaExerciseId: "exercise-unknown-1",
        typeName: "Неизвестная услуга",
        directionName: "Другое",
      },
      payment: { paid: true },
      settings: { payMode: "self" },
      participants: [{ id: "organizer-1", name: "Organizer", phone: "79850000000" }],
    },
  }) as unknown[];

  const response = out[1] as NodeRedFunctionResponse;
  assert.equal(out[0], null);
  assert.equal(response.statusCode, 409);
  assert.equal(response.payload?.code, "BOOKING_CONVERT_CATEGORY_UNKNOWN");
});

test("patch script syncs prepare game upsert from fn_create source", () => {
  const patchSource = fs.readFileSync("scripts/patch_nodered_games_modular_flow.mjs", "utf8");
  assert.match(patchSource, /replaceAllFunctions\("Prepare game upsert", "fn_create\.js"\);/);
});
