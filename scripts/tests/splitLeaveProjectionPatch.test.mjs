import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SPLIT_LEAVE_PROJECTION_TARGET } from "../patch_live_split_leave_projection_consistency.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(
  ROOT,
  "scripts/nodered_games_nodes",
  SPLIT_LEAVE_PROJECTION_TARGET.fileName,
);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("focused split leave projection patch stays pinned to one reviewed function source", () => {
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.equal(sha256(source), SPLIT_LEAVE_PROJECTION_TARGET.candidateSha256);
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
