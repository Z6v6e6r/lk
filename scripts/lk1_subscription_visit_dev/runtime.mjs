import http from 'node:http';
import { MongoClient } from 'mongodb';
import { initialState,exercise,providerRequest,TOKEN,USER_TOKEN,ACTOR,RULE } from './fixture.mjs';
import { createVivaVisitProvider,runSubscriptionVisitJob } from '../lib/subscriptionVisitWorker.mjs';
export {RULE,TOKEN,USER_TOKEN};
export async function settleVisitJobs(jobs) {
  const results=await Promise.allSettled(jobs);
  if(results.some(row=>row.status==='rejected'))throw Error('DEV_WORKER_SCAN_FAILED');
  return results.map(row=>row.value);
}
const fail=code=>{throw new Error(code);};
export function validateConfig(config) {
  if(!config || typeof config.database!=='string' || config.database.length>63 || config.environment!=='DEV' || !/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(config.mongoUri)
    || !/^lk1_subscription_dev_fixture(?:_verify_[a-z0-9_]+)?$/.test(config.database)
    || !Number.isSafeInteger(config.providerPort)||config.providerPort<1024||config.providerPort>65535
    || !Number.isSafeInteger(config.nodeRedPort)||config.nodeRedPort<1024||config.nodeRedPort>65535
    || config.nodeRedPort===config.providerPort || new URL(config.mongoUri).port!=='27030' || [config.nodeRedPort,config.providerPort].includes(27030))fail('DEV_CONFIGURATION_INVALID');
  return config;
}
export async function openVisitDev(config) {
  validateConfig(config);
  const client=new MongoClient(config.mongoUri,{retryWrites:false,serverSelectionTimeoutMS:5000});await client.connect();
  const db=client.db(config.database),stateCollection=db.collection('dev_provider_state');
  if(!await stateCollection.findOne({_id:'fixture'}))await stateCollection.insertOne(initialState());
  const origin=`http://127.0.0.1:${config.providerPort}`;
  let chain=Promise.resolve();
  const serial=fn=>{const next=chain.then(fn);chain=next.catch(()=>{});return next;};
  const withState=fn=>serial(async()=>{const state=await stateCollection.findOne({_id:'fixture'});
    const result=await fn(state);await stateCollection.replaceOne({_id:'fixture'},state);return result;});
  const server=http.createServer(async(req,res)=>{
    try{if(req.socket.remoteAddress!=='127.0.0.1')fail('DEV_LOOPBACK_REQUIRED');
      let text='';for await(const c of req){text+=c;if(text.length>32768)fail('DEV_BODY_TOO_LARGE');}
      const result=await withState(state=>providerRequest(state,{method:req.method,url:req.url,headers:req.headers,body:text?JSON.parse(text):undefined},origin));
      if(result.dropReply){req.socket.destroy();return;}
      res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result.body));
    }catch(e){res.writeHead(e.statusCode||500,{'Content-Type':'application/json'});res.end(JSON.stringify({code:e.message}));}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.providerPort,'127.0.0.1',resolve);});}
  catch(error){await client.close();throw error;}
  const collections=new Set(['lk_games','lk_subscription_daily_booking_ops','lk_game_leave_operations','lk_subscription_product_identity']);
  const io={
    async transport(msg){
      const url=new URL(msg.url);
      if(url.origin!=='https://api.vivacrm.ru'||url.username||url.password||url.hash)fail('DEV_EGRESS_DENIED');
      const auth=msg.headers?.Authorization||msg.headers?.authorization;
      if(!['Bearer '+TOKEN,'Bearer '+USER_TOKEN].includes(auth))fail('DEV_TOKEN_DENIED');
      const method=String(msg.method).toUpperCase();
      if(!['GET','POST','PUT','DELETE'].includes(method))fail('DEV_METHOD_DENIED');
      const response=await fetch(origin+url.pathname+url.search,{method,redirect:'error',signal:AbortSignal.timeout(10000),
        headers:{Authorization:auth,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(msg.payload??{})})});
      msg.payload=await response.json();msg.statusCode=response.status;msg.responseUrl=msg.url;delete msg.error;
      return msg;
    },
    async mongo(msg,collection,operation){
      if(!collections.has(collection))fail('DEV_COLLECTION_DENIED');
      const c=db.collection(collection),p=msg.payload;
      if(operation==='find')msg.payload=await c.find(p||{}).limit(1000).toArray();
      else if(operation==='insertOne')msg.payload=await c.insertOne(...(Array.isArray(p)?p:[p]));
      else if(operation==='updateOne')msg.payload=await c.updateOne(...p);
      else fail('DEV_MONGO_OPERATION_DENIED:'+operation);
      delete msg.error;return msg;
    },
  };
  const provider=createVivaVisitProvider({baseUrl:origin,token:async()=>TOKEN});
  return {io,db,origin,
    async fault(kind){if(!['DEBIT_ACK_LOST','RETURN_ACK_LOST','PAY_PROJECTION_LOST'].includes(kind))fail('DEV_FAULT_INVALID');
      return withState(state=>{state.fault=kind;return {armed:kind};});},
    async seed(){const state=await stateCollection.findOne({_id:'fixture'});
      const game={id:'fixture-game',archived:false,updatedAt:new Date().toISOString(),isSingles:false,maxClientsCount:4,
        organizer:{id:'fixture-organizer',phone:'70000000000'},participants:[],participantPhones:[],waitlist:[],waitlistPhones:[],
        booking:{masterServiceId:'fixture-master',subServiceIds:['fixture-subservice'],exerciseId:'fixture-exercise',roomId:'fixture-room',studioId:'fixture-studio',date:state.serviceDate,timeFrom:'12:00',timeTo:'13:30'},
        metadata:{splitPayment:{vivaExerciseId:'fixture-exercise',shareCount:4,selectedPaymentMode:'money',payments:[]}}};
      await db.collection('lk_games').updateOne({id:game.id},{$setOnInsert:game},{upsert:true});
      return {game,exercise:exercise(state),subscriptions:state.subscriptions};},
    async pay(transactionId){return serial(async()=>{
      const state=await stateCollection.findOne({_id:'fixture'});
      const tx=state.transactions.find(t=>t.id===transactionId);
      const booking=state.bookings.find(b=>b.id===tx?.bookingIds[0]);
      if(!tx||tx.refunded||!booking||booking.isCancelled)fail('DEV_PAYMENT_INVALID');
      const op=await db.collection('lk_subscription_daily_booking_ops').findOne({bookingId:booking.id,state:'CONFIRMED','lk1.checkout.transactionId':tx.id});
      if(!op)fail('DEV_OPERATION_MISSING');
      const games=db.collection('lk_games'),game=await games.findOne({id:'fixture-game'});
      const payments=game.metadata.splitPayment.payments;
      const existing=payments.filter(p=>p.clientId===ACTOR);
      if(existing.some(p=>p.bookingId!==booking.id))fail('DEV_PAYMENT_GENERATION_CONFLICT');
      // Persist provider acknowledgement before roster projection; replay repairs
      // an interrupted projection, but never a cancelled booking or newer generation.
      const projectionLost=state.fault==='PAY_PROJECTION_LOST';if(projectionLost)delete state.fault;
      tx.paid=true;await stateCollection.replaceOne({_id:'fixture'},state);
      if(projectionLost)fail('DEV_PAYMENT_PROJECTION_RETRY');
      if(existing.length===1&&existing[0].status==='PAID')return {paid:true,synthetic:true,replay:true};
      const result=await games.updateOne({id:game.id,updatedAt:game.updatedAt},{$set:{
        participants:[...game.participants.filter(p=>p.id!==ACTOR),{id:ACTOR,status:'CONFIRMED',bookingId:booking.id}],
        updatedAt:new Date().toISOString(),
        'metadata.splitPayment.payments':[...payments.filter(p=>p.clientId!==ACTOR),{clientId:ACTOR,bookingId:booking.id,
          clientSubscriptionId:op.clientSubscriptionId,status:'PAID',transactionId:tx.id}]}});
      if(result.modifiedCount!==1)fail('DEV_PAYMENT_PROJECTION_RETRY');
      return {paid:true,synthetic:true};});},
    async worker(){const rows=await db.collection('lk_subscription_daily_booking_ops').find({state:'CONFIRMED','lk1.visitJob':{$exists:true}}).toArray();
      return settleVisitJobs(rows.map(row=>runSubscriptionVisitJob({operationKey:row._id,operations:db.collection('lk_subscription_daily_booking_ops'),
        locks:db.collection('lk_subscription_visit_locks'),leaveOperations:db.collection('lk_game_leave_operations'),provider})));},
    async state(){return {provider:await stateCollection.findOne({_id:'fixture'}),operations:await db.collection('lk_subscription_daily_booking_ops').find({}).toArray(),
      game:await db.collection('lk_games').findOne({id:'fixture-game'}),locks:await db.collection('lk_subscription_visit_locks').countDocuments()};},
    async close(){await chain;await new Promise(resolve=>server.close(resolve));await client.close();},
  };
}
