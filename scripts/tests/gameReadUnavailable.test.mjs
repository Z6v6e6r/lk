import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const parse = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const api = parse('src/utils/apiClient.ts');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
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
    invalidateSubscriptionSnapshot:()=>{}, isLkIdleRequestPausedError:()=>false, trackClientError:()=>{}, captureSplitLeaveInitiator:()=>{}, summarizeApiErrorPayload:()=>({}),
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

