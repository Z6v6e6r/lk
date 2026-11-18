import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { createGamePrivateProjection } from './lib/gamePrivateProjection.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const PREIMAGES = Object.freeze({
  e0d7883bc1a9fa8c: '80d2a509f85c55b7078542036f91ce24511899b47977e57d22177f98f4a56e91',
  organizer_handoff_20260913_patch_check: '5cf17abe97e7a36c474d61390dd7b0ada7baddcdf6c2252c61cca1902c296874',
  organizer_handoff_20260913_patch_ack: '24793e2172df93d0a4d108d111edeafc5a9bea4dba5eddf04b234269c3979b19',
});
const source = read('nodered_games_nodes/fn_patch.js');
const projection = `// BEGIN PRIVATE GAME PROJECTION\n${createGamePrivateProjection.toString()}\n// END PRIVATE GAME PROJECTION\n\n`;
if (!source.includes(projection)) throw Error('Private projection source copy drift');
const restoreStart = source.indexOf('// A public GET is a projection');
const restoreBlock = source.slice(restoreStart, source.indexOf('const reqPathRaw =', restoreStart));
if (restoreStart < 0 || !restoreBlock.includes('GAME_PATCH_PRIVATE_BINDING_UNKNOWN')) throw Error('Restore source block missing');

export const prepareChanges = [
  ['phone: normPhone(p.phone || p.phoneNumber || p.mobile),', 'phone: normPhone(p.phone || p.phoneNorm || p.phoneNumber || p.mobile),'],
  ['const participantPhones = uniq(participants.map((p) => normPhone(p.phone)));', 'const participantPhones = uniq(participants.map((p) => normPhone(p.phone || p.phoneNorm || p.phoneNumber || p.mobile)));'],
  ['const waitlistPhones = uniq(waitlist.map((p) => normPhone(p.phone)));', 'const waitlistPhones = uniq(waitlist.map((p) => normPhone(p.phone || p.phoneNorm || p.phoneNumber || p.mobile)));'],
  ["metadata: isObj(setDoc.metadata) ? setDoc.metadata : (isObj(body.metadata) ? body.metadata : {}),", "metadata: isObj(setDoc.metadata) ? setDoc.metadata : (isObj(body.metadata) ? body.metadata : (privateGame?.metadata ?? {})),"],
  ["const participants = asArray(setDoc.participants || body.participants);", "const participants = asArray(setDoc.participants || body.participants || privateGame?.participants);"],
  ["const waitlist = asArray(setDoc.waitlist || body.waitlist);", "const waitlist = asArray(setDoc.waitlist || body.waitlist || privateGame?.waitlist);"],
  ["  : (isObj(body.metadata?.resultRosterSnapshot) ? body.metadata.resultRosterSnapshot : null);", "  : (isObj(body.metadata?.resultRosterSnapshot) ? body.metadata.resultRosterSnapshot : (isObj(privateGame?.resultRosterSnapshot) ? privateGame.resultRosterSnapshot : null));"],
  ["(Array.isArray(body.participants) ? body.participants : snapshotSeed?.activeRoster)", "(Array.isArray(body.participants) ? body.participants : (privateGame?.participants ?? snapshotSeed?.activeRoster))"],
  ["(Array.isArray(body.waitlist) ? body.waitlist : snapshotSeed?.waitlist)", "(Array.isArray(body.waitlist) ? body.waitlist : (privateGame?.waitlist ?? snapshotSeed?.waitlist))"],
  ["booking: isObj(setDoc.booking) ? setDoc.booking : (isObj(body.booking) ? body.booking : {}),", "booking: isObj(setDoc.booking) ? setDoc.booking : (isObj(body.booking) ? body.booking : (privateGame?.booking ?? {})),"],
  ["invite: isObj(setDoc.invite) ? setDoc.invite : (isObj(body.invite) ? body.invite : {}),", "invite: isObj(setDoc.invite) ? setDoc.invite : (isObj(body.invite) ? body.invite : (privateGame?.invite ?? {})),"],
  ['    organizerPhone,\n    ...asArray(isObj(body.metadata) ? body.metadata.allRelatedPhones : null).map((p) => normPhone(p)),', '    organizerPhone,'],
  ['const uniq = (arr) =>', projection + 'const uniq = (arr) =>'],
  ['const reqPathRaw =', restoreBlock + 'const reqPathRaw ='],
  ['let organizerPhoneForRecalc = null;', 'let organizerPhoneForRecalc = normPhone(\n  msg._organizerGuardSnapshot?.organizer?.phoneNorm || msg._organizerGuardSnapshot?.organizer?.phone,\n);'],
  ['    ...asArray(body.invites).map((it) => normPhone(isObj(it) ? (it.phone || it.phoneNumber) : it)),', '    ...asArray(body.invites).map((it) => normPhone(isObj(it) ? (it.phone || it.phoneNumber) : it)),\n    ...(!hasOwn(body, "invitedPhones") && !hasOwn(body, "invites") ? asArray(privateGame?.invitedPhones).map(normPhone) : []),'],
  ['  setDoc.allRelatedPhones = uniq([\n    organizerPhone,', '  const splitPaymentPhones = asArray((setDoc.metadata ?? body.metadata ?? privateGame?.metadata)?.splitPayment?.payments)\n    .filter((item) => !["CANCEL", "DECLIN", "FAIL", "ERROR", "EXPIRE", "REFUND", "REJECT", "VOID", "CLOSE", "ARCHIVE", "LEFT", "REMOV", "RELEASE"]\n      .some((marker) => String(item?.status || "").toUpperCase().includes(marker)))\n    .map((item) => normPhone(item?.phoneNorm || item?.clientPhoneNorm || item?.phone || item?.clientPhone));\n  setDoc.allRelatedPhones = uniq([\n    organizerPhone,\n    ...splitPaymentPhones,'],
  ['  responsePatch.allRelatedPhones = setDoc.allRelatedPhones;', '  responsePatch.allRelatedPhones = setDoc.allRelatedPhones;\n  const phoneIndexes = { participantPhones, waitlistPhones, allRelatedPhones: setDoc.allRelatedPhones, invitedPhones };\n  for (const [key, value] of Object.entries(phoneIndexes)) {\n    if (isObj(setDoc.metadata) && (key !== "invitedPhones" || hasOwn(setDoc.metadata, key))) setDoc.metadata[key] = value;\n    else if (!isObj(setDoc.metadata) && isObj(privateGame?.metadata) && hasOwn(privateGame.metadata, key)) setDoc[`metadata.${key}`] = value;\n  }'],
  [': (body.organizer || snapshotSeed?.organizer || null),', ': (msg._organizerGuardSnapshot?.organizer || body.organizer || snapshotSeed?.organizer || null),'],
];
export function replaceOnce(value, before, after) {
  if (value.split(before).length !== 2) throw Error('Exact source anchor drift');
  return value.replace(before, after);
}
export function patchPrepareSource(before) {
  return prepareChanges.reduce((value, [oldText, newText]) => replaceOnce(value, oldText, newText), before);
}
export function patchGamePrivateProjectionFlow(input) {
  if (!Array.isArray(input) || new Set(input.map(n => n.id)).size !== input.length) throw Error('Invalid source graph');
  const candidate = structuredClone(input);
  for (const [id, expected] of Object.entries(PREIMAGES)) {
    const nodes = candidate.filter(n => n.id === id);
    if (nodes.length !== 1 || nodes[0].type !== 'function' || sha256(nodes[0].func) !== expected) throw Error(`Function preimage drift: ${id}`);
    nodes[0].func = id === 'e0d7883bc1a9fa8c' ? patchPrepareSource(nodes[0].func)
      : read(`nodered_organizer_handoff_nodes/${id.endsWith('_check') ? 'fn_patch_authority_check' : 'fn_patch_write_ack'}.js`);
    new Function('msg', 'node', 'flow', 'global', 'env', nodes[0].func);
  }
  input.forEach((node, index) => {
    const expected = { ...node, ...(Object.hasOwn(PREIMAGES, node.id) ? { func: candidate[index].func } : {}) };
    if (!isDeepStrictEqual(expected, candidate[index])) throw Error('Foreign node field changed');
  });
  return candidate;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, output] = process.argv.slice(2);
  if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Usage: <fresh private workspace> <new absolute output directory>');
  const verified = verifyWorkspace(workspace, { quiet: true });
  const candidate = patchGamePrivateProjectionFlow(verified.source);
  fs.mkdirSync(output, { mode: 0o700 });
  const bytes = JSON.stringify(candidate, null, 2) + '\n';
  const report = { sourceSha256: verified.sourceSha256, candidateSha256: sha256(bytes), changedNodes: Object.keys(PREIMAGES), changedFields: ['func'], deployed: false, databaseWrites: 0, providerBusinessWrites: 0 };
  for (const [name, value] of [['candidate.flow.json', candidate], ['import.json', candidate.filter(n => Object.hasOwn(PREIMAGES, n.id))], ['report.json', report]]) {
    fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(report));
}
