import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  normalizeAbLetoTrainerQrCode,
  readAbLetoTrainerQrCode,
} from "../../src/utils/abLetoTrainerQr.ts";

test("only the issued trainer QR code range is accepted", () => {
  assert.equal(normalizeAbLetoTrainerQrCode("tr-001"), "TR-001");
  assert.equal(normalizeAbLetoTrainerQrCode("TR-050"), "TR-050");
  assert.equal(normalizeAbLetoTrainerQrCode("TR-051"), null);
  assert.equal(normalizeAbLetoTrainerQrCode("TR-000"), null);
  assert.equal(readAbLetoTrainerQrCode("?offer=sport-promo&qr=TR-017"), "TR-017");
});

test("QR code is sent to both page analytics and the paid-sale record", () => {
  const entry = fs.readFileSync("src/tournament-subscription.tsx", "utf8");
  const page = fs.readFileSync("src/components/tournament-subscription/TournamentSubscriptionPage.tsx", "utf8");
  const client = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const prepare = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js", "utf8");
  const router = fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js", "utf8");

  assert.match(entry, /trainerQrCode: readAbLetoTrainerQrCode\(\)/);
  assert.match(page, /trainerQrCode: pageConfig\?\.trainerQrCode \?\? null/);
  assert.match(client, /trainerQrCode: params\.trainerQrCode \?\? null/);
  assert.match(prepare, /const trainerQrCode = normalizeTrainerQrCode\(body\.trainerQrCode \|\| body\.qr\)/);
  assert.match(router, /trainerQrCode: toStr\(ctx\.trainerQrCode\)/);
});

test("staged release constants are aligned for status and purchase flows", () => {
  for (const file of [
    "scripts/nodered_games_nodes/fn_tournament_subscription_status_prepare.js",
    "scripts/nodered_games_nodes/fn_tournament_subscription_purchase_prepare.js",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /AB_LETO_STAGED_RELEASE_START_DATE = "2026-08-01"/);
    assert.match(source, /AB_LETO_STAGED_LAUNCH_LIMIT = 100/);
    assert.match(source, /AB_LETO_STAGED_DAILY_DROP_LIMIT = 7/);
    assert.match(source, /AB_LETO_DAILY_DROP_COUNTER_KEYS = new Set\(\["friendship", "ra"\]\)/);
    assert.doesNotMatch(source, /AB_LETO_TEMPORARY_UNLIMITED_DATES/);
  }
});
