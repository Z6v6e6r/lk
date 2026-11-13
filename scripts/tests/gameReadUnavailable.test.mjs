import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const parse = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const api = parse('src/utils/apiClient.ts');
const page = parse('src/components/games/GamesPage.tsx');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
const walk = (node, predicate, found = []) => { if (predicate(node)) found.push(node); ts.forEachChild(node, child => { walk(child, predicate, found); }); return found; };
const execute = (node, scope, source = page) => new Function(...Object.keys(scope), compile(`return (${node.getText(source)});`))(...Object.values(scope));
const effects = walk(page, n => ts.isCallExpression(n) && n.expression.getText(page) === 'useEffect');
const effect = text => {
  const found = effects.filter(n => n.arguments[0].getText(page).includes(text));
  assert.equal(found.length, 1, text);
  return found[0].arguments[0];
};
const functions = ['request', 'rawRequest', 'withRetry', 'executeRequestWithResolvedBaseUrls', 'resolveRequestBaseUrlCandidates',
  'dedupeBaseUrls', 'isServ2LkReadRequest', 'getRequestMethod', 'requestWithBaseUrlFallback', 'createDelayedFallbackRequest',
  'shouldFallback', 'isSuccessfulRequestResult', 'apiFetchPadelGameRecord', 'requestPadelGameResultAction', 'apiFetchPadelGameResultState'];
const actualApi = compile(functions.map(name => {
  const fn = api.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, name); return fn.getText(api).replace(/^export\s+/, '');
}).join('\n'));
function client({ statuses = [404], networkError = false, fallback = false } = {}) {
  const calls = [], delays = [];
  const context = vm.createContext({
    Headers, Response, FormData, URL, URLSearchParams, performance,
    API_BASE:'https://fixture.invalid',SERV2:'https://fixture.invalid',SERV2_FALLBACK:'https://fallback.invalid',
    getServ2Origin:()=>'https://fixture.invalid',
    resolveLkApiBaseUrlCandidates:()=>fallback ? ['https://fixture.invalid','https://fallback.invalid'] : ['https://fixture.invalid'],
    resolveLkApiFallbackTimeoutMs:()=>25,
    resolveRequestCacheConfig:()=>null, readAuthToken:()=>'fixture-session', requestChangesSubscriptions:()=>false,
    invalidateSubscriptionSnapshot:()=>{}, isLkIdleRequestPausedError:()=>false, trackClientError:()=>{}, captureSplitLeaveInitiator:()=>{},
    UUID:/^fixture-id$/,diagnosticId:()=>'fixture-id',abortCause:()=>null,
    isRecord:v=>v && typeof v==='object',pickString:(v,keys)=>keys.map(k=>v[k]).find(v=>typeof v==='string'),
    normalizePadelGameRecord:v=>v?.id ? v : null,normalizePadelGameResultActionResponse:v=>v,
    setTimeout:(fn,delay)=>{delays.push(delay);return setTimeout(fn,delay===300 ? 0 : delay);},clearTimeout,
    fetch:async(url,options)=>{
      calls.push({url,options}); if(networkError) throw Error('fixture network error');
      const status=statuses[Math.min(calls.length-1,statuses.length-1)];
      return new Response(status===304 ? null : JSON.stringify(status===200 ? {id:'fixture-game'} : {error:'Game not found'}),{status,headers:{'Content-Type':'application/json'}});
    },
  });
  vm.runInContext(actualApi,context);
  return {game:context.apiFetchPadelGameRecord,state:context.apiFetchPadelGameResultState,action:context.requestPadelGameResultAction,
    request:context.request,calls,delays};
}
for(const read of ['game','state']) {
  test(`${read}: 404 is one request, no fallback, stable message and original status/body`, async()=>{
    const h=client({fallback:true}); const result=await h[read]('fixture-game');
    assert.equal(h.calls.length,1); assert.equal(result.status,404);assert.equal(result.error.message,'Игра недоступна');
    assert.equal(result.error.raw.error,'Game not found');assert.ok(!h.delays.includes(300));
    assert.ok(!('nonRetryableStatuses' in h.calls[0].options),'retry policy must not leak into fetch');
  });
  test(`${read}: transient 503/network errors still retry, success remains usable`,async()=>{
    for(const options of [{statuses:[503,200]},{networkError:true}]) {
      const h=client(options);const result=await h[read]('fixture-game');assert.equal(h.calls.length,2);
      assert.equal(h.delays[0],300);assert.equal(result.status,options.networkError ? null : 200);
    }
  });
}
test('successful 200/304 reads and generic writes retain their prior retry policy',async()=>{
  const ok=client({statuses:[200]});assert.equal((await ok.game('fixture-game')).data.id,'fixture-game');assert.equal(ok.calls.length,1);
  const cached=client({statuses:[304]});assert.equal((await cached.request('/lk/games/fixture-game',{method:'GET',retries:1,nonRetryableStatuses:[404]})).status,304);assert.equal(cached.calls.length,1);
  const legacy=client();await legacy.action('fixture-game','confirm',{});assert.equal(legacy.calls.length,2,'write actions do not opt into terminal 404');
});
test('transient primary failure still permits a fallback read',async()=>{
  const h=client({statuses:[503,503,200],fallback:true});const result=await h.game('fixture-game');
  assert.equal(result.status,200);assert.equal(h.calls.length,3);assert.match(h.calls[2].url,/fallback\.invalid/);
});

const flush = async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function lifecycle({step='details',id='fixture-game',status=404,deferred=false}={}) {
  const timers=new Map(),listeners=new Set(),calls=[],transitions=[],errors=[];let timerId=0,resolve;
  const result={status,data:status===200 ? {} : null,error:status===200 ? null : {message:'fixture error'}};
  const scope={step,gameRecordId:id,profilePhoneNorm:'synthetic-phone',profilePhone:'synthetic-phone',canCurrentUserFetchResultState:true,
    detailsMatchResultRatingWork:{status:'QUEUED'},resultStateFetchKeyRef:{current:null},isReadOnlySyntheticGame:false,
    MATCH_RESULT_RATING_POLL_MS:12000,MATCH_RESULT_RATING_RETRYABLE_POLL_MS:30000,
    apiFetchPadelGameResultState:()=>{calls.push('state');return deferred ? new Promise(r=>{resolve=r;}) : Promise.resolve(result);},
    apiFetchPadelGameRecord:()=>{calls.push('game');return deferred ? new Promise(r=>{resolve=r;}) : Promise.resolve(result);},
    applyMatchResultActionResponse:()=>{calls.push('apply');},setCheckingGameStatus:()=>{},setGameRecordError:v=>errors.push(v),
    setStep:v=>transitions.push(v),
    window:{setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:i=>timers.delete(i)},
    document:{hidden:false,addEventListener:(_name,fn)=>listeners.add(fn),removeEventListener:(_name,fn)=>listeners.delete(fn)},
  };
  const mark=walk(page,n=>ts.isVariableDeclaration(n)&&n.name.getText(page)==='markGameUnavailable')[0];
  scope.markGameUnavailable=execute(mark.initializer.arguments[0],scope);
  return {scope,timers,listeners,calls,transitions,errors,result,resolve:v=>resolve(v)};
}
const poll=effect('const ratingWorkStatus = detailsMatchResultRatingWork?.status;');
const initial=effect('const fetchKey = `${gameRecordId}:${profilePhoneNorm}`;');
const game=effect('const result = await apiFetchPadelGameRecord(gameRecordId);');
for(const [name,node]of [['initial state',initial],['game',game]]){
  test(`${name}: 404 enters the unavailable screen, stale completion after cleanup is ignored`,async()=>{
    const h=lifecycle();const cleanup=execute(node,h.scope)();await flush();
    assert.deepEqual(h.transitions,['unavailable']);assert.deepEqual(h.errors,['Игра недоступна']);cleanup();
    const stale=lifecycle({deferred:true});const stop=execute(node,stale.scope)();stop();stale.resolve(h.result);await flush();assert.deepEqual(stale.transitions,[]);
  });
}
test('rating poll stops scheduling immediately after 404, including visibility wakeups',async()=>{
  const h=lifecycle();const stop=execute(poll,h.scope)();assert.equal(h.timers.size,1);
  const [id,run]=[...h.timers][0];h.timers.delete(id);run();await flush();
  assert.deepEqual(h.calls,['state']);assert.deepEqual(h.transitions,['unavailable']);assert.equal(h.timers.size,0);
  h.listeners.forEach(fn=>fn());await flush();assert.deepEqual(h.calls,['state']);stop();assert.equal(h.listeners.size,0);
});
test('temporary poll error schedules the next read; closing ignores a late 404',async()=>{
  const h=lifecycle({status:503});const stop=execute(poll,h.scope)();const [id,run]=[...h.timers][0];h.timers.delete(id);run();await flush();
  assert.equal(h.timers.size,1);assert.deepEqual(h.transitions,[]);stop();assert.equal(h.timers.size,0);
  const late=lifecycle({deferred:true});const close=execute(poll,late.scope)();const [key,start]=[...late.timers][0];late.timers.delete(key);start();close();late.resolve({status:404,error:{}});await flush();
  assert.deepEqual(late.transitions,[]);assert.equal(late.timers.size,0);
});
test('terminal screen cannot restart game/state, chat, unread, cleanup, or roster effects',()=>{
  const h=lifecycle({step:'unavailable'});Object.assign(h.scope,{isGameUnavailable:true,subscriptionUsageShadowEnabled:false,activeGameRecord:{id:'fixture-game'},isBookingPresetMode:false});
  for(const node of [initial,poll,game,effect('loadChatMessages("initial")'),effect('await refreshUnreadChats();'),
    effect('splitTimeoutCleanupInFlightRef.current'),effect('if (!detailsNeedsVivaRosterSync) return;')]) {
    assert.equal(execute(node,h.scope)(),undefined);
  }
  assert.deepEqual(h.calls,[]);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});
test('closing resets the state-read guard; a different game or reopened view may read again',async()=>{
  const reset=effect('resultStateFetchKeyRef.current = null;');const h=lifecycle({status:200});
  execute(initial,h.scope)();await flush();assert.deepEqual(h.calls,['state','apply']);
  execute(initial,h.scope)();await flush();assert.equal(h.calls.length,2);
  execute(reset,{...h.scope,step:'unavailable'})();assert.equal(h.scope.resultStateFetchKeyRef.current,null);
  execute(initial,h.scope)();await flush();assert.equal(h.calls.length,4);
  execute(initial,{...h.scope,gameRecordId:'other-fixture-game'})();await flush();assert.equal(h.calls.length,6);
});
test('terminal UI provides an announced message and keyboard-accessible exit without game action controls',()=>{
  const branch=walk(page,n=>ts.isIfStatement(n)&&n.expression.getText(page)==='step === "unavailable"')[0];
  const returned=branch.thenStatement.statements.find(ts.isReturnStatement).expression;
  const markup=renderToStaticMarkup(execute(returned,{React,onBack:()=>{}}));
  assert.match(markup,/Игра недоступна/);assert.match(markup,/role="status"/);assert.match(markup,/<button[^>]*type="button"/);
  assert.equal((markup.match(/<button/g)||[]).length,2);assert.doesNotMatch(markup,/<input|Оплатить|Вступить|Отправить/);
});

test('invite loader clears the stale record on terminal 404 and displays the read error',async()=>{
  const join=parse('src/components/games/GameJoinPage.tsx');
  const loader=walk(join,n=>ts.isVariableDeclaration(n)&&n.name.getText(join)==='loadData')[0];
  const records=[],errors=[];
  const load=execute(loader.initializer.arguments[0],{gameId:'fixture-game',setLoading:()=>{},setError:v=>errors.push(v),
    setProfile:()=>{},setGame:v=>records.push(v),apiFetchProfile:async()=>({data:null}),
    apiFetchPadelGameRecord:async()=>({status:404,data:null,error:{message:'Игра недоступна'}})},join);
  await load();assert.deepEqual(records,[null]);assert.equal(errors.at(-1),'Игра недоступна');
});
