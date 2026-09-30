import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(relativePath, msg) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  return new Function('msg', source)(msg);
}

test('verified game chat reads one extra newest message without changing response order', () => {
  const msg = {
    _chatGet: { gameId: 'game-1', clientId: 'client-1', phone: '79990000001', beforeTs: 500, limit: 2 },
    payload: [{ id: 'game-1', participants: [{ id: 'client-1', phoneNorm: '79990000001', status: 'CONFIRMED' }] }],
  };
  const [queryMsg, rejected] = run('nodered_chat_nodes/fn_chat_get_build_query_secure.js', msg);
  assert.equal(rejected, null);
  assert.deepEqual(queryMsg.payload, [
    { gameId: 'game-1', deleted: { $ne: true }, createdTs: { $lt: 500 } },
    { sort: { createdTs: -1 }, limit: 3 },
  ]);
  queryMsg.payload = [
    { gameId: 'game-1', createdTs: 400, text: 'newest' },
    { gameId: 'game-1', createdTs: 300, text: 'middle' },
    { gameId: 'game-1', createdTs: 200, text: 'oldest' },
  ];
  const [response] = run('nodered_chat_nodes/fn_chat_get_response.js', queryMsg);
  assert.deepEqual(response.payload.messages.map((row) => row.createdTs), [300, 400]);
  assert.equal(response.payload.hasMore, true);
  assert.equal(response.payload.nextBeforeTs, 300);
});

test('support history uses existing createdAt index and retains legacy page semantics', () => {
  const beforeTs = Date.parse('2026-09-30T12:00:00.000Z');
  const msg = { req: { params: { dialogId: 'dialog-1' }, query: { limit: '2', beforeTs: String(beforeTs) } } };
  const [queryMsg, rejected] = run('nodered_support_nodes/fn_support_dialog_messages_prepare.js', msg);
  assert.equal(rejected, null);
  assert.deepEqual(queryMsg.payload, [
    { dialogId: 'dialog-1', deleted: { $ne: true }, createdAt: { $lt: '2026-09-30T12:00:00.000Z' } },
    { sort: { createdAt: -1 }, limit: 3 },
  ]);
  queryMsg.payload = [
    { id: '3', createdAt: '2026-09-30T11:00:00.000Z' },
    { id: '2', createdAt: '2026-09-30T10:00:00.000Z' },
    { id: '1', createdAt: '2026-09-30T09:00:00.000Z' },
  ];
  const [response] = run('nodered_support_nodes/fn_support_dialog_messages_response.js', queryMsg);
  assert.deepEqual(response.payload.messages.map((row) => row.id), ['2', '3']);
  assert.equal(response.payload.hasMore, true);
  assert.equal(response.payload.nextBeforeTs, Date.parse('2026-09-30T10:00:00.000Z'));
});

test('support history rejects an out-of-range cursor before MongoDB', () => {
  const msg = { req: { params: { dialogId: 'dialog-1' }, query: { beforeTs: '1e30' } } };
  const [queryMsg, errorMsg] = run('nodered_support_nodes/fn_support_dialog_messages_prepare.js', msg);
  assert.equal(queryMsg, null);
  assert.equal(errorMsg.statusCode, 400);
});

test('support analytics filters the requested Moscow day by stored createdAt', () => {
  const msg = { req: { query: { date: '2026-09-30' } } };
  const [queryMsg] = run('nodered_support_nodes/fn_support_analytics_daily_prepare.js', msg);
  assert.deepEqual(queryMsg.payload, {
    createdAt: { $gte: '2026-09-29T21:00:00.000Z', $lt: '2026-09-30T21:00:00.000Z' },
    deleted: { $ne: true },
  });
});

test('support analytics rejects an invalid calendar date before MongoDB', () => {
  const msg = { req: { query: { date: '2026-99-99' } } };
  const [queryMsg, errorMsg] = run('nodered_support_nodes/fn_support_analytics_daily_prepare.js', msg);
  assert.equal(queryMsg, null);
  assert.equal(errorMsg.statusCode, 400);
});
