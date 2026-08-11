import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SPLIT_SUBSCRIPTION_SELECTION_TARGETS } from "../patch_live_split_subscription_selection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIR = path.join(ROOT, "scripts/nodered_games_nodes");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("focused split subscription patch stays pinned to the three reviewed function sources", () => {
  assert.equal(SPLIT_SUBSCRIPTION_SELECTION_TARGETS.length, 3);
  assert.equal(
    new Set(SPLIT_SUBSCRIPTION_SELECTION_TARGETS.map((target) => target.id)).size,
    SPLIT_SUBSCRIPTION_SELECTION_TARGETS.length,
  );

  for (const target of SPLIT_SUBSCRIPTION_SELECTION_TARGETS) {
    const source = fs.readFileSync(path.join(SOURCE_DIR, target.fileName), "utf8");
    assert.equal(sha256(source), target.candidateSha256, target.fileName);
    assert.notEqual(target.liveSha256, target.candidateSha256, target.fileName);
  }
});

test("split create and join prepare functions reject missing explicit subscription selection", () => {
  for (const fileName of ["fn_split_create_prepare.js", "fn_split_join_prepare.js"]) {
    const source = fs.readFileSync(path.join(SOURCE_DIR, fileName), "utf8");
    assert.match(source, /paymentMode === "subscription" && !clientSubscriptionId/);
    assert.match(source, /SUBSCRIPTION_SELECTION_REQUIRED/);
  }
});

test("split router does not fall back after a selected subscription product mismatch", () => {
  const source = fs.readFileSync(path.join(SOURCE_DIR, "fn_split_router.js"), "utf8");
  assert.match(source, /if \(toStr\(preferredSubscriptionId\)\) return null;/);
  assert.match(source, /requestedMode === "subscription"[\s\S]*!requestedSubscriptionMatched/);
  assert.match(source, /Выбранный абонемент недоступен для списания/);
});
