// Read-only provider smoke. Explicitly excludes auth, reservations and payment endpoints.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { arenaData } from '../src/tenant-config.js';
import * as Viva from '../src/viva-booking.js';
const exec = promisify(execFile);
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requests=[];
globalThis.fetch=async (url, options={})=>{
 const allowed=/^https:\/\/api\.vivacrm\.ru\/(?:api\/v1\/time\?|end-user\/api\/v[12]\/005JDA\/products\/master-services\/[a-f0-9-]+\/(?:meta$|timeslots$|timeslots\/validate$|price\?))/;
 if(!allowed.test(url))throw Error('Endpoint excluded from read-only smoke');
 const args=['--proxy','socks5h://127.0.0.1:17892','--connect-timeout','10','--max-time','25','-sS','-w','\n%{http_code}','-X',options.method||'GET','-H','Accept: application/json'];
 if(options.body)args.push('-H','Content-Type: application/json','--data-binary',options.body);
 args.push(url);
 const {stdout}=await exec('curl',args,{maxBuffer:8*1024*1024});
 const pos=stdout.lastIndexOf('\n'),status=Number(stdout.slice(pos+1)),body=stdout.slice(0,pos);
 requests.push({url,method:options.method||'GET',status});
 return {ok:status>=200&&status<300,status,json:async()=>JSON.parse(body)};
};
await Viva.syncClock();
const day=Viva.addDays(Viva.moscowDay(),1);
const results=[];
for(const arena of arenaData.arenas){
 try{
  const b=await Viva.settingsFor(arena.viva);
  const raw=await Viva.slotsFor(b,day);
  const intervals=Viva.intervalsFor(raw,b,day,Math.max(60,b.minMinutes));
  const chosen=intervals.find(i=>Viva.timeLabel(i.timeFrom)>='10:00')||intervals[0];
  const quote=chosen?await Viva.quoteFor(b,chosen,Math.max(60,b.minMinutes)):null;
  results.push({arenaId:arena.id,name:arena.name,day,availableIntervals:intervals.length,quote:quote?{timeFrom:quote.timeFrom,timeTo:quote.timeTo,amount:quote.amount,currency:quote.currency}:null,ok:true});
 }catch(error){results.push({arenaId:arena.id,name:arena.name,ok:false,error:error.message});}
 console.log(JSON.stringify(results.at(-1)));
}
fs.writeFileSync(path.join(project,'audit','booking-smoke.json'),JSON.stringify({checkedAt:new Date().toISOString(),tenant:'005JDA',readOnly:true,results,requests},null,2)+'\n');
if(results.some(x=>!x.ok))process.exitCode=1;
