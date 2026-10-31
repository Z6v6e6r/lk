import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
export const stationLifetimeRuntimeSource = () => read('lib/stationMembershipLifetime.mjs')
  .replace("import crypto from 'node:crypto';", "const crypto = typeof nodeCrypto === 'undefined' ? null : nodeCrypto;")
  .replace(/^export /gm, '');
export const stationMembershipReceiverSource = (name, mode) => [stationLifetimeRuntimeSource(),
  read('nodered_station_membership_nodes/_station_membership_contract.js'),
  ...(name === 'verify' ? [read('nodered_station_membership_nodes/_station_membership_delegation.js'), 'const STATION_MEMBERSHIP_MODE=' + JSON.stringify(mode) + ';'] : []),
  read('nodered_station_membership_nodes/fn_station_membership_' + name + '.js')].join('\n');
