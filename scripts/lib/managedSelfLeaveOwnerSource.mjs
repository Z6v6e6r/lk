import fs from 'node:fs';
const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const legacy = read('nodered_games_nodes/fn_split_leave_authorize.js');
const pure = legacy.slice(0, legacy.indexOf('const respond ='));
if (!pure || /msg\.|global\.|env\./.test(pure))
  throw new Error('SELF owner selector closure is not read-only');
export const managedSelfLeaveOwnerSource = (name) =>
  [
    read('nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js'),
    read('nodered_booked_operation_receiver_nodes/_booked_operation_managed_join_v2.js'),
    `const mslLegacy=(()=>{${pure}\nreturn {isObj,asArray,toStr,normalizeId,normalizePhone,matchesActor,inactiveStatus,stableVersion,phoneIdentityAmbiguous};})();`,
    read('nodered_managed_self_leave_nodes/_managed_self_leave_contract.js'),
    read('nodered_managed_self_leave_nodes/fn_managed_self_leave_' + name + '.js'),
  ].join('\n');
