import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCE_SHA256, TARGETS } from "../prepare_split_leave_active_viva_demotion_candidate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (fileName) => fs.readFileSync(path.join(ROOT, "scripts/nodered_games_nodes", fileName), "utf8");

test("active-viva demotion candidate stays pinned to the reviewed live preimage", () => {
  assert.match(SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.deepEqual(TARGETS.map((target) => target.id), ["016d6797a530ed0a", "9878400d518ebcbd"]);
  for (const target of TARGETS) {
    assert.notEqual(target.liveSha256, target.candidateSha256);
    assert.equal(sha256(read(target.file)), target.candidateSha256, `${target.file} drifted`);
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
