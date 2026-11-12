import fs from 'node:fs';

export function buildPreview363BrowserGuard(artifact) {
  let core = fs.readFileSync(new URL('./preview363_body_preserver.mjs', import.meta.url), 'utf8');
  const once = (before, after) => {
    if (core.split(before).length !== 2) throw new Error('P363_GUARD_BUILD_DRIFT');
    core = core.replace(before, after);
  };
  once("import { createHash } from 'node:crypto';", '');
  once("import { applyPreview363Body, PREVIEW363_TARGET } from '../lib/preview363_body_patch.mjs';", '');
  const patchCore = fs.readFileSync(new URL('../lib/preview363_body_patch.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  once("const digest = async value => createHash('sha256').update(value).digest('hex');",
    "const digest = async value => [...new Uint8Array(await view.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2,'0')).join('');");
  once('export const preview363GraphHash', 'const preview363GraphHash');
  once('export async function createPreview363BodyPreserver', 'async function createPreview363BodyPreserver');
  return `(async function installPreview363Guard(seal) {
    'use strict';
    const view = window;
    if (view.top !== view || view.location.origin !== 'http://127.0.0.1:18801') throw new Error('P363_GUARD_ORIGIN');
    const started = performance.now(), remaining = Date.parse(seal.notAfter) - Date.now();
    if (!(remaining > 0 && remaining <= 300000)) throw new Error('P363_GUARD_DEADLINE');
    const expired = () => Date.now() >= Date.parse(seal.notAfter) || performance.now() - started >= remaining;
    ${patchCore}
    ${core}
    const artifact = ${JSON.stringify(artifact)};
    const run = await createPreview363BodyPreserver(seal, artifact), proto = view.XMLHttpRequest.prototype;
    const marker = Symbol.for('padlhub.preview363.native.v1');
    if (Object.hasOwn(proto, marker)) throw new Error('P363_GUARD_INSTALLED');
    // Same-origin storage survives a reload; Web Locks makes the check-and-mark
    // atomic across dedicated tabs. Never remove or reuse a consumed marker.
    if(typeof view.navigator?.locks?.request!=='function'||!view.localStorage)throw new Error('P363_GUARD_DURABLE_CAPABILITY');
    const storageKey='padlhub.preview363.attempt.'+seal.attemptSha256;
    await view.navigator.locks.request(storageKey,{ifAvailable:true},lock=>{
      if(Object.hasOwn(proto,marker))throw new Error('P363_GUARD_INSTALLED');
      if(!lock||view.localStorage.getItem(storageKey)!==null)throw new Error('P363_GUARD_ATTEMPT_CONSUMED');
      view.localStorage.setItem(storageKey,'consumed');
      if(view.localStorage.getItem(storageKey)!=='consumed')throw new Error('P363_GUARD_STORAGE');
      Object.defineProperty(proto,marker,{value:true});
    });
    const nativeOpen=proto.open, nativeHeader=proto.setRequestHeader, nativeSend=proto.send, nativeAbort=proto.abort;
    const states=new WeakMap(); let used=false, audit={status:'ARMED',forwarded:0,rejected:0};
    const isFlows=url=>new URL(url,view.location.href).pathname.replace(/\\/+$/,'')==='/flows';
    const reject=()=>{audit={...audit,status:'BLOCKED',rejected:audit.rejected+1};};
    proto.open=function(method,url,...rest){
      if(typeof method!=='string'||typeof url!=='string')throw new Error('P363_GUARD_OPEN');
      const shape=rest.length===0||(rest.length===1&&rest[0]===true)||(rest.length===3&&rest[0]===true&&rest[1]===undefined&&rest[2]===undefined);
      if(!shape)throw new Error('P363_GUARD_AUTHORITY');
      const old=states.get(this);if(old)old.cancelled=true;
      const record={url:new URL(url,view.location.href).href,method:method.toUpperCase(),flow:isFlows(url),headers:{},cancelled:false,sent:false,invalid:false};
      states.set(this,record);
      try{return Reflect.apply(nativeOpen,this,[method,url,...rest]);}catch(error){record.cancelled=true;throw error;}
    };
    proto.setRequestHeader=function(name,value){
      const s=states.get(this);if(s?.sent)throw new Error('P363_GUARD_HEADERS_LOCKED');
      if(typeof name!=='string')throw new Error('P363_GUARD_HEADER');
      const k=name.toLowerCase();
      // Only these two non-authentication header values are inspected/stored.
      if(s?.flow&&['node-red-api-version','node-red-deployment-type'].includes(k)){
        if(Object.hasOwn(s.headers,k)||typeof value!=='string')s.invalid=true;else s.headers[k]=value;
      }
      return Reflect.apply(nativeHeader,this,[name,value]);
    };
    proto.abort=function(...args){const s=states.get(this);if(s)s.cancelled=true;return Reflect.apply(nativeAbort,this,args);};
    proto.send=function(body){
      const s=states.get(this);if(!s)throw new Error('P363_GUARD_UNTRACKED');
      if(['GET','HEAD'].includes(s.method))return Reflect.apply(nativeSend,this,[body]);
      if(!s.flow){used=true;s.cancelled=true;reject();Reflect.apply(nativeAbort,this,[]);throw new Error('P363_GUARD_UNRELATED_WRITE');}
      if(used||s.sent){reject();throw new Error('P363_GUARD_CONSUMED');}
      used=true;s.sent=true;audit={...audit,status:'VALIDATING'};const xhr=this;
      if(expired()){s.cancelled=true;reject();Reflect.apply(nativeAbort,xhr,[]);throw new Error('P363_GUARD_EXPIRED');}
      void(async()=>{try{
        if(s.invalid||typeof body!=='string'||body.length>16000000)throw new Error('P363_GUARD_BODY');
        const output=await run({request:{url:s.url,method:s.method,apiVersion:s.headers['node-red-api-version'],deploymentType:s.headers['node-red-deployment-type']},postBody:JSON.parse(body)});
        if(states.get(xhr)!==s||s.cancelled||expired())throw new Error('P363_GUARD_CANCELLED');
        Reflect.apply(nativeSend,xhr,[output.postDataText]);audit={...audit,...output.audit,status:'FORWARDED_AWAITING_READBACK',forwarded:1};
      }catch{reject();s.cancelled=true;Reflect.apply(nativeAbort,xhr,[]);}})();
    };
    const nativeFetch=view.fetch;
    if(typeof nativeFetch==='function')view.fetch=function(input,options){
      const url=typeof input==='string'?input:input?.url,method=options?.method??input?.method??'GET';
      if(typeof url!=='string'||typeof method!=='string')return Promise.reject(new Error('P363_GUARD_FETCH'));
      if(!['GET','HEAD'].includes(method.toUpperCase())){used=true;reject();return Promise.reject(new Error('P363_GUARD_FETCH_FORBIDDEN'));}
      return Reflect.apply(nativeFetch,this,[input,options]);
    };
    return Object.freeze({status:()=>structuredClone({...audit,notAfter:seal.notAfter}),
      readback:async nativeResponse=>{
        if(!nativeResponse||typeof nativeResponse.rev!=='string'||!Array.isArray(nativeResponse.flows))throw new Error('P363_READBACK');
        return{origin:view.location.origin,observedAt:new Date().toISOString(),revisionSha256:await digest(nativeResponse.rev),graphSha256:await preview363GraphHash(nativeResponse.flows)};
      }});
  })`;
}

// Uses the editor's own jQuery AJAX setup (and existing auth hooks). Returns no
// native graph/revision/token. No fetch client or copied Authorization header.
export function buildPreview363EditorReadback() {
  return `(async function readPreview363Editor(expectedEditorGraphSha256) {
    const view=window;
    if(view.top!==view||view.location.origin!=='http://127.0.0.1:18801'||typeof view.jQuery?.ajax!=='function')throw new Error('P363_READBACK_ORIGIN');
    const result=await new Promise((resolve,reject)=>view.jQuery.ajax({url:'flows',method:'GET',headers:{'Node-RED-API-Version':'v2'},dataType:'json',timeout:10000,success:resolve,error:()=>reject(new Error('P363_READBACK_REFUSED'))}));
    if(!result||Object.keys(result).sort().join(',')!=='flows,rev'||!Array.isArray(result.flows)||typeof result.rev!=='string'||!result.rev||result.rev.length>512)throw new Error('P363_READBACK_SHAPE');
    const digest=async value=>[...new Uint8Array(await view.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort(compare).map(k=>[k,canonical(value[k])])):value;
    const graph=JSON.stringify([...result.flows].sort((a,b)=>compare(a.id,b.id)).map(canonical));
    if(typeof view.RED?.nodes?.createCompleteNodeSet!=='function'||typeof view.RED.nodes.dirty!=='function'||view.RED.nodes.dirty())throw new Error('P363_EDITOR_NOT_CLEAN');
    const editor=view.RED.nodes.createCompleteNodeSet();
    if(expectedEditorGraphSha256!==undefined&&(typeof expectedEditorGraphSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedEditorGraphSha256)))throw new Error('P363_EDITOR_GRAPH_PIN');
    if(!Array.isArray(editor))throw new Error('P363_EDITOR_SERIALIZATION_DRIFT');
    const editorHash=await digest(JSON.stringify([...editor].sort((a,b)=>compare(a.id,b.id)).map(canonical)));
    if(editorHash!==await digest(graph)&&editorHash!==expectedEditorGraphSha256)throw new Error('P363_EDITOR_SERIALIZATION_DRIFT');
    return{origin:view.location.origin,observedAt:new Date().toISOString(),revisionSha256:await digest(result.rev),graphSha256:await digest(graph)};
  })`;
}
