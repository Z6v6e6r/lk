import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCE_SHA256, TARGETS } from "../prepare_split_leave_active_viva_demotion_candidate.mjs";

import { DEMOTION_SOURCE_COMMIT, reviewedLeaveSource } from "./fixtures/reviewedLeaveSources.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (fileName) => fs.readFileSync(path.join(ROOT, "scripts/nodered_games_nodes", fileName), "utf8");

// Current owner packet only; historical deployed/candidate source commits stay frozen.
const OWNER_SOURCE_SHA256 = {
  "fn_split_leave_prepare.js": "97f271609187a14c210a7996743f16031c403d4db39296db4936ee854005706e",
  "fn_split_leave_router.js": "9db07d0a7e10d8040e4b63c364356192a4d6fb08adf55f90beca470d931a4dd2"
};

test("active-viva demotion keeps historical pins and binds current source to the reviewed successor", () => {
  assert.match(SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.deepEqual(TARGETS.map((target) => target.id), ["016d6797a530ed0a", "9878400d518ebcbd"]);
  for (const target of TARGETS) {
    assert.notEqual(target.liveSha256, target.candidateSha256);
    assert.equal(sha256(reviewedLeaveSource(target.file, DEMOTION_SOURCE_COMMIT)), target.candidateSha256);
    assert.equal(sha256(read(target.file)), OWNER_SOURCE_SHA256[target.file], `${target.file} drifted from the reviewed owner packet`);
  }
});

test("only the HTTP entry marks the leave as a player action", () => {
  const prepare = read("fn_split_leave_prepare.js");
  assert.match(prepare, /foregroundRequest:\s*true/);
  const retryHydrate = read("fn_split_leave_retry_hydrate.js");
  assert.doesNotMatch(retryHydrate, /foregroundRequest/);
});

test("foreground reconciliation demotes to a normal cancellation while background recovery keeps failing closed", () => {
  const router = read("fn_split_leave_router.js");
  assert.match(router, /ctx\.foregroundRequest === true/);
  assert.match(router, /ctx\.backgroundStartedRecovery !== true/);
  assert.match(router, /ambiguousRows\.length === 0/);
  assert.match(router, /delete ctx\.localReconciliation/);
  assert.match(router, /local_reconciliation_demoted/);
  assert.match(router, /В Viva есть действующая запись\. Обновите игру перед новым выходом\./);
});
