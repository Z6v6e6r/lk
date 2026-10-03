import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SPLIT_LEAVE_PROJECTION_TARGET, buildSplitLeaveProjectionCandidate } from "../patch_live_split_leave_projection_consistency.mjs";

import { PROJECTION_SOURCE_COMMIT, reviewedLeaveSource } from "./fixtures/reviewedLeaveSources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(
  ROOT,
  "scripts/nodered_games_nodes",
  SPLIT_LEAVE_PROJECTION_TARGET.fileName,
);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("focused split leave projection keeps its historical pin and binds current source to the reviewed successor", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.equal(sha256(reviewedLeaveSource(SPLIT_LEAVE_PROJECTION_TARGET.fileName, PROJECTION_SOURCE_COMMIT)), SPLIT_LEAVE_PROJECTION_TARGET.candidateSha256);
  assert.equal(sha256(source), sha256(reviewedLeaveSource(SPLIT_LEAVE_PROJECTION_TARGET.fileName)));
  assert.notEqual(
    SPLIT_LEAVE_PROJECTION_TARGET.liveSha256,
    SPLIT_LEAVE_PROJECTION_TARGET.candidateSha256,
  );
});

test("split leave invalidates the stale result roster snapshot atomically with LEFT", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /status:\s*"LEFT"/);
  assert.match(source, /\$unset:\s*\{\s*resultRosterSnapshot:\s*""/);
});

test("historical projection builder refuses successor source without changing its input", () => {
  const target = SPLIT_LEAVE_PROJECTION_TARGET;
  const func = reviewedLeaveSource(target.fileName, "031fe98c73d42f94627b535f3cdb6eba30c8b183");
  assert.equal(sha256(func), target.liveSha256);
  const source = [
    { id: "4b91e2a2413688db", type: "tab", label: "LK Games", disabled: false },
    { id: target.id, type: "function", z: "4b91e2a2413688db", name: target.name,
      outputs: target.outputs, wires: Array.from({ length: target.outputs }, () => []), func },
    ...Array.from({ length: 209 }, (_, i) => ({ id: `route-${i}`, type: "http in" })),
  ];
  while (source.length < 4707) source.push({ id: `filler-${source.length}`, type: "comment" });
  const before = structuredClone(source);
  assert.throws(() => buildSplitLeaveProjectionCandidate(source), /Tracked split leave projection source changed/);
  assert.deepEqual(source, before);
});
