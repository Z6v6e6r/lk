import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mods = [
  "patch_live_lk1_topokraty_friendship_hotfix.mjs",
  "patch_live_lk1_topokraty_copay_hotfix.mjs",
  "patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs",
  "patch_live_lk1_plan_rules.mjs",
  "patch_live_lk1_hub.mjs",
  "patch_nodered_subscription_price_preview.mjs",
  "patch_live_lk1_patriots_friendship.mjs",
  "patch_live_subscription_calculation_repair.mjs",
  "patch_live_lk1_event_quotes_hotfix.mjs",
];
const wanted = /SHA256|TARGET|PREIMAGE|POSTIMAGE|UPSTREAM|NODE_COUNT|APPLIED|SOURCE|INSTALLED|REVERT|CANONICAL|GENERATION|FRAGMENT|pins|preimages|usage/i;
for (const name of mods) {
  const mod = await import(path.join(ROOT, "scripts", name));
  console.log(`\n=== ${name} ===`);
  for (const [key, value] of Object.entries(mod)) {
    if (!wanted.test(key)) continue;
    console.log(`${key} = ${JSON.stringify(value)}`);
  }
}
