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
  buildCupBookinglessStaffLeaveCandidate,
  EXPECTED_NODE_COUNT,
  EXPECTED_HTTP_ROUTE_COUNT,
  TAB_ID,
  TAB_LABEL,
} from "../prepare_cup_bookingless_staff_leave_candidate.mjs";

import { CUP_LEAVE_SOURCE_COMMIT, reviewedLeaveSource } from "./fixtures/reviewedLeaveSources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("booking-less staff leave keeps historical pins and binds current source to the reviewed successor", () => {
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
    assert.equal(sha256(reviewedLeaveSource(target.file, CUP_LEAVE_SOURCE_COMMIT)), target.candidateSha256);
    assert.equal(sha256(source), sha256(reviewedLeaveSource(target.file)), `${target.file} drifted from the reviewed successor`);
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

// Match real historical function hashes without importing private live-flow data.
test("historical CUP builder refuses successor source even with exact function preimages", () => {
  const beforeCommit = "6293956b638b710fa74e3c7e9666103831aa2282";
  const source = [
    { id: TAB_ID, type: "tab", label: TAB_LABEL, disabled: false },
    ...TARGETS.map((target) => {
      const func = reviewedLeaveSource(target.file, beforeCommit);
      assert.equal(sha256(func), target.liveSha256);
      return { id: target.id, type: "function", z: TAB_ID, name: target.name,
        outputs: target.outputs, wires: Array.from({ length: target.outputs }, () => []), func };
    }),
    ...Array.from({ length: EXPECTED_HTTP_ROUTE_COUNT }, (_, i) => ({ id: `route-${i}`, type: "http in" })),
  ];
  while (source.length < EXPECTED_NODE_COUNT) source.push({ id: `filler-${source.length}`, type: "comment" });
  const before = structuredClone(source);
  assert.throws(() => buildCupBookinglessStaffLeaveCandidate(source), /Tracked candidate source changed/);
  assert.deepEqual(source, before);
});
