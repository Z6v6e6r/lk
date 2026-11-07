import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFprCommunityLeague } from '../../src/components/tournaments/fprCommunityLeague.ts';
import { readFprCanonicalStart } from '../../src/components/tournaments/fprCanonicalStart.ts';
import fs from 'node:fs';
import ts from 'typescript';

const snapshot = { source:'CUP_CANONICAL', rows:[{clientId:'p1',ratingNumeric:4.03664,version:'opaque-event-version'}] };
test('FPR uses full-precision CUP level even when Viva and the materialized community disagree',async()=>{
  const result=await loadFprCommunityLeague({communityId:'community',communityName:'Community',players:[{id:'p1',rating:'3.037'}],
    fetchLevels:async()=>snapshot,
    fetch:async period=>({communityId:'community',period,updatedAt:null,items:[{playerId:'p1',rank:1,overallScore:20,currentLevel:2.5}]})});
  assert.equal(result.values.p1.level,'4.03664');assert.equal(result.values.p1.points,'20');
  assert.deepEqual(result.canonicalStart,snapshot);
});
test('missing or failed CUP reads never fall back to Viva, community level, or unrated zero',async()=>{
  for(const fetchLevels of [async()=>({source:'CUP_CANONICAL',rows:[]}),async()=>{throw Error('CUP unavailable');}]){
    await assert.rejects(()=>loadFprCommunityLeague({communityId:'community',communityName:'Community',players:[{id:'p1',rating:'3.037'}],fetchLevels,
      fetch:async period=>({communityId:'community',period,updatedAt:null,items:[]})}));
  }
});
test('canonical batch rejects partial, duplicate, wrong-source and invalid levels',()=>{
  for(const data of [null,{...snapshot,source:'VIVA_NUMERIC'},{...snapshot,rows:[...snapshot.rows,...snapshot.rows]},
    ...[0,8,NaN,'4.03664'].map(ratingNumeric=>({...snapshot,rows:[{...snapshot.rows[0],ratingNumeric}]})),
    {...snapshot,rows:[{...snapshot.rows[0],clientId:'other'}]}, {...snapshot,rows:[{...snapshot.rows[0],version:''}]}]){
    assert.throws(()=>readFprCanonicalStart(['p1'],data));
  }
});
test('actual API create function authenticates FPR while retaining ordinary create behavior',async()=>{
  const file=ts.createSourceFile('apiClient.ts',fs.readFileSync('src/utils/apiClient.ts','utf8'),ts.ScriptTarget.Latest,true);
  const declaration=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='apiCreateAmericanoTournament')!;
  const compiled=ts.transpileModule(declaration.getText(file).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const calls: Array<{auth:boolean;method:string}>=[];
  const create=new Function('request','getServ2Origin',`${compiled}; return apiCreateAmericanoTournament;`)(
    (_url:string,options:{auth:boolean;method:string})=>{calls.push(options);return Promise.resolve({status:200});},()=>'/serv2');
  await create({tournamentType:'fpr_6x25'});await create({tournamentType:'americano_classic'});
  assert.equal(calls[0].auth,true);assert.equal(calls[1].auth,false);assert.equal(calls[0].method,'POST');
});

test('canonical error identifies the roster player without displaying unknown IDs or server payload',async()=>{
 const {formatFprStartError}=await import('../../src/components/tournaments/fprCanonicalStart.ts');
 const players=[{id:'p1',name:'Иван Тестов'}];
 assert.match(formatFprStartError({raw:{error:'FPR_START_HISTORY_INVALID',playerId:'p1'}},players),/Иван Тестов.*История/);
 assert.match(formatFprStartError({raw:JSON.stringify({error:'FPR_START_INVALID_LEVEL',playerId:'p1'})},players),/Иван Тестов.*числовой/);
 assert.equal(formatFprStartError({message:'Retry',raw:{playerId:'unknown',phone:'PRIVATE'}},players),'Retry');
});
