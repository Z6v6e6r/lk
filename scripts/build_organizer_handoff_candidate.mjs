import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_SHA = 'e672b79ae011f647d5156d840315543b88e471880236374c2aea2eaf0239f223';
const read = name => fs.readFileSync(path.join(root, 'nodered_organizer_handoff_nodes', name + '.js'), 'utf8');
export function buildOrganizerHandoffCandidate(source) {
  const flow = structuredClone(source);
  const node = id => { const rows = flow.filter(n => n.id === id); if (rows.length !== 1) throw new Error(`Node mismatch ${id}`); return rows[0]; };
  const tab = node('016d6797a530ed0a').z;
  const fn = (id, name, file, wires) => { const n = { ...node('016d6797a530ed0a'), id, name, func: read(file), outputs: wires.length, wires }; flow.push(n); return n; };
  const mongo = (id, operation, wires) => { const n = { ...node(operation === 'find' ? '7c280001a0c1e014' : 'lk_split_leave_game_update_20260801'), id, name: id, operation, collection: 'lk_games', wires }; flow.push(n); return n; };
  const response = '35f7c89069fc393a';
  const prefix = 'organizer_handoff_20260913_';
  const named = suffix => prefix + suffix;
  const sourceFiles = {
    'lk_split_leave_operation_route_20260801': 'fn_split_leave_operation_route.js',
    'lk_split_leave_game_update_build_20260801': 'fn_split_leave_game_update.js',
  };
  for (const [id, file] of Object.entries(sourceFiles)) node(id).func = fs.readFileSync(path.join(root, 'nodered_games_nodes', file), 'utf8');
  const replaceExact = (id, before, after) => {
    const target = node(id);
    if (target.func.split(before).length !== 2) throw new Error(`Preimage mismatch ${id}`);
    target.func = target.func.replace(before, after);
  };
  // Apply only the new guard to live cleanup, preserving its deployed task shape.
  const guard = read('cleanup_prepare_guard');
  replaceExact('9508f8e0ae8d282a', '  const timedOutPaymentItems = [];', guard + '  const timedOutPaymentItems = [];');
  replaceExact('9508f8e0ae8d282a', 'mode: "GAME_CLEANUP",\n    gameId,',
    'mode: "GAME_CLEANUP",\n    gameId,\n    expectedUpdatedAt: toStr(game.updatedAt),');
  const http = { ...node('ecf32036257013bd'), id: named('http'), name: 'Transfer game organizer', url: '/lk/games/:gameId/organizer/transfer', wires: [[named('auth')]] };
  flow.push(http);
  for (const [suffix, template, next] of [
    ['auth','7c280001a0c1e011','profile'], ['profile','7c280001a0c1e012','resolve'], ['resolve','7c280001a0c1e013','prepare'],
  ]) { const n = { ...node(template), id: named(suffix), name: `Organizer transfer ${suffix}`, wires: [[named(next)], ...node(template).wires.slice(1)] }; flow.push(n); }
  fn(named('prepare'), 'Prepare organizer transfer', 'fn_transfer_prepare', [[named('find')],[response]]);
  mongo(named('find'), 'find', [[named('build')]]);
  fn(named('build'), 'Build organizer transfer CAS', 'fn_transfer_build', [[named('update')],[response]]);
  mongo(named('update'), 'updateOne', [[named('ack')]]);
  fn(named('ack'), 'Confirm organizer transfer', 'fn_transfer_ack', [[response]]);
  function gate(suffix, destination) {
    const base = named(suffix);
    fn(base, `Read membership fence ${suffix}`, 'fn_leave_gate_find', [[base+'_find'],[destination]]);
    mongo(base+'_find', 'find', [[base+'_build']]);
    fn(base+'_build', `Acquire membership fence ${suffix}`, 'fn_leave_gate_build', [[base+'_update'],[response],[destination]]);
    mongo(base+'_update', 'updateOne', [[base+'_ack']]);
    fn(base+'_ack', `Confirm membership fence ${suffix}`, 'fn_leave_gate_ack', [[destination],[response]]);
    return base;
  }
  const provider = gate('provider', '9878400d518ebcbd');
  const local = gate('local', 'lk_split_leave_operation_viva_build_20260801');
  const daily = gate('daily', 'lk_split_leave_daily_limit_find_build_20260811');
  node('lk_split_leave_operation_route_20260801').wires[0] = [provider];
  node('lk_split_leave_operation_route_20260801').wires[1] = [local];
  node('lk_split_leave_operation_claim_ack_20260801').wires[0] = [provider];
  node('lk_split_leave_retry_hydrate_20260801').wires[0] = [daily];
  node('lk_split_leave_retry_hydrate_20260801').wires[1] = [provider];
  node('lk_split_leave_retry_hydrate_20260801').wires[3] = [daily];
  const finalize = 'lk_split_leave_finalize_20260801';
  fn(named('release'), 'Release completed membership fence', 'fn_leave_release_build', [[named('release_update')],[finalize]]);
  mongo(named('release_update'), 'updateOne', [[named('release_ack')]]);
  fn(named('release_ack'), 'Confirm membership fence release', 'fn_leave_release_ack', [[finalize],[response]]);
  for(const id of ['lk_split_leave_operation_done_ack_20260801','lk_split_leave_operation_done_readback_20260801']) node(id).wires[0] = [named('release')];
  node('lk_split_leave_operation_route_20260801').wires[4] = [named('release')];
  node('lk_split_leave_operation_route_20260801').outputs = 5;
  fn(named('patch_read'), 'Read immutable organizer authority', 'fn_patch_authority_find', [[named('patch_find')]]);
  mongo(named('patch_find'), 'find', [[named('patch_check')]]);
  fn(named('patch_check'), 'Protect organizer authority', 'fn_patch_authority_check', [['e0d7883bc1a9fa8c'],['e17f8a411d4dfa91']]);
  for (const id of ['7ad34f13c4b25d60','4cb1e542db56b508']) node(id).wires = [[named('patch_read')]];
  replaceExact('e0d7883bc1a9fa8c', 'return [dbMsg, responseMsg, responseMsg, autojoinProbeMsg];', `
if (!msg._organizerGuardSnapshot) return [null, null, null, null];
dbMsg.query = { ...dbMsg.query, updatedAt: msg._organizerGuardSnapshot.updatedAt ?? { $exists: false },
  organizer: msg._organizerGuardSnapshot.organizer, membershipMutation: { $exists: false } };
dbMsg._organizerPatchResponse = responseMsg.payload;
dbMsg._organizerPatchAutojoin = autojoinProbeMsg._gameAutojoinPatch;
return [dbMsg, null, null, null];`);
  fn(named('patch_ack'), 'Confirm organizer-protected game patch', 'fn_patch_write_ack', [['e17f8a411d4dfa91'],['5fc5eaeab97f3f88']]);
  node('591234d213742276').wires = [[named('patch_ack')]];
  fn(named('cleanup_gate'), 'Read game before organizer cancellation', 'fn_cleanup_gate_find', [[named('cleanup_find')],['bcc3dccf8d64f9bb']]);
  mongo(named('cleanup_find'), 'find', [[named('cleanup_build')]]);
  fn(named('cleanup_build'), 'Acquire organizer cancellation fence', 'fn_cleanup_gate_build', [[named('cleanup_update')],['dfaa7a139e9538c8']]);
  mongo(named('cleanup_update'), 'updateOne', [[named('cleanup_ack')]]);
  fn(named('cleanup_ack'), 'Confirm organizer cancellation fence', 'fn_cleanup_gate_ack', [['bcc3dccf8d64f9bb'],['dfaa7a139e9538c8']]);
  node('6172933891ac92e1').wires = [[named('cleanup_gate')]];
  replaceExact('bcc3dccf8d64f9bb', '  return [null, dbMsg, summaryMsg, summaryMsg];', `
  if (msg._organizerCleanupKey) {
    dbMsg.query["membershipMutation.operationKey"] = msg._organizerCleanupKey;
    dbMsg.query["membershipMutation.executorToken"] = msg._organizerCleanupExecutor;
    dbMsg.payload.$unset = { membershipMutation: "" };
  }
  dbMsg._organizerCleanupSummary = summaryMsg;
  return [null, dbMsg, null, null];`);
  fn(named('cleanup_write_ack'), 'Confirm organizer cancellation persistence', 'fn_cleanup_write_ack', [['e71d73fb91b0c3f0']]);
  node('11079a30bf3cc6ad').wires = [[named('cleanup_write_ack')]];
  replaceExact('legacy_roster_bridge_build_20260816',
    'const query = { id: ctx.gameId, archived: { $ne: true } };',
    'const query = { id: ctx.gameId, archived: { $ne: true }, membershipMutation: { $exists: false } };');
  fn(named('cleanup_pause'), 'Pause completed failed cancellation attempt', 'fn_cleanup_pause_build', [[named('cleanup_pause_update')],['e71d73fb91b0c3f0']]);
  mongo(named('cleanup_pause_update'), 'updateOne', [[named('cleanup_pause_ack')]]);
  fn(named('cleanup_pause_ack'), 'Confirm cancellation retry availability', 'fn_cleanup_pause_ack', [['e71d73fb91b0c3f0']]);
  node('bcc3dccf8d64f9bb').wires[2] = [named('cleanup_pause')];
  const added = flow.filter(n=>n.id.startsWith(prefix));
  flow.push({ ...node('lk_split_leave_persistence_catch_20260801'), id: named('catch'), name:'Catch organizer handoff persistence errors', scope:added.map(n=>n.id), wires:[[named('catch_response')]] });
  const catcher = fn(named('catch_response'), 'Organizer handoff retry response', 'fn_transfer_ack', [[response]]);
  catcher.func = 'msg.statusCode = 503; msg.payload = { ok: false, state: "RETRY_REQUIRED", message: "Не удалось подтвердить сохранение. Обновите игру перед повтором." }; return msg;';
  const ids = new Set(flow.map(n=>n.id));
  if (ids.size !== flow.length) throw new Error('Duplicate IDs');
  for (const n of flow) for(const target of (n.wires || []).flat()) if(!ids.has(target)) throw new Error(`Broken wire ${n.id}`);
  for (const n of flow.filter(n=>n.type==='function' && n.z===tab)) new Function('msg','node','flow','global','env',n.func);
  const before = new Map(source.map(n=>[n.id,n]));
  return { flow, importNodes:flow.filter(n=>!isDeepStrictEqual(n,before.get(n.id))) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, output] = process.argv.slice(2);
  if (!workspace || !output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('Usage: node scripts/build_organizer_handoff_candidate.mjs <fresh workspace> <new absolute output directory>');
  const verified = verifyWorkspace(workspace, { quiet:true });
  if(verified.sourceSha256 !== SOURCE_SHA) throw new Error('Live source drift: review a fresh baseline first');
  const {flow,importNodes} = buildOrganizerHandoffCandidate(verified.source);
  fs.mkdirSync(output,{recursive:false,mode:0o700});
  for(const [name,value] of [['candidate.json',flow],['import.json',importNodes]]) fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  const report={sourceSha256:SOURCE_SHA,candidateSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'candidate.json'))).digest('hex'),changedNodes:importNodes.map(n=>({id:n.id,name:n.name})),deployed:false};
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(report));
}
