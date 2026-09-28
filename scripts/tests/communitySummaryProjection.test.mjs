import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { synchronizeCommunitySummaryProjection } from '../patch_live_community_summary_projection.mjs';

const generator = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
const prefix = 'const commonHelpers = String.raw`';
const start = generator.indexOf(prefix) + prefix.length;
const end = generator.indexOf('\n`;\n', start);
assert.ok(start >= prefix.length && end > start, 'canonical helpers must be available');
const helpers = new Function(`return String.raw\`${generator.slice(start, end + 1)}\`;`)();
const prepareTail = fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_prepare_tail.js', 'utf8');
const responseTail = fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_response_tail.js', 'utf8');
const prepare = new Function('msg', `${helpers}\n${prepareTail}`);
const respond = new Function('msg', `${helpers}\n${responseTail}`);

function prepareMessage(query = {}) {
  const msg = { req: { query, headers: { host: 'example.test' } } };
  prepare(msg);
  return msg;
}

function summary(rows, identity = {}) {
  const msg = {
    req: { query: { view: 'summary' }, headers: { host: 'example.test' } },
    _communityList: { listMode: 'SUMMARY', clientId: identity.clientId || null, phone: identity.phone || null },
    payload: rows,
  };
  return respond(msg)[0];
}

function row(id, fields = {}) {
  return {
    id,
    visibility: 'OPEN',
    _summaryMemberCount: 0,
    _summaryPendingCount: 0,
    _summaryBannedCount: 0,
    ...fields,
  };
}

test('SUMMARY sends find(filter, options) to mongodb4 and FULL keeps its original filter', () => {
  const publicMsg = prepareMessage({ view: 'summary' });
  assert.ok(Array.isArray(publicMsg.payload));
  const [filter, options] = publicMsg.payload;
  assert.equal(filter.archived.$ne, true);
  assert.equal(filter.$or.length, 1);
  assert.deepEqual(Object.keys(options), ['projection']);
  assert.equal(options.projection.archived, 1);
  assert.equal(options.projection.logoLegacyDataUrl, 1);
  assert.equal(options.projection.members, undefined);
  assert.equal(options.projection.pendingMembers, undefined);
  assert.deepEqual(options.projection._summaryBannedCount.$size.$cond[0], { $isArray: '$bannedMembers' });
  assert.equal(publicMsg.projection, undefined);

  // The installed mongodb4 node calls collection.find(...msg.payload).
  let received;
  const collection = { find(...args) { received = args; return { toArray: () => [] }; } };
  collection.find(...publicMsg.payload).toArray();
  assert.equal(received[0], filter);
  assert.equal(received[1], options);

  const fullMsg = prepareMessage({});
  assert.deepEqual(fullMsg.payload, { archived: { $ne: true } });
  assert.equal(fullMsg.projection, undefined);
});

test('viewer projection retains identifier aliases and formatted or numeric phone variants', () => {
  const phoneDigits = ['7', '999', '123', '45', '67'].join('');
  const localPhone = `8 (${phoneDigits.slice(1, 4)}) ${phoneDigits.slice(4, 7)}-${phoneDigits.slice(7, 9)}-${phoneDigits.slice(9)}`;
  const msg = prepareMessage({ view: 'summary', clientId: 'viewer-1', phone: phoneDigits });
  const [filter, options] = msg.payload;
  assert.equal(filter.$or.length, 3);
  assert.ok(filter.$or[1].members.$elemMatch.$or.some(part => part.id === 'viewer-1'));
  assert.ok(filter.$or[2].pendingMembers.$elemMatch.$or.some(part => part.clientId === 'viewer-1'));
  const identityTerms = options.projection.members.$filter.cond.$or;
  const patterns = identityTerms.map(part => part.$let.in.$or[1].$regexMatch.regex);
  assert.ok(patterns.some(pattern => pattern.test('viewer-1')));
  assert.ok(patterns.some(pattern => pattern.test('8' + phoneDigits.slice(1))));
  assert.ok(patterns.some(pattern => pattern.test(localPhone)));
  assert.deepEqual(options.projection.pendingMembers.$filter.cond.$or, identityTerms);
});

test('conflicting legacy aliases keep the later valid member for response matching', () => {
  const actor = { clientId: 'viewer', phone: '79991234567' };
  const localPhone = `8 (${actor.phone.slice(1, 4)}) ${actor.phone.slice(4, 7)}-${actor.phone.slice(7, 9)}-${actor.phone.slice(9)}`;
  const projection = prepareMessage({ view: 'summary', ...actor }).payload[1].projection;
  const select = (entries, field) => {
    const terms = projection[field].$filter.cond.$or;
    assert.equal(projection[field].$filter.limit, undefined);
    return entries.filter(entry => terms.some(term => {
      const sourceField = term.$let.vars.value.$convert.input.slice('$$candidate.'.length);
      return term.$let.in.$or[1].$regexMatch.regex.test(String(entry[sourceField] ?? ''));
    }));
  };
  const members = select([
    { id: 'other', clientId: 'viewer' },
    { id: 'viewer', role: 'ADMIN' },
    { id: 'phone-viewer', phone: localPhone },
  ], 'members');
  const pendingMembers = select([
    { id: 'other-pending', clientId: 'viewer' },
    { id: 'viewer' },
  ], 'pendingMembers');
  assert.equal(members.length, 3);
  assert.equal(pendingMembers.length, 2);
  const result = summary([row('legacy', {
    visibility: 'CLOSED', members, pendingMembers,
    _summaryMemberCount: 3, _summaryPendingCount: 2,
  })], actor);
  assert.equal(result.payload.total, 1);
  assert.equal(result.payload.communities[0].members[0].role, 'ADMIN');
});

test('public SUMMARY keeps full totals and legacy logo without exposing rosters', () => {
  const result = summary([row('legacy', {
    logo: 'data:image/png;base64,aGVsbG8=',
    memberCount: undefined,
    _summaryMemberCount: 4,
    _summaryPendingCount: 3,
    _summaryBannedCount: 2,
  })]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.total, 1);
  assert.deepEqual(result.payload.connections, []);
  const community = result.payload.communities[0];
  assert.equal(community.memberCount, 4);
  assert.equal(community.pendingCount, 3);
  assert.equal(community.bannedCount, 2);
  assert.deepEqual(community.members, []);
  assert.equal(community.membersLoaded, false);
  assert.equal(community.logoThumbUrl, '/lk/media/community-logo-legacy/legacy/thumb');
  assert.equal(JSON.stringify(community).includes('aGVsbG8='), false);
});

test('closed communities require active or pending viewer membership', () => {
  const actor = { clientId: 'viewer-1', phone: '79991234567' };
  const active = row('active', {
    visibility: 'CLOSED',
    members: [{ id: 'viewer-1', phone: '79991234567', role: 'ADMIN' }],
    pendingMembers: [{ id: 'viewer-1', phone: '79991234567' }],
    _summaryMemberCount: 5,
    _summaryPendingCount: 3,
  });
  const pending = row('pending', {
    visibility: 'CLOSED',
    pendingMembers: [{ clientId: 'viewer-1', phone: '79991234567' }],
    _summaryPendingCount: 2,
  });
  const bannedOnly = row('banned', { visibility: 'CLOSED', _summaryBannedCount: 1 });
  const outsider = row('outsider', { visibility: 'CLOSED', _summaryMemberCount: 6 });
  const openBanned = row('open-banned', { _summaryBannedCount: 1 });
  const result = summary([active, pending, bannedOnly, outsider, openBanned], actor);
  const byId = new Map(result.payload.communities.map(value => [value.id, value]));
  assert.deepEqual([...byId.keys()].sort(), ['active', 'open-banned', 'pending']);
  assert.equal(byId.get('active').members.length, 1);
  assert.equal(byId.get('active').members[0].role, 'ADMIN');
  assert.equal(byId.get('active').memberCount, 5);
  assert.equal(byId.get('active').pendingCount, 3);
  assert.deepEqual(byId.get('pending').members, []);
  assert.equal(byId.get('pending').pendingCount, 2);
  assert.deepEqual(byId.get('open-banned').members, []);
  assert.equal(byId.get('open-banned').bannedCount, 1);
});

test('legacy truthy archive values remain hidden and missing summary totals fail closed', () => {
  const hidden = summary([
    row('archived-string', { archived: 'true' }),
    row('archived-number', { archived: 1 }),
    row('visible'),
  ]);
  assert.deepEqual(hidden.payload.communities.map(value => value.id), ['visible']);
  const missing = summary([row('broken', { _summaryPendingCount: undefined })]);
  assert.equal(missing.statusCode, 500);
  assert.equal(missing.payload.error, 'COMMUNITY_SUMMARY_COUNT_PROJECTION_MISSING');
});

test('FULL retains complete roster and counts without summary scalars', () => {
  const msg = {
    req: { query: {}, headers: { host: 'example.test' } },
    _communityList: { listMode: 'FULL' },
    payload: [{
      id: 'full', visibility: 'CLOSED',
      members: [{ id: 'member-1' }, { id: 'member-2' }],
      pendingMembers: [{ id: 'pending-1' }], bannedMembers: [{ id: 'banned-1' }],
    }],
  };
  respond(msg);
  assert.equal(msg.statusCode, 200);
  assert.equal(msg.payload.communities[0].members.length, 2);
  assert.equal(msg.payload.communities[0].memberCount, 2);
  assert.equal(msg.payload.communities[0].pendingCount, 1);
  assert.equal(msg.payload.communities[0].bannedCount, 1);
  assert.equal(msg.payload.communities[0].membersLoaded, true);
});

test('live candidate rejects a flow preimage mismatch before changing nodes', () => {
  assert.throws(
    () => synchronizeCommunitySummaryProjection([], 'wrong-sha', prepareTail, responseTail),
    /preimage changed/,
  );
});
