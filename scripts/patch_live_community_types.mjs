import { addTypedCommunityResponseRedaction } from './lib/communityResponseRedaction.mjs';
import { addCommunityRosterWrites } from './lib/communityRosterWrites.mjs';
import { addCommunityPolicyAuth } from './lib/communityPolicyAuth.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function insertOnce(body, anchor, addition, marker) {
  if (body.includes(marker)) return body;
  if (body.split(anchor).length !== 2) throw new Error('COMMUNITY_TYPES_UNREVIEWED_FUNCTION_SHAPE');
  return body.replace(anchor, anchor + addition);
}
/** Focused function-body patch only. No graph regeneration, config edits or deploy. */
export function patchCommunityTypesFlow(input) {
  if (!Array.isArray(input) || new Set(input.map(node => node.id)).size !== input.length) throw new Error('COMMUNITY_TYPES_INVALID_FLOW');
  const flow = structuredClone(input), changes = [];
  const required = new Set(['Build community create docs', 'Prepare community update', 'Use rating snapshot or fallback', 'Prepare communities list query', 'Prepare game station autojoin']);
  for (const node of flow) {
    if (node.type !== 'function' || typeof node.func !== 'string') continue;
    const before = node.func;
    if (node.func.includes('const normalizeCommunityForResponse =')) {
      if (!node.func.includes('const typed =')) {
        node.func = node.func.replace('  const community = isObj(value) ? value : {};', "  const community = isObj(value) ? value : {};\n  const typed = ['STATION','CORPORATE','LEAGUE'].includes(community.communityType);\n  const redact = (item) => typed ? Object.assign({}, buildMember(item, item?.role || 'MEMBER'), { phone: null }) : item;");
        node.func = node.func.replace("  const members = toArray(community.members).map((item) => buildMember(item, item?.role || 'MEMBER'));", "  const members = toArray(community.members).map((item) => redact(buildMember(item, item?.role || 'MEMBER')));");
        node.func = node.func.replace("  const pendingMembers = toArray(community.pendingMembers).map((item) => buildMember(item, 'MEMBER'));", "  const pendingMembers = toArray(community.pendingMembers).map((item) => redact(buildMember(item, 'MEMBER')));");
        node.func = node.func.replace('  const bannedMembers = toArray(community.bannedMembers);', '  const bannedMembers = toArray(community.bannedMembers).map(redact);');
        node.func = insertOnce(node.func, 'const resolveCommunityViewerMembership = (community, clientId, phone) => {', "\n  if (['STATION','CORPORATE','LEAGUE'].includes(community?.communityType) && !msg._verifiedCommunityActor) return { status: null, member: null };", "community?.communityType) && !msg._verifiedCommunityActor");
      }
      node.func = insertOnce(node.func, "    name: toStr(community.name || community.title) || 'Сообщество',", "\n    communityType: ['STATION', 'CORPORATE', 'LEAGUE'].includes(community.communityType) ? community.communityType : 'FRIENDS',\n    typeSettings: isObj(community.typeSettings) ? community.typeSettings : {},\n    typeSettingsRevision: Number(community.typeSettingsRevision) || 0,", 'communityType: [');
    }
    if (node.name === 'Build communities list response' && !node.func.includes(": rows.filter(item => !['STATION'")) {
      node.func = node.func.replace('  : rows;', "  : rows.filter(item => !['STATION','CORPORATE','LEAGUE'].includes(item.communityType) || canListCommunityForViewer(item, ctx.clientId, ctx.phone));");
    }
    if (node.name === 'Build feed query') node.func = node.func.replace("kind: { $in: ['PHOTO', 'GAME', 'TOURNAMENT'] }", "kind: { $in: ['PHOTO', 'GAME', 'TOURNAMENT', 'TRAINING', 'EVENT'] }");
    if (required.has(node.name)) {
      required.delete(node.name);
      if (node.name === 'Build community create docs' || node.name === 'Prepare community update') {
        const outputs = node.name === 'Build community create docs' ? '[null, null, null, null, denied, denied]' : '[null, denied, denied]';
        node.func = insertOnce(node.func, 'const body = isObj(msg.payload) ? msg.payload : {};', "\nif ('communityType' in body || 'typeSettings' in body) {\n  const denied = withJson(msg, 403, { error: 'COMMUNITY_POLICY_CUP_ONLY' });\n  return " + outputs + ';\n}', 'COMMUNITY_POLICY_CUP_ONLY');
      } else if (node.name === 'Use rating snapshot or fallback') {
        node.func = insertOnce(node.func, '    rows: snapshotRows,', '\n    leagueTables: toArray(snapshot.leagueTables).map((table) => ({ id: table.id, name: table.name, rows: toArray(table.rows) })),', 'leagueTables:');
      } else if (node.name === 'Prepare communities list query') {
        node.func = insertOnce(node.func, 'const summaryProjection = {', '\n  communityType: 1,\n  typeSettings: 1,\n  typeSettingsRevision: 1,', '  communityType: 1,');
      } else if (node.name === 'Prepare game station autojoin') {
        if (Number(node.outputs) !== 2) throw new Error('COMMUNITY_TYPES_AUTOJOIN_OUTPUTS_DRIFT');
        node.func = fs.readFileSync(path.join(root, 'scripts/nodered_games_nodes/fn_autojoin_prepare.js'), 'utf8');
      }
    }
    if (node.func !== before) {
      new vm.Script('(function(msg, node, context, flow, global, env) {\n' + node.func + '\n})');
      changes.push({ id: node.id, name: node.name, beforeSha256: digest(before), afterSha256: digest(node.func) });
    }
  }
  if (required.size) throw new Error('COMMUNITY_TYPES_REQUIRED_NODES_MISSING: ' + [...required].join(', '));
  const authenticated = addTypedCommunityResponseRedaction(addCommunityRosterWrites(addCommunityPolicyAuth(flow)));
  const beforeById = new Map(input.map(node => [node.id, node]));
  const completeChanges = authenticated.flatMap(node => {
    const before = beforeById.get(node.id);
    if (before && JSON.stringify(before) === JSON.stringify(node)) return [];
    return [{ id: node.id, name: node.name || node.type, kind: before ? 'updated' : 'added',
      beforeSha256: before ? digest(JSON.stringify(before)) : null, afterSha256: digest(JSON.stringify(node)) }];
  });
  return { flow: authenticated, changes: completeChanges };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), input = args[args.indexOf('--input') + 1], output = args[args.indexOf('--out') + 1];
  if (!args.includes('--input') || !args.includes('--out') || !input || !output) throw new Error('Use --input /external/live-preimage.json --out /external/candidate.json');
  const source = path.resolve(input), target = path.resolve(output);
  if ([source, target].some(value => value === root || value.startsWith(root + path.sep)) || source === target) throw new Error('COMMUNITY_TYPES_EXTERNAL_WORKSPACE_REQUIRED');
  const result = patchCommunityTypesFlow(JSON.parse(fs.readFileSync(source, 'utf8')));
  fs.writeFileSync(target, JSON.stringify(result.flow, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(target + '.changes.json', JSON.stringify(result.changes, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ changedNodes: result.changes.length, candidateSha256: digest(fs.readFileSync(target)), deployed: false }));
}
