import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { annualHistoryRuntimeSource } from './lib/annualSubscriptionHistory.mjs';
import { annualHistoryRouterSource } from './lib/annualSubscriptionHistoryRouter.mjs';

export const annualHistorySourceFiles = ['confirm_resolve', 'status_response', 'piter_atomic_router', 'purchase_router', 'counter_refresh_response']
  .map(name => `fn_tournament_subscription_${name}.js`);
export function syncAnnualHistory({ check = false } = {}) {
  for (const file of annualHistorySourceFiles) {
    const target = new URL(`./nodered_games_nodes/${file}`, import.meta.url);
    let code = fs.readFileSync(target, 'utf8');
    const before = code;
    for (const [name, source] of [['annualSubscriptionHistory', annualHistoryRuntimeSource()],
      ...(file.includes('atomic_router') ? [['annualSubscriptionHistoryRouter', annualHistoryRouterSource()]] : [])]) {
      const pattern = new RegExp(`// BEGIN generated ${name}\\n[\\s\\S]*?// END generated ${name}\\n`);
      code = pattern.test(code) ? code.replace(pattern, () => source) : source + code;
    }
    if (check && code !== before) throw Error(`Annual history source is stale: ${file}`);
    if (!check && code !== before) fs.writeFileSync(target, code);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(a => a !== '--check')) throw Error('Usage: [--check]');
  syncAnnualHistory({ check: process.argv.includes('--check') });
}
