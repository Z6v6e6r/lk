import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {historyRequest,historyFindArguments,historyLegacyId,historyPage,HISTORY_LEGACY_LIMIT} from '../lib/stationMessageHistory.mjs';
import {historyMessage,historyLegacy} from './helpers/stationHistoryHarness.mjs';

const request=(extra={})=>historyRequest('community',{historyVersion:'2',limit:'2',...extra});
const compare=(a,b)=>b.createdTs-a.createdTs||(a.id<b.id?1:a.id>b.id?-1:0);
function canonicalPage(all,r) { return all.filter(row=>!r.before||row.createdTs<r.before.createdTs||(r.before.publicId&&row.createdTs===r.before.createdTs&&row.id<r.before.publicId)).sort(compare).slice(0,r.limit+1); }
test('frozen synthetic wire fixture is emitted by the real owner helper for the LK2 parser',()=>{
  const page=historyPage(request({limit:'3'}),[historyMessage(3),historyMessage(2),historyMessage(1)],[historyLegacy(1),historyLegacy(2)]);
  assert.equal(JSON.stringify(page,null,2)+'\n',fs.readFileSync(new URL('./fixtures/stationMessageHistoryWire.json',import.meta.url),'utf8'));
});
test('mixed equal-time history walks more than two pages without drops, independent of insertion order',()=>{
  const canonical=Array.from({length:7},(_,i)=>historyMessage(i+1));
  const legacy=Array.from({length:7},(_,i)=>historyLegacy(i+1));
  for(const [c,l]of [[canonical,legacy],[[...canonical].reverse(),[...legacy].reverse()]]) {
    let r=request(),seen=[];
    for(let page=0;page<10;page++) {
      const result=historyPage(r,canonicalPage(c,r),l);
      assert.equal(result.historyVersion,2);assert.equal(result.messages.length,2);
      seen.push(...result.messages.map(row=>row.publicId));
      assert.ok(result.messages.every(row=>row.text==='same body'&&!('id'in row)&&!('_id'in row)));
      if(!result.hasMore){assert.equal(result.nextBefore,null);break;}
      assert.deepEqual(result.nextBefore,{createdTs:result.messages.at(-1).createdTs,publicId:result.messages.at(-1).publicId});
      r=request({beforeTs:String(result.nextBefore.createdTs),beforeId:result.nextBefore.publicId});
    }
    assert.equal(seen.length,14);assert.equal(new Set(seen).size,14);
    assert.deepEqual(seen,[...seen].sort().reverse());
  }
});
test('retry is stable, removed anchor remains usable, time-only migration excludes the complete tie',()=>{
  const rows=[historyMessage(1),historyMessage(2),historyMessage(3),historyMessage(4,999)];
  const first=historyPage(request(),canonicalPage(rows,request()),[]);
  const next=request({beforeTs:String(first.nextBefore.createdTs),beforeId:first.nextBefore.publicId});
  const remaining=rows.filter(row=>row.id!==first.nextBefore.publicId);
  assert.deepEqual(historyPage(next,canonicalPage(remaining,next),[]),historyPage(next,canonicalPage(rows,next),[]));
  const migrated=request({beforeTs:'1000'});
  assert.deepEqual(historyPage(migrated,canonicalPage(rows,migrated),[]).messages.map(row=>row.createdTs),[999]);
});
test('exact bounded Mongo descriptors include canonical keyset, simple collation and finite legacy budget',()=>{
  const r=request({beforeTs:'1000',beforeId:historyMessage(3).id});
  const [filter,options]=historyFindArguments(r);
  assert.deepEqual(filter.$or,[{createdTs:{$lt:1000}},{createdTs:1000,id:{$lt:historyMessage(3).id}}]);
  assert.deepEqual(options.sort,{createdTs:-1,id:-1});assert.equal(options.limit,3);
  assert.deepEqual(options.collation,{locale:'simple'});assert.equal(options.maxTimeMS,3000);
  const [legacy,legacyOptions]=historyFindArguments(r,true);
  assert.deepEqual(legacy,{communityId:'community',stationMessageOwner:{$ne:1},archived:{$ne:true}});
  assert.equal(legacyOptions.limit,2001);assert.equal(legacyOptions.maxTimeMS,3000);
});
test('strict request rejects malformed/unsupported versions, duplicate-shaped values and malformed boundary',()=>{
  for(const q of [{historyVersion:'1'},{historyVersion:['2']},{beforeTs:'0'},{beforeTs:'-1'},{beforeTs:'1.2'},{beforeTs:'8640000000000001'},{beforeId:historyMessage(1).id},{beforeTs:'1000',beforeId:'private-provider-id'},{beforeTs:['1000']},{limit:'51'},{before:'1000'},{cursor:'old-token'},{clientId:['actor']},{phone:'x'.repeat(65)}])assert.throws(()=>request(q));
});
test('legacy UUID projection binds collection/community and typed persisted Mongo identity without exposing it',()=>{
  const objectId={_bsontype:'ObjectId',toHexString:()=> '012345678901234567890123'};
  const id=historyLegacyId('community',{_id:objectId});
  assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(id,historyLegacyId('community',{_id:objectId}));
  assert.notEqual(id,historyLegacyId('other',{_id:objectId}));
  assert.notEqual(id,historyLegacyId('community',{_id:objectId.toHexString()}));
  for(const _id of [null,7,{},''])assert.throws(()=>historyLegacyId('community',{_id}));
});
test('overflow, duplicate identity, invalid canonical order/time and foreign-community rows fail closed',()=>{
  assert.throws(()=>historyPage(request(),[],Array.from({length:HISTORY_LEGACY_LIMIT+1},(_,i)=>historyLegacy(i))),/CAPACITY/);
  assert.equal(historyPage(request(),[],Array.from({length:HISTORY_LEGACY_LIMIT},(_,i)=>historyLegacy(i))).hasMore,true);
  assert.throws(()=>historyPage(request(),[],[historyLegacy(1),historyLegacy(1)]),/COLLISION/);
  assert.throws(()=>historyPage(request(),[historyMessage(1,1001),{...historyMessage(1),_id:'different-row'}],[]),/COLLISION/);
  assert.throws(()=>historyPage(request(),[historyMessage(1),historyMessage(2)],[]),/ORDER/);
  for(const changed of [{createdTs:0},{createdAt:'invalid'},{publicId:historyMessage(2).id},{state:'RESERVED'},{archived:true},{communityId:'foreign'}])assert.throws(()=>historyPage(request(),[{...historyMessage(1),...changed}],[]));
  for(const changed of [{createdAt:undefined},{createdTs:'invalid'},{createdTs:0},{communityId:'foreign'}])assert.throws(()=>historyPage(request(),[],[{...historyLegacy(1),...changed}]));
  assert.throws(()=>historyPage(request({beforeTs:'999',beforeId:historyMessage(3).id}),[historyMessage(1)],[]),/BOUNDARY/);
});
test('late publication is visible to a fresh head walk, not promised by an already passed boundary',()=>{
  const late=historyMessage(8,1000),older=historyMessage(1,999);
  const past=request({beforeTs:'999',beforeId:older.id});
  assert.equal(historyPage(past,canonicalPage([late,older],past),[]).messages.length,0);
  assert.equal(historyPage(request(),canonicalPage([late,older],request()),[]).messages[0].publicId,late.id);
});
