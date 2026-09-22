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
  for (const holder of ["product", "clientSubscription", "clientSub"]) {
    assert.equal(isProTrainingEnergyPack({name: "Энергия 5", [holder]: {visitsLeft: 2}}), true);
    assert.equal(isProTrainingEnergyPack({name: "Энергия 5", [holder]: {visitsLeft: 0}}), false);
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
    assert.match(after[i].func, /function isProTrainingEnergyPack\(value\)/);
    assert.match(after[i].func, /return \/\^\(энергия\|energy\) \(5\|25\)\(\?: \|\$\)\/\.test/);
    assert.match(after[i].func, /value\.clientSubscription/);
  });
  assert.equal(changed, 2);
  assert.equal(built.report.candidateSha256, "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe");
  assert.throws(() => composeEnergySuffix(built.candidateBytes), /preimage drift/);
});
