import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { composeEnergySuffix, BEFORE, AFTER } from "../patch_live_lk1_pro_energy_suffix.mjs";
import { isProTrainingEnergyPack } from "../lib/proTrainingExclusion.mjs";

test("suffix names allow owned Energy only, and cannot override catalog identity or balance", () => {
  for (const name of ["Энергия 5 🎾 Селигерская Акционная", "Энергия 25 Терехово", "Energy 5 Promo"]) {
    assert.equal(isProTrainingEnergyPack({name, visitsLeft: 2}), true);
    assert.equal(isProTrainingEnergyPack({name, visitsLeft: 0}), false);
    assert.equal(isProTrainingEnergyPack({name, productId: "ra"}), false);
  }
  for (const name of ["Энергия 50", "Энергия 250", "Энергия турниры", "РА", "Академия", "Дружба"]) {
    assert.equal(isProTrainingEnergyPack({name}), false);
  }
});

test("suffix generation rejects an unreviewed source", () => {
  assert.throws(() => composeEnergySuffix(Buffer.from("[]")), /preimage drift/);
});

const snapshot = process.env.ENERGY_SUFFIX_SNAPSHOT;
test("fresh reviewed snapshot changes exactly two regexes and refuses replay", {skip: !snapshot}, () => {
  const bytes = fs.readFileSync(snapshot);
  const built = composeEnergySuffix(bytes);
  const before = JSON.parse(bytes), after = JSON.parse(built.candidateBytes);
  assert.equal(after.length, before.length);
  let changed = 0;
  before.forEach((row, i) => {
    if (JSON.stringify(row) === JSON.stringify(after[i])) return;
    changed++;
    assert.deepEqual({...after[i], func: row.func}, row);
    assert.equal(after[i].func, row.func.replace(BEFORE, AFTER));
  });
  assert.equal(changed, 2);
  assert.equal(built.report.candidateSha256, "8af4b1cf16538c712197d031a78db202a9db0762d2ff2bd2a1a94839207449bf");
  assert.throws(() => composeEnergySuffix(built.candidateBytes), /preimage drift/);
});
