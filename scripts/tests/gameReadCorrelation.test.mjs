import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import * as core from '../../src/utils/errorDiagnosticsCore.mjs';

const origin = 'https://primary.invalid';
const build = 'b'.repeat(40);
const id = randomUUID();
function load(source, globals = {}, mocks = {}) {
  const exports = {};
  const compiled = ts.transpileModule(source.replaceAll('import.meta.env', '__env'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ exports, require: key => { assert.ok(key in mocks, key); return mocks[key]; }, Headers, URL, FormData, performance, setTimeout, clearTimeout, ...globals });
  vm.runInContext(compiled, context); return { exports, context };
}
function correlation(enabled = 'true', callerBuild = () => build) {
  return load(fs.readFileSync('src/utils/gameReadCorrelation.ts', 'utf8'), { __env: enabled === null ? {} : { VITE_GAME_READ_DIAGNOSTICS: enabled } }, {
    '../consts/api_config': { SERV2: origin, SERV2_FALLBACK: 'https://reserve.invalid' }, './errorDiagnostics': { callerBuild },
  }).exports.correlateGameReadRequest;
}
test('opt-in correlates exactly the two reads on owned origins, preserving URL, auth and cache semantics', () => {
  for (const host of [origin, 'https://reserve.invalid']) for (const suffix of ['', '/result/state']) {
    const headers = new Headers({ Authorization: 'PRIVATE-AUTH', 'If-None-Match': 'fixture-etag', 'X-LK-Client-Request-ID': 'forged' });
    assert.equal(correlation()(headers, `${host}/lk/games/fixture-game${suffix}?phone=PRIVATE-QUERY`, 'GET', id), true);
    assert.equal(headers.get('X-LK-Client-Request-ID'), id);
    assert.equal(headers.get('X-LK-Client-Build'), build);
    assert.equal(headers.get('Authorization'), 'PRIVATE-AUTH'); assert.equal(headers.get('If-None-Match'), 'fixture-etag');
  }
});
test('disabled, external, list/action, malformed and missing-randomness requests get no correlation headers', () => {
  const cases = [
    [correlation('false'), `${origin}/lk/games/fixture`, 'GET', id],
    [correlation(null), `${origin}/lk/games/fixture`, 'GET', id],
    [correlation(), 'https://provider.invalid/lk/games/fixture', 'GET', id],
    [correlation(), 'https://primary.invalid.evil.invalid/lk/games/fixture', 'GET', id],
    [correlation(), ['https://user:PRIVATE','primary.invalid/lk/games/fixture'].join('@'), 'GET', id],
    ...['POST','PATCH','DELETE','OPTIONS','HEAD'].map(method => [correlation(), `${origin}/lk/games/fixture`, method, id]),
    ...['available','by-phone','live-ratings','records','split','payment','confirm','health','fixture/join','fixture/result/submit','a%2Fb'].map(path => [correlation(), `${origin}/lk/games/${path}`, 'GET', id]),
    [correlation(), `${origin}/lk/games/fixture`, 'GET', `${id}, ${id}`],
  ];
  for (const [apply,url,method,requestId] of cases) {
    const headers = new Headers({ 'X-LK-Client-Request-ID': 'PRIVATE-SENTINEL', 'X-LK-Client-Build': 'PRIVATE-SENTINEL', Accept: 'application/json' });
    assert.equal(apply(headers,url,method,requestId),false,`${url} ${method}`);
    assert.equal(headers.has('X-LK-Client-Request-ID'),false); assert.equal(headers.has('X-LK-Client-Build'),false);
    assert.equal(headers.get('Accept'),'application/json');
  }
  const headers = new Headers();assert.equal(correlation()(headers,`${origin}/lk/games/fixture`,'GET'),false);
  const unknown = new Headers();correlation('true',()=> 'PRIVATE-SENTINEL')(unknown,`${origin}/lk/games/fixture`,'GET',id);
  assert.equal(unknown.get('X-LK-Client-Build'),'UNKNOWN');
  const failed = new Headers();assert.equal(correlation('true',()=>{throw Error('private');})(failed,`${origin}/lk/games/fixture`,'GET',id),false);
  assert.equal([...failed].length,0);
});

function transport({ statuses = [503,200], error, signal, unavailableRandom = false } = {}) {
  const source = fs.readFileSync('src/utils/apiClient.ts','utf8');
  const parsed = ts.createSourceFile('apiClient.ts',source,ts.ScriptTarget.Latest,true);
  const snippets = ['rawRequest','withRetry'].map(name => parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(parsed)).join('\n');
  const calls=[],events=[];
  const {context}=load(snippets,{ API_BASE:origin, Response, UUID:core.UUID, diagnosticId:()=>{if(unavailableRandom)throw Error('crypto');return randomUUID();},
    requestChangesSubscriptions:()=>false,invalidateSubscriptionSnapshot:()=>{},readAuthToken:()=> 'PRIVATE-AUTH',
    correlateGameReadRequest:correlation(), callerBuild:()=>build,routeTemplate:core.routeTemplate,
    abortCause:s=>s?.aborted&&['deadline','scope_disposed','explicit_cancel'].includes(s.reason)?s.reason:'unknown',
    window:{location:{href:'https://page.invalid'}},isLkIdleRequestPausedError:()=>false,
    trackClientError:(_source,_error,context)=>events.push(context),isRecord:v=>v&&typeof v==='object',pickString:()=>null,
    fetch:async(url,options)=>{calls.push({url,options});if(error)throw error;
      const status=statuses[Math.min(calls.length-1,statuses.length-1)];return new Response(status===304?null:JSON.stringify({id:'fixture-game'}),{status,headers:{'Content-Type':'application/json'}});},
  });
  return {calls,events,run:()=>context.withRetry(()=>context.rawRequest('/lk/games/PRIVATE-SENTINEL/result/state?phone=PRIVATE-QUERY',{method:'GET',signal}),{retries:1,baseDelayMs:0,nonRetryableStatuses:[404]})};
}
test('real rawRequest/retry have distinct per-attempt IDs and correlate a safe client error, 404 remains terminal', async()=>{
  const h=transport();assert.equal((await h.run()).status,200);assert.equal(h.calls.length,2);
  const ids=h.calls.map(r=>r.options.headers.get('X-LK-Client-Request-ID'));assert.notEqual(ids[0],ids[1]);assert.ok(ids.every(v=>core.UUID.test(v)));
  assert.equal(h.events[0].requestId,ids[0]);assert.equal(h.events[0].callerBuild,build);assert.equal(h.events[0].correlationAttached,true);
  assert.equal(h.events[0].routeTemplate,'/lk/games/:gameId/result/state');
  assert.ok(!JSON.stringify(h.events).includes('PRIVATE'));assert.ok(h.calls.every(r=>r.url.endsWith('?phone=PRIVATE-QUERY')));
  for(const status of [200,304,404]) {const read=transport({statuses:[status]});assert.equal((await read.run()).status,status);assert.equal(read.calls.length,1);}
});
test('labelled cancellations remain labelled; network/unlabelled cancellation unknown; original signals unchanged', async()=>{
  for(const reason of ['deadline','scope_disposed','explicit_cancel','PRIVATE-REASON',undefined]) {
    const c=new AbortController();c.abort(reason);const h=transport({error:Error('PRIVATE-ERROR'),signal:c.signal});await h.run();
    assert.equal(h.events[0].abortCause,['deadline','scope_disposed','explicit_cancel'].includes(reason)?reason:'unknown');
    assert.equal(h.calls[0].options.signal,c.signal);assert.equal(h.events[0].requestId,h.calls[0].options.headers.get('X-LK-Client-Request-ID'));
    assert.ok(!JSON.stringify(h.events).includes('PRIVATE'));
  }
  const noCrypto=transport({unavailableRandom:true,statuses:[200]});assert.equal((await noCrypto.run()).status,200);
  assert.equal(noCrypto.calls[0].options.headers.has('X-LK-Client-Request-ID'),false);
});
test('safe schema retains correlation marker/build/abort reason and masks the result-state target',()=>{
  const event=core.sanitizeEvent({schemaVersion:1,diagnosticEventId:randomUUID(),requestId:id,eventKind:'client_error',source:'browser',
    routeTemplate:core.routeTemplate('/lk/games/PRIVATE-GAME/result/state?phone=PRIVATE-PHONE'),method:'GET',stage:'api_request',
    callerBuild:build,correlationAttached:true,abortCause:'scope_disposed',url:'PRIVATE-URL',sessionId:'PRIVATE-SESSION',error:'PRIVATE-ERROR'});
  assert.equal(event.routeTemplate,'/lk/games/:gameId/result/state');assert.equal(event.correlationAttached,true);
  assert.equal(event.abortCause,'scope_disposed');assert.ok(!JSON.stringify(event).includes('PRIVATE'));
});
