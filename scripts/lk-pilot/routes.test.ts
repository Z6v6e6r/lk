import assert from "node:assert/strict";
import test from "node:test";
import { pilotScreens, readPilotScreen, resolvePilotNavigation } from "../../src/lk-pilot/routes.ts";

const page = "https://padlhub.ru/lk_pilot";

test("pilot has the eight exact #339 windows and refuses fixture IDs", () => {
  assert.deepEqual(Object.keys(pilotScreens).sort(), [
    "game-booking", "game-join", "game-list", "matrix",
    "tournament-booking", "tournament-join", "training-booking", "training-join",
  ]);
  assert.equal(readPilotScreen(new URLSearchParams("screen=game-join&eventId=demo-game")).eventId, null);
  assert.equal(readPilotScreen(new URLSearchParams("screen=training-join&eventId=valid-uuid")).eventId, "valid-uuid");
});

test("navigation preserves selected public event and date without accepting external payment URLs", () => {
  const next = resolvePilotNavigation("/game_join?joinGame=id-1&date=2026-11-25&authMode=viva&paymentRef=sample", page);
  assert.ok(next);
  const target = new URL(next, page);
  assert.equal(target.pathname, "/lk_pilot");
  assert.equal(target.searchParams.get("screen"), "game-join");
  assert.equal(target.searchParams.get("eventId"), "id-1");
  assert.equal(target.searchParams.get("authMode"), "viva");
  assert.equal(target.searchParams.get("date"), "2026-11-25");
  assert.equal(target.searchParams.has("paymentRef"), false);
  assert.match(resolvePilotNavigation("/group?exerciseId=training-1", page) ?? "", /training-join/);
  assert.match(resolvePilotNavigation("/tournaments?tournamentId=tour-1", page) ?? "", /tournament-join/);
  assert.equal(resolvePilotNavigation("https://bank.example/invoice", page), null);
  assert.equal(resolvePilotNavigation("/payment_return", page), null);
});
