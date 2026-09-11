import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOYMENT_ID,
  SOURCE_SHA256,
  TARGETS,
} from "../prepare_cup_bookingless_staff_leave_candidate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("booking-less staff leave candidate pins one reviewed source per changed node", () => {
  assert.match(SOURCE_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(TARGETS.length, 3);
  assert.deepEqual(
    TARGETS.map((target) => target.id).sort(),
    [
      "lk_split_leave_game_update_build_20260801",
      "lk_staff_player_leave_authorize_20260812",
      "lk_staff_player_leave_prepare_20260812",
    ],
  );
  for (const target of TARGETS) {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts/nodered_games_nodes", target.file),
      "utf8",
    );
    assert.equal(sha256(source), target.candidateSha256, `${target.file} drifted from the reviewed candidate`);
    assert.match(target.liveSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(target.liveSha256, target.candidateSha256);
  }
});

test("booking-less staff leave candidate declares no deployment and no secrets", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/prepare_cup_bookingless_staff_leave_candidate.mjs"),
    "utf8",
  );
  assert.match(source, /deploymentPerformed: false/);
  assert.doesNotMatch(source, /deploymentPerformed: true/);
  assert.match(source, new RegExp(`export const DEPLOYMENT_ID = "${DEPLOYMENT_ID}"`));
  assert.doesNotMatch(source, /service-secret|admin-token/);
});
