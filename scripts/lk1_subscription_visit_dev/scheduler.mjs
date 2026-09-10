// One in-flight scan for both periodic and manual triggers. Durable job CAS remains
// the authority after crashes; this scheduler never clears locks or retries a PUT.
export function createVisitScheduler({worker,intervalMs=0}) {
  if(typeof worker!=='function'||!Number.isSafeInteger(intervalMs)||(intervalMs!==0&&(intervalMs<1000||intervalMs>60000)))throw Error('DEV_WORKER_INTERVAL_INVALID');
  let timer,active,stopped=false;
  const status={enabled:intervalMs!==0,running:false,stopped:false,cycles:0,errors:0,lastCompletedAt:null,outcomes:{}};
  const runOnce=()=>{
    if(stopped)return Promise.reject(Error('DEV_WORKER_STOPPED'));
    if(active)return active;
    status.running=true;
    active=Promise.resolve().then(worker).then(rows=>{
      const outcomes={};
      for(const row of rows){const key=/^[A-Z_]{1,48}$/.test(row?.state)?row.state:'UNRECOGNIZED';outcomes[key]=(outcomes[key]||0)+1;}
      status.outcomes=outcomes;status.cycles++;status.lastCompletedAt=new Date().toISOString();return rows;
    }).catch(error=>{status.errors++;throw error;}).finally(()=>{status.running=false;active=undefined;});
    return active;
  };
  const tick=async()=>{
    try{await runOnce();}catch{/* No raw errors/identities in monitoring. Retry only through durable worker. */}
    if(!stopped)timer=setTimeout(tick,intervalMs);
  };
  if(intervalMs)timer=setTimeout(tick,intervalMs);
  return {runOnce,status:()=>({...status,outcomes:{...status.outcomes}}),async stop(){
    stopped=true;status.stopped=true;clearTimeout(timer);if(active)await active.catch(()=>{});
  }};
}
