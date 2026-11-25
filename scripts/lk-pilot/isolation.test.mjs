import assert from "node:assert/strict";
import test from "node:test";
import { normalizedPilotQuery, pilotLocalStorage } from "./isolation.mjs";

test("pilot reads the existing access token without sharing checkout state or storage writes", () => {
  const cabinet = new Map([
    ["padlhub_auth_token_v1", "existing-session"],
    ["padlhub_refresh_token_v1", "not-visible-to-pilot"],
    ["payment-recovery", "cabinet-state"],
  ]);
  const pilot = pilotLocalStorage({ getItem: (key) => cabinet.get(key) ?? null });
  assert.equal(pilot.getItem("padlhub_auth_token_v1"), "existing-session");
  assert.equal(pilot.getItem("padlhub_refresh_token_v1"), null);
  assert.equal(pilot.getItem("payment-recovery"), null);
  pilot.removeItem("padlhub_auth_token_v1");
  pilot.setItem("padlhub_auth_token_v1", "replacement");
  pilot.setItem("payment-recovery", "pilot-only");
  assert.equal(pilot.getItem("payment-recovery"), "pilot-only");
  pilot.clear();
  assert.deepEqual([...cabinet.values()], ["existing-session", "not-visible-to-pilot", "cabinet-state"]);
});

test("strip old payment and OAuth callbacks before any live widget mounts", () => {
  assert.equal(normalizedPilotQuery("?screen=game-join&eventId=test-game&phPaymentRef=old&phCheckoutReturn=1&code=fixture&state=old&screen=matrix"),
    "screen=game-join&eventId=test-game");
});
