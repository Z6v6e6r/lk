import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlan, classifyIndex, LK1_READ_INDEX_SPECS } from '../manage_lk1_read_indexes.mjs';

test('read-index plan only proposes absent indexes and is stable across catalog order', () => {
  const catalogs = {
    chat_messages: [{ name: '_id_', key: { _id: 1 } }],
    support_messages: [{ name: 'support_created_at_v1', key: { createdAt: 1 } }, { name: '_id_', key: { _id: 1 } }],
    lk_community_feed: [{ name: '_id_', key: { _id: 1 } }],
  };
  const plan = buildPlan({ flowSha256: 'a'.repeat(64), catalogs });
  assert.deepEqual(plan.rows.map((row) => row.status), ['missing', 'matching', 'missing']);
  assert.equal(plan.readyForApply, true);
  const reordered = { ...catalogs, support_messages: [...catalogs.support_messages].reverse() };
  assert.equal(buildPlan({ flowSha256: 'a'.repeat(64), catalogs: reordered }).planDigest, plan.planDigest);
});

test('index planner refuses same-name drift and recognizes equivalent existing keys', () => {
  const spec = LK1_READ_INDEX_SPECS[0];
  assert.equal(classifyIndex(spec, [{ name: spec.name, key: { gameId: 1, createdTs: 1 } }]), 'name-conflict');
  assert.equal(classifyIndex(spec, [{ name: 'existing_chat_lookup', key: spec.key }]), 'equivalent');
  assert.equal(classifyIndex(spec, [{ name: 'existing_chat_lookup', key: spec.key, unique: true }]), 'equivalent-conflict');
  const catalogs = Object.fromEntries(LK1_READ_INDEX_SPECS.map((item) => [item.collection, []]));
  catalogs.chat_messages = [{ name: spec.name, key: { gameId: 1 } }];
  assert.equal(buildPlan({ flowSha256: 'a'.repeat(64), catalogs }).readyForApply, false);
});
