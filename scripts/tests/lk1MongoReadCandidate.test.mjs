import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildReadCandidate } from '../prepare_lk1_mongo_read_candidate.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('candidate changes only guarded function bodies and keeps the flow graph', () => {
  const target = {
    id: 'query', tabId: 'tab', tabLabel: 'LK Support', name: 'Query', file: 'query.js',
    preimageSha256: sha256('old query'), outputs: 1, wires: [['mongo']],
    mongoId: 'mongo', collection: 'support_messages',
  };
  const flow = [
    { id: 'tab', type: 'tab', label: 'LK Support', disabled: false },
    { id: 'query', type: 'function', z: 'tab', name: 'Query', outputs: 1, wires: [['mongo']], func: 'old query' },
    { id: 'mongo', type: 'mongodb4', z: 'tab', operation: 'find', collection: 'support_messages', clientNode: '4e820638cc39c730', wires: [['response']] },
    { id: 'response', type: 'http response', z: 'tab', wires: [] },
  ];
  const before = structuredClone(flow);
  const { candidate, changes } = buildReadCandidate(flow, { 'query.js': 'new query\n' }, [target]);
  assert.deepEqual(flow, before);
  assert.equal(candidate[1].func, 'new query');
  assert.deepEqual(candidate.filter((node) => node.id !== 'query'), flow.filter((node) => node.id !== 'query'));
  assert.deepEqual(changes.map((change) => change.id), ['query']);
  assert.throws(() => buildReadCandidate([{ ...flow[0], disabled: true }, ...flow.slice(1)], { 'query.js': 'new query' }, [target]), /TARGET_TAB_MISMATCH/u);
  assert.throws(() => buildReadCandidate([{ ...flow[0] }, { ...flow[1], func: 'drifted' }, ...flow.slice(2)], { 'query.js': 'new query' }, [target]), /TARGET_FUNCTION_PREIMAGE_MISMATCH/u);
});
