import fs from 'node:fs';
import { HUB_LK1_SALE_HELPERS } from './lib/hubLk1SaleContract.mjs';
import { legacyEpochConfirmationSource } from './lib/subscriptionLegacyEpochConfirmation.mjs';
import { subscriptionCounterEpochSource } from './lib/subscriptionCounterEpoch.mjs';
export const epochSourceFiles = ['status_prepare','status_response','purchase_prepare','purchase_limit','purchase_router',
  'confirm_prepare','confirm_resolve','counter_refresh_prepare','counter_refresh_response','reconcile_query','piter_atomic_router']
  .map(name => `fn_tournament_subscription_${name}.js`);
export function syncCounterEpoch({ check = false } = {}) {
  for (const file of epochSourceFiles) {
    const target = new URL(`./nodered_games_nodes/${file}`, import.meta.url);
    const before = fs.readFileSync(target, 'utf8'), pattern = /\/\/ BEGIN generated subscriptionCounterEpoch\n[\s\S]*?\/\/ END generated subscriptionCounterEpoch\n/;
    let code = pattern.test(before) ? before.replace(pattern, () => subscriptionCounterEpochSource()) : subscriptionCounterEpochSource() + before;
    if (file.includes('counter_refresh_response')) {
      const helper = '// BEGIN generated hubLk1SaleContract\n' + HUB_LK1_SALE_HELPERS + '// END generated hubLk1SaleContract\n';
      const pattern = /\/\/ BEGIN generated hubLk1SaleContract\n[\s\S]*?\/\/ END generated hubLk1SaleContract\n/;
      code = pattern.test(code) ? code.replace(pattern, () => helper) : helper + code;
    }
    if (file.includes('piter_atomic_router')) {
      const legacyPattern = /\/\/ BEGIN generated legacyEpochConfirmation\n[\s\S]*?\/\/ END generated legacyEpochConfirmation\n/;
      code = legacyPattern.test(code) ? code.replace(legacyPattern, () => legacyEpochConfirmationSource()) : legacyEpochConfirmationSource() + code;
    }
    if (check && code !== before) throw Error(`Counter epoch source stale: ${file}`);
    if (!check && code !== before) fs.writeFileSync(target, code);
  }
}
if (process.argv[1]?.endsWith('/sync_subscription_counter_epoch.mjs')) syncCounterEpoch({ check: process.argv.includes('--check') });
