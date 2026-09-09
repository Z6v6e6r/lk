import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

// Execute the actual details loader and preview hook with synthetic API responses.
// Extracting the component region keeps unrelated booking/payment effects out of this test.
const source = fs.readFileSync('src/components/games/GamesPage.tsx', 'utf8');
const start = source.indexOf('  const canCurrentUserCheckSplitSubscriptionsInDetails =');
const end = source.indexOf('  const shouldShowCurrentUserLeaveActionInDetails =', start);
assert.ok(start > 0 && end > start);
const fixtureSource = `
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useSubscriptionPricePreview} from './src/components/games/useSubscriptionPricePreview';
import {createJoinSubscriptionPriceTarget} from './src/components/games/subscriptionPricePreview';
const apiFetchSubscriptions = () => globalThis.loadSubscriptions();
const apiFetchSubscriptioName = (...args) => globalThis.loadName(...args);
const toFiniteNumber = value => value == null ? null : Number(value);
const buildComparableIdSet = values => new Set(values);
const filterSplitCategoryCompatibleSubscriptions = values => values;
const normalizeComparableId = value => String(value || '').trim();
const resolveSplitSubscriptionDisplayName = (s,names) => names[s.subscriptionId] || s.name;
const formatSplitSubscriptionValidityLabel = () => 'synthetic expiry';
const SPLIT_OPEN_GAME_EXERCISE_TYPE_ID = 1613, SPLIT_OPEN_GAME_DIRECTION_ID = 4588;
const detailsSplitShareAmount = null;
export function useFixture(props) {
 const {activeGameRecord,profileId,profilePhone,updatingGameMeta,updatingGameRoster,joiningSplitPayment} = props;
 const gameRecordId=activeGameRecord.id, detailsDateKey=activeGameRecord.booking.date;
 const detailsDurationMinutes=activeGameRecord.booking.durationMinutes, detailsSplitPaymentMetadata=activeGameRecord.metadata.splitPayment;
 const isReadOnlySyntheticGame=false,isDetailsSplitPaymentGame=true,isCurrentUserOrganizerByDetails=false;
 const hasCurrentUserIdentityInDetails=Boolean(profileId),isCurrentUserConfirmedParticipant=false,isCurrentUserInWaitlist=false;
 const hasCurrentUserActiveSplitPayment=false,detailsHasFreeSlots=true,subscriptionUsageShadowEnabled=false,step='details';
 const [detailsSplitSubscriptionsLoading,setDetailsSplitSubscriptionsLoading]=useState(false);
 const [detailsSplitSubscriptionsError,setDetailsSplitSubscriptionsError]=useState(null);
 const [detailsSplitSubscriptions,setDetailsSplitSubscriptions]=useState([]);
 const [detailsSplitSubscriptionNamesById,setDetailsSplitSubscriptionNamesById]=useState({});
 const detailsSplitSubscriptionRequestRef=useRef(0);
 ${source.slice(start,end)}
 return {options:detailsSplitSubscriptionOptions,loading:detailsSplitSubscriptionsLoading,error:detailsSplitSubscriptionsError,
 canJoin:canCurrentUserJoinSplitGameInDetails,preview:detailsJoinPricePreview,retry:loadDetailsSplitSubscriptions};
}`;
const bundle = await build({stdin:{contents:fixtureSource,loader:'ts',resolveDir:process.cwd()},bundle:true,write:false,
 format:'cjs',platform:'node',external:['react'],logLevel:'silent',plugins:[{name:'fixture-api',setup(builder){
 builder.onResolve({filter:/utils\/apiClient$/},()=>({path:'api',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const apiFetchSubscriptionPricePreview=(...args)=>globalThis.loadPreview(...args);'}));
}}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness() {
 let cursor=0,dirty=false,effects=[],now=Date.parse('2030-01-01T00:00:00Z'),timerId=0;
 const hooks=[],timers=new Map(),subscriptions=[],names=[],previews=[];
 const same=(a,b)=>a&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const React={
  useState(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:initial};return[hooks[i].value,value=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value;dirty=true;}];},
  useRef(initial){const i=cursor++;if(!hooks[i])hooks[i]={value:{current:initial}};return hooks[i].value;},
  useMemo(factory,deps){const i=cursor++;if(!same(hooks[i]?.deps,deps))hooks[i]={deps,value:factory()};return hooks[i].value;},
  useCallback(callback,deps){return React.useMemo(()=>callback,deps);},
  useEffect(callback,deps){const i=cursor++;if(same(hooks[i]?.deps,deps))return;effects.push(()=>{hooks[i]?.cleanup?.();hooks[i]={deps,cleanup:callback()};});},
 };
 const context=vm.createContext({module:{exports:{}},exports:{},AbortController,
 require:name=>{assert.equal(name,'react');return React;},Date:class extends Date{static now(){return now;}},
 setTimeout:(callback,delay)=>{timers.set(++timerId,{at:now+delay,callback});return timerId;},clearTimeout:id=>timers.delete(id),
 loadSubscriptions:()=>new Promise(resolve=>subscriptions.push({resolve})),
 loadName:id=>{names.push(id);return Promise.resolve({data:{sertName:'Subscription '+id}});},
 loadPreview:(target,ids,signal)=>{previews.push({target,ids,signal});return Promise.resolve({data:{quotes:ids.map(subscriptionId=>({
 subscriptionId,selectionKey:JSON.stringify([target.targetKind,target.gameId,target.startsAt,target.durationMinutes]),
 status:'AVAILABLE',basePriceMinor:37500,amountMinor:26250,freeMinutes:60,paidMinutes:target.durationMinutes-60,reasonCode:'ALLOWED',evaluatedAt:now,expiresAt:now+30000,
 }))}});},
 });
 vm.runInContext(bundle.outputFiles[0].text,context);
 const h={subscriptions,names,previews,result:null,props:{profileId:'actor-a',profilePhone:'synthetic-phone',updatingGameMeta:false,
 updatingGameRoster:false,joiningSplitPayment:false,activeGameRecord:{id:'game-a',booking:{date:'2030-01-01',timeFrom:'07:00',
 studioId:'studio-a',roomId:'room-a',durationMinutes:90},metadata:{splitPayment:{exerciseTypeId:1613,directionId:4588}}}},
 render(){let n=0;do{assert.ok(++n<30,'render loop');cursor=0;dirty=false;effects=[];h.result=context.module.exports.useFixture(h.props);effects.forEach(f=>f());}while(dirty);return h.result;},
 async flush(){for(let i=0;i<3;i++){await tick();h.render();}},
 async resolve(index=subscriptions.length-1,ids=['a','b'],error=null){subscriptions[index].resolve({error,data:error?null:{content:ids.map(subscriptionId=>({subscriptionId,name:subscriptionId}))}});await h.flush();},
 async advance(ms){now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.callback();}await h.flush();},
 unmount(){hooks.forEach(hook=>hook.cleanup?.());},
 };
 h.render();return h;
}

test('new game/metadata object instances do not reload options or reset received prices',async()=>{
 const h=harness();await h.resolve();await h.advance(300);
 assert.equal(h.result.preview.state,'available');const names=h.result.options.map(o=>o.name).join(',');
 for(let i=0;i<5;i++){
  h.props.activeGameRecord={...structuredClone(h.props.activeGameRecord),updatedAt:String(i)};h.render();await h.flush();
  assert.equal(h.result.loading,false);assert.equal(h.result.options.map(o=>o.name).join(','),names);
  assert.equal(h.result.preview.state,'available');
 }
 assert.equal(h.subscriptions.length,1);assert.equal(h.names.length,2);assert.equal(h.previews.length,1);
 h.unmount();
});

test('temporary save/payment states disable joining without hiding or refetching subscriptions',async()=>{
 const h=harness();await h.resolve();await h.advance(300);
 for(const flag of ['updatingGameMeta','updatingGameRoster','joiningSplitPayment']){
  h.props[flag]=true;h.render();assert.equal(h.result.canJoin,false);assert.equal(h.result.loading,false);
  assert.equal(h.result.options.length,2);assert.equal(h.result.preview.state,'available');
  h.props[flag]=false;h.render();assert.equal(h.result.canJoin,true);
 }
 assert.equal(h.subscriptions.length,1);assert.equal(h.previews.length,1);h.unmount();
});

test('material game/account changes reload once and never keep the old price as available',async()=>{
 const changes=[p=>p.profileId='actor-b',p=>p.profilePhone='another-synthetic-phone',p=>p.activeGameRecord.id='game-b',
 p=>p.activeGameRecord.booking.studioId='studio-b',p=>p.activeGameRecord.booking.roomId='room-b',
 p=>p.activeGameRecord.booking.date='2030-01-02',p=>p.activeGameRecord.booking.timeFrom='08:00',
 p=>p.activeGameRecord.booking.durationMinutes=120,p=>p.activeGameRecord.metadata.splitPayment.directionId=999];
 for(const change of changes){const h=harness();await h.resolve();await h.advance(300);
  h.props=structuredClone(h.props);change(h.props);h.render();assert.equal(h.subscriptions.length,2);
  assert.equal(h.result.loading,true);assert.equal(h.result.preview.state,'checking');
  await h.resolve();await h.advance(300);assert.equal(h.result.preview.state,'available');assert.equal(h.previews.length,2);h.unmount();
 }
});

test('superseded account response cannot overwrite the current account options',async()=>{
 const h=harness();h.props={...h.props,profileId:'actor-b'};h.render();
 assert.equal(h.subscriptions.length,2);await h.resolve(1,['current']);await h.resolve(0,['old']);
 assert.equal(h.result.options.map(o=>o.subscriptionId).join(','),'current');h.unmount();
});

test('failed availability waits for explicit retry rather than looping on record updates',async()=>{
 const h=harness();await h.resolve(0,[],{message:'fixture failure'});
 for(let i=0;i<3;i++){h.props.activeGameRecord=structuredClone(h.props.activeGameRecord);h.render();}
 assert.equal(h.subscriptions.length,1);assert.equal(h.result.error,'fixture failure');
 const retry=h.result.retry();assert.equal(h.subscriptions.length,2);await h.resolve(1);await retry;h.render();
 assert.equal(h.result.error,null);assert.equal(h.result.options.length,2);h.unmount();
});

test('manual price refresh keeps subscription list loaded and performs only one new quote',async()=>{
 const h=harness();await h.resolve();await h.advance(300);h.result.preview.refresh();h.render();await h.advance(300);
 assert.equal(h.subscriptions.length,1);assert.equal(h.names.length,2);assert.equal(h.previews.length,2);h.unmount();
});
