const ctx = msg._fprStart;
const fail = (error, playerId) => {
  delete msg._fprStart; delete msg.headers;
  msg.statusCode = error === 'FPR_START_BUSY' ? 503 : 409;
  msg.headers = { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' };
  msg.payload = { error, ...(Array.isArray(ctx?.ids) && ctx.ids.includes(playerId) ? { playerId } : {}),
    message: error === 'FPR_START_BUSY' ? 'ЦУП занят плановым расчётом. Повторите загрузку через несколько секунд.' : 'Не удалось подготовить стартовый рейтинг участника. Повторите загрузку.' };
  node.send([null,msg]); node.done();
};
if (!ctx || typeof ctx.actorId !== 'string' || !ctx.actorId) { fail('FPR_START_UNAVAILABLE'); return; }
let child;
try { child = nodeChildProcess.spawn('/usr/bin/node', ['/opt/padlhub-fpr-start/current/bootstrap.mjs'],
  { stdio:['pipe','pipe','pipe'], env:{PATH:'/usr/bin:/bin',NODE_ENV:'production'} }); }
catch { fail('FPR_START_UNAVAILABLE'); return; }
let output='', bytes=0, finished=false;
const timer=setTimeout(()=>child.kill('SIGTERM'),25000);
child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)child.kill('SIGTERM');else output+=chunk.toString('utf8');});
child.stderr.on('data',()=>{});
child.on('error',()=>{if(finished)return;finished=true;clearTimeout(timer);fail('FPR_START_UNAVAILABLE');});
child.on('close',()=>{
  if(finished)return;finished=true;clearTimeout(timer);
  let result;try {result=JSON.parse(output);} catch {fail('FPR_START_UNAVAILABLE');return;}
  if(!result?.ok||!Array.isArray(result.states)){fail(/^FPR_START_[A-Z_]+$/.test(result?.error)?result.error:'FPR_START_UNAVAILABLE',result?.playerId);return;}
  msg.payload=result.states;
  node.send([msg,null]);node.done();
});
child.stdin.on('error',()=>{});
child.stdin.end(JSON.stringify({clientIds:ctx.ids,actorId:ctx.actorId}));
return;
