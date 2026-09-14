import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paymentPollingRuntimeSource } from './lib/subscriptionPaymentPolling.mjs';
export const pollingSourceNames = ['poll_admit', 'confirm_resolve', 'purchase_router', 'piter_atomic_router'];
export function syncPaymentPolling({ check = false } = {}) {
  for (const name of pollingSourceNames) {
    const file = new URL(`./nodered_games_nodes/fn_tournament_subscription_${name}.js`, import.meta.url);
    const before = fs.readFileSync(file, 'utf8');
    const pattern = /\/\/ BEGIN generated subscriptionPaymentPolling\n[\s\S]*?\/\/ END generated subscriptionPaymentPolling\n/;
    const code = pattern.test(before) ? before.replace(pattern, () => paymentPollingRuntimeSource()) : paymentPollingRuntimeSource() + before;
    if (check && code !== before) throw Error(`Stale payment polling source: ${name}`);
    if (!check && code !== before) fs.writeFileSync(file, code);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncPaymentPolling({ check: process.argv.includes('--check') });
