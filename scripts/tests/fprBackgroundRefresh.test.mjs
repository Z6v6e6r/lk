import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { createFprState, applyFprCommand, validateFprState } from '../../src/components/tournaments/fpr6x25.ts';

// Execute the actual manager handlers with deferred transports, without production API access.
const source = readFileSync('src/components/tournaments/FprTournamentPanel.tsx', 'utf8');
const send = source.slice(source.indexOf('  const send = async (command: FprCommand)'), source.indexOf('  type Action =', source.indexOf('  const send = async (command: FprCommand)')));
const reload = source.slice(source.indexOf('  const reload = async () => {'), source.indexOf('  const autoReloadRef =', source.indexOf('  const reload = async () => {')));
const compiled = await transform(`export function fixture(initial, apiFetchTournamentHistory, apiUpdateAmericanoResults, validateFprState) {
 const data={tournamentId:initial.tournamentId,params:{fpr6x25:initial}};
 const busyRef={current:false}, reloadControllerRef={current:null}, commandGenerationRef={current:0}, mountedRef={current:true}, stateRef={current:initial};
 let busy=false, reloading=false, error=null, pending=null;
 const setBusy=value=>{busy=value}, setReloading=value=>{reloading=value}, setError=value=>{error=value};
 const pendingKey='test', localStorage={setItem(){},removeItem(){}};
 const setPending=value=>{pending=value}, clearPending=()=>{pending=null};
 const setReason=()=>{}, setFinishConfirmation=()=>{}, preserveLateCommand=()=>{};
 const tournamentResultNeedsReview=()=>false, isRejectedFprCommand=()=>false;
 const applyResponse=next=>{stateRef.current=next};
 const message=e=>e.message, window={setTimeout,clearTimeout};
 ${send}
 ${reload}
 return {reload,send,get state(){return stateRef.current},get busy(){return busy},get reloading(){return reloading},get error(){return error},get pending(){return pending}, unmount(){mountedRef.current=false;commandGenerationRef.current++;reloadControllerRef.current?.abort()}};
}`, {loader:'ts',format:'cjs'});
const module = {exports:{}};
new Function('module','exports',compiled.code)(module,module.exports);
function fixture() {
 const now = '2026-11-10T17:00:00Z';
 let server = createFprState({ tournamentId:'read-race',players:Array.from({length:4},(_,i)=>({id:`p${i}`,name:`Player ${i}`,level:3,leaguePlace:i+1,leaguePoints:100-i})),courts:['Court'],leagueSource:'Synthetic',now,endsAt:'2026-11-10T20:00:00Z',reserveAllowed:false });
 const reads=[];
 const h=module.exports.fixture(server,(_id,options)=>new Promise(resolve=>reads.push({resolve,options})),async payload=>{
  server=applyFprCommand(server,payload.params.fprCommand,now);
  return {status:200,data:{params:{fpr6x25:server}}};
 },validateFprState);
 return {h,reads,reply:(state=server)=>reads.shift().resolve({status:200,data:[{tournamentId:server.tournamentId,params:{fpr6x25:state}}]})};
}

test('background read has its own loading state and does not take the command lock', async()=>{
 const {h,reply}=fixture(); const read=h.reload();
 assert.equal(h.reloading,true); assert.equal(h.busy,false);
 reply(); await read; assert.equal(h.reloading,false);
 assert.match(source,/const disabled = busy \|\| Boolean\(pending\);/);
 assert.doesNotMatch(source,/const disabled = .*reloading/);
});

test('a score command may complete during GET, and its newer state cannot be undone by that GET',async()=>{
 const {h,reads,reply}=fixture(); const before=structuredClone(h.state); const read=h.reload();
 await h.send({action:'score',id:'save',expectedRevision:before.revision,matchId:before.attempts[0].matches[0].id,score1:17,score2:8,confirmed1:true,confirmed2:true,startIfScheduled:true});
 assert.equal(h.state.revision,before.revision+1); assert.equal(reads[0].options.signal.aborted,true);
 reply(before); await read;
 assert.equal(h.state.revision,before.revision+1); assert.equal(h.pending,null);
});

test('older server revisions and another tournament are ignored',async()=>{
 const {h,reply}=fixture();
 const original=structuredClone(h.state);
 const newer=applyFprCommand(h.state,{action:"score",id:"remote",expectedRevision:h.state.revision,matchId:h.state.attempts[0].matches[0].id,score1:18,score2:7,confirmed1:true,confirmed2:true,startIfScheduled:true},"2026-11-10T17:01:00Z");
 let read=h.reload(); reply(newer); await read;
 const old=original;
 read=h.reload();reply(old);await read;assert.equal(h.state.revision,newer.revision);
 const other=structuredClone(newer);other.tournamentId='other';other.revision+=1;
 read=h.reload();reply(other);await read;assert.equal(h.state.tournamentId,'read-race');
});

test('unmount invalidates an outstanding read and prevents data application',async()=>{
 const {h,reply}=fixture();const before=h.state;const next=structuredClone(before);next.revision+=1;
 const read=h.reload();h.unmount();reply(next);await read;assert.equal(h.state,before);
});
