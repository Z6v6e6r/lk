import fs from 'node:fs';
import crypto from 'node:crypto';
import { extractSubscriptionPricePreviewSource } from './subscriptionPricePreviewSources.mjs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const extract = (path, root) =>
  extractSubscriptionPricePreviewSource({
    source: read(path),
    label: 'CREATE exact service table',
    roots: [root],
  }).source;
// Reuse declarations, never execute the enclosing Node-RED router or consult global cache.
const canonical = extract('nodered_lk1_hub_nodes/gateway_hooks.js', 'lk1CourtMasterServices');
const evaluate = (source, root) => new Function(source + '\nreturn ' + root + ';')();
const table = evaluate(canonical, 'lk1CourtMasterServices');
const preview = evaluate(
  extract('nodered_subscription_price_preview_nodes/router.js', 'lk1CourtMasterServices'),
  'lk1CourtMasterServices',
);
const onboarding = evaluate(
  extract('nodered_onboarding_nodes/fn_onboarding_stations.js', 'serviceByStation'),
  'serviceByStation',
);
const stable = (t) =>
  JSON.stringify(
    Object.keys(t)
      .sort()
      .map((station) => [station, t[station].masterServiceId, t[station].subServiceId]),
  );
if (
  Object.keys(table).length !== 8 ||
  stable(table) !== stable(preview) ||
  Object.keys(onboarding).length !== 8 ||
  Object.keys(table).some(
    (id) =>
      onboarding[id]?.masterServiceId !== table[id].masterServiceId ||
      JSON.stringify(onboarding[id].subServiceIds) !== JSON.stringify([table[id].subServiceId]),
  )
)
  throw new Error('CREATE_SERVICE_TABLE_PARITY_INVALID');
export const gameCreateSelectorSha256 =
  'sha256:' + crypto.createHash('sha256').update(stable(table)).digest('hex');
export const gameCreateServiceTable = Object.freeze(structuredClone(table));
export const gameCreatePreparationSource = (name) =>
  [
    read('nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js'),
    read('nodered_game_create_preparation_nodes/_game_create_preparation_contract.js'),
    ...(name === 'router'
      ? [canonical, `const gcSelectorRevision=${JSON.stringify(gameCreateSelectorSha256)};`]
      : []),
    read('nodered_game_create_preparation_nodes/fn_game_create_preparation_' + name + '.js'),
  ].join('\n');
