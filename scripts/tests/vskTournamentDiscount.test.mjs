import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareVskTournamentDiscount, VSK_EVALUATORS } from '../prepare_vsk_tournament_discount.mjs';
const anchor='  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {';
const fixture=()=>[...VSK_EVALUATORS.map(id=>({id,type:'function',func:`if (false) {\n${anchor}\n return null; }`,wires:[['preserved']]})),{id:'untouched',type:'inject',payload:'private-fixture'}];
const hash=raw=>createHash('sha256').update(raw).digest('hex');
test('candidate touches only the three evaluator bodies and preserves unrelated state',()=>{
 const before=fixture(),raw=JSON.stringify(before),after=JSON.parse(prepareVskTournamentDiscount(raw,hash(raw)));
 assert.equal(after.length,before.length);
 for(let i=0;i<before.length;i++) {
   if(VSK_EVALUATORS.includes(before[i].id)) {
     assert(after[i].func.includes('lk1-vsk-tournament'));
     assert.deepEqual({...after[i],func:before[i].func},before[i]);
   } else assert.deepEqual(after[i],before[i]);
 }
 assert.throws(()=>prepareVskTournamentDiscount(JSON.stringify(after),hash(JSON.stringify(after))),/Already patched/);
});
test('changed source, missing evaluator and anchor drift refuse candidate',()=>{
 const raw=JSON.stringify(fixture());assert.throws(()=>prepareVskTournamentDiscount(raw,'0'.repeat(64)),/Live source drift/);
 for(const mutate of [f=>f.pop()&&f.shift(),f=>f[0].func='return null;',f=>f.push(f[0])]) {
   const f=fixture();mutate(f);const bad=JSON.stringify(f);assert.throws(()=>prepareVskTournamentDiscount(bad,hash(bad)));
 }
});
