import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, IDS, hash, buildRepeatedBookingLeaveCandidate as build } from '../prepare_repeated_booking_leave_candidate.mjs';
const pins = TARGETS.map(t => ({ ...t, beforeSha256: hash('return msg;') }));
const fixture = () => [
  ...pins.map(t => ({ id: t.id, z: 'games', type: 'function', func: 'return msg;', outputs: t.id === IDS.router ? 5 : 1,
    wires: Array.from({length: t.id === IDS.router ? 5 : 1}, () => []), custom: 'preserved' })),
  { id: IDS.update, z: 'games', type: 'mongodb4', operation: 'updateOne', collection: 'lk_game_leave_operations', server: 'db-config', wires: [[]] },
  { id: IDS.find, z: 'games', type: 'mongodb4', operation: 'find', collection: 'lk_game_leave_operations', server: 'db-config', wires: [[IDS.route]] },
  { id: IDS.response, z: 'games', type: 'http response', wires: [] },
  { id: 'unrelated', type: 'tab', label: 'preserve' }
];
test('candidate binds through acknowledged persistence and reread before router resumes', () => {
  const source = fixture(); const before = structuredClone(source); const result = build(source, pins);
  assert.deepEqual(source, before);
  const get = id => result.find(n => n.id === id);
  assert.equal(result.length, source.length + 4);
  assert.deepEqual(get(IDS.router).wires[5], [IDS.bind]);
  assert.deepEqual(get(IDS.bind).wires, [[IDS.persist], [IDS.response]]);
  assert.deepEqual(get(IDS.persist).wires, [[IDS.ack]]);
  assert.equal(get(IDS.persist).server, 'db-config');
  assert.deepEqual(get(IDS.ack).wires, [[IDS.find], [IDS.response]]);
  assert.deepEqual(get(IDS.caught).scope, [IDS.persist]);
  assert.deepEqual(get('unrelated'), before.at(-1));
  assert.deepEqual(get(IDS.router).wires.slice(0, 5), before[5].wires);
});
test('candidate rejects source drift and cannot use synthetic fixture with release pins', () => {
  assert.throws(() => build(fixture()), /Preimage drift/);
  for (const mutate of [
    f => { f[0].func = 'changed'; },
    f => { f.find(n => n.id === IDS.router).outputs = 4; },
    f => { f.find(n => n.id === IDS.update).collection = 'games'; },
    f => { f.push({...f[0]}); },
    f => { delete f.find(n => n.id === IDS.find).server; },
    f => { f.find(n => n.id === IDS.find).server = 'different'; },
    f => { f.find(n => n.id === IDS.find).wires = [[]]; },
    f => { f.find(n => n.id === IDS.find).wires = [[IDS.router]]; },
    f => { f[0].wires = [['missing']]; },
    f => { f.push({id: IDS.bind}); }
  ]) { const f = fixture(); mutate(f); assert.throws(() => build(f, pins)); }
});
