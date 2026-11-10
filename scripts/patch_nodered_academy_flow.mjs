import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { academyTenantRuntime } from './lib/academyTenantBackend.mjs';
import { ACADEMY_TENANT_CONTRACT as contract } from '../src/services/academyTenantContract.ts';

const id = name => crypto.createHash('sha256').update(`academy005JDA/v1/${name}`).digest('hex').slice(0,16);
export function buildAcademyTenantNodes(mongoClientId) {
  if (typeof mongoClientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(mongoClientId)) throw new Error('Explicit Mongo client id is required');
  const tab = id('tab');
  const fn = (name,stage,outputs,wires,action=null) => ({id:id(name),type:'function',z:tab,name:`Academy ${name}`,func:`return (${academyTenantRuntime.toString()})(${JSON.stringify(stage)},msg,env,${JSON.stringify(action)},${JSON.stringify(contract)});`,outputs,noerr:0,initialize:'',finalize:'',libs:[],wires,x:500,y:200});
  const out = id('http-out');
  const nodes=[{id:tab,type:'tab',label:'Academy 005JDA isolated v1',disabled:false,info:'Fixed tenant; isolated collections; provider userinfo and tenant profile verification before data operations.'},
    {id:out,type:'http response',z:tab,name:'Academy response',statusCode:'',headers:{},wires:[],x:1300,y:400}];
  const routes=[['consent','post','auth-consents'],['communities','get','communities'],['register','post','push/register'],['unregister','post','push/unregister'],['events','post','events'],['health','get','health']];
  for(const [action,method,suffix]of routes){
    nodes.push({id:id(`in-${action}`),type:'http in',z:tab,name:`Academy ${action}`,method,url:`${contract.namespace}/${suffix}`,upload:false,swaggerDoc:'',wires:[[id(`prepare-${action}`)]],x:150,y:100});
    nodes.push(fn(`prepare-${action}`,'prepare',2,[[id('userinfo-http')],[out]],action));
    nodes.push({id:id(`options-${action}`),type:'http in',z:tab,name:`Academy OPTIONS ${action}`,method:'options',url:`${contract.namespace}/${suffix}`,upload:false,swaggerDoc:'',wires:[[id('options-prepare')]],x:150,y:600});
  }
  nodes.push(fn('options-prepare','prepare',2,[[],[out]],'options'));
  for(const name of ['userinfo-http','profile-http'])nodes.push({id:id(name),type:'http request',z:tab,name:`Academy verify ${name}`,method:'use',ret:'txt',paytoqs:'ignore',url:'',tls:'',persist:false,proxy:'',insecureHTTPParser:false,authType:'',senderr:true,headers:[],requestTimeout:'5000',wires:[[id(name==='userinfo-http'?'userinfo-verify':'operation')]],x:750,y:200});
  nodes.push(fn('userinfo-verify','userinfo',2,[[id('profile-http')],[out]]));
  const ops=[['consents','updateOne'],['communities','find'],['push-register','updateOne'],['push-unregister','deleteOne'],['analytics','insertOne']];
  nodes.push(fn('operation','operation',6,[...ops.map(([name])=>[id(`mongo-${name}`)]),[out]]));
  for(const [name,operation]of ops){
    const key=name.startsWith('push-')?'push':name;
    nodes.push({id:id(`mongo-${name}`),type:'mongodb4',z:tab,clientNode:mongoClientId,mode:'collection',collection:contract.collections[key],operation,output:'toArray',maxTimeMS:'5000',handleDocId:false,name:`Academy ${name}`,wires:[[id('response')]],x:1000,y:400});
  }
  nodes.push(fn('response','response',1,[[out]]));
  nodes.push({id:id('catch'),type:'catch',z:tab,name:'Academy scoped failure',scope:[id('userinfo-http'),id('profile-http'),...ops.map(([name])=>id(`mongo-${name}`))],uncaught:false,wires:[[id('error')]],x:300,y:700});
  nodes.push(fn('error','error',1,[[out]]));
  routes.forEach(([action],index)=>{
    for(const name of [`in-${action}`,`prepare-${action}`]){const node=nodes.find(n=>n.id===id(name));node.y=100+index*100;node.x=name.startsWith('in-')?150:450;}
    const options=nodes.find(n=>n.id===id(`options-${action}`));options.x=150;options.y=850+index*70;
  });
  const positions={'options-prepare':[450,1000],'userinfo-http':[750,200],'userinfo-verify':[950,200],'profile-http':[1150,200],operation:[1350,200],response:[1750,300],'http-out':[1950,300],catch:[1150,850],error:[1450,850]};
  for(const [name,[x,y]]of Object.entries(positions)){const node=nodes.find(n=>n.id===id(name));node.x=x;node.y=y;}
  ops.forEach(([name],index)=>{const node=nodes.find(n=>n.id===id(`mongo-${name}`));node.x=1550;node.y=100+index*100;});
  return nodes;
}
export function addAcademyTenantFlow(flow,mongoClientId){
  if(!Array.isArray(flow))throw new Error('Flow must be an array');
  if(!flow.some(n=>n.type==='mongodb4-client'&&n.id===mongoClientId))throw new Error('Selected existing Mongo client not found');
  const nodes=buildAcademyTenantNodes(mongoClientId),owned=new Set(nodes.map(n=>n.id));
  const existing=flow.filter(n=>owned.has(n.id));
  if(existing.length){
    if(existing.length!==nodes.length||nodes.some(n=>JSON.stringify(flow.find(x=>x.id===n.id))!==JSON.stringify(n)))throw new Error('Existing academy nodes drifted; refusing to replace them');
    return flow;
  }
  const routes=new Set(nodes.filter(n=>n.type==='http in').map(n=>`${n.method} ${n.url}`));
  if(flow.some(n=>n.type==='http in'&&routes.has(`${n.method} ${n.url}`)))throw new Error('Unmanaged academy route collision');
  return [...flow,...nodes];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [source,output,mongoClientId]=process.argv.slice(2);
  if(!source||!output||!mongoClientId||path.resolve(source)===path.resolve(output))throw new Error('Usage: node --experimental-strip-types scripts/patch_nodered_academy_flow.mjs /private/fresh-flow.json /private/candidate.json EXISTING_MONGO_CLIENT_ID');
  const candidate=addAcademyTenantFlow(JSON.parse(fs.readFileSync(source,'utf8')),mongoClientId);
  fs.writeFileSync(output,JSON.stringify(candidate,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Additive academy candidate written; live deployment was not performed.');
}
