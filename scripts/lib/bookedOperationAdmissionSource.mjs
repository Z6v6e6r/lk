import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {hubGatewaySource} from './eventPaymentSources.mjs';
import {buildActiveBookingLimitTransitions} from './lk1ActiveBookingLimit.mjs';

const read=name=>fs.readFileSync(new URL('../nodered_lk1_hub_nodes/'+name+'.js',import.meta.url),'utf8');
const replace=(source,before,after)=>{
  if(source.split(before).length!==2) throw Error('Admission source anchor drift');
  return source.replace(before,()=>after);
};
export function composeBookedOperationAdmissionSource(readSource=url=>fs.readFileSync(url,'utf8')) {
  const split=readSource(new URL('../nodered_games_nodes/fn_split_router.js',import.meta.url));
  const priceStart=split.indexOf('  const shareCount = Math.max(1, Math.round(toNumber(ctx.shareCount) ?? 4));',split.indexOf('if (ctx.step === "ordinary_exact_price")'));
  const priceEnd=split.indexOf('  return continueSplitAfterVerifiedPrice(ctx);',priceStart);
  if(priceStart<0||priceEnd<priceStart) throw Error('Admission split price anchor drift');
  // Execute the owning split calculation unchanged; court total is already proved by #194.
  const numericStart=split.indexOf('const toNumber =');const numericEnd=split.indexOf('\nconst ',numericStart+1);
  if(numericStart<0||numericEnd<numericStart)throw Error('Admission split numeric anchor drift');
  const splitNumber=split.slice(numericStart,numericEnd);
  const splitPrice='const admissionSplitShareMinor = (totalMinor, capacity) => {const ctx={shareCount:capacity};const exactCourtPrice=totalMinor/100;\n'+splitNumber+'\n'+split.slice(priceStart,priceEnd)+'\nreturn Math.round(ctx.shareAmount*100);};';
  let body=readSource(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js',import.meta.url));
  const hooks=read('gateway_hooks').split(/^\/\/ HUB_([A-Z_]+)\s*$/m);const h={};
  for(let i=1;i<hooks.length;i+=2) h[hooks[i]]=hooks[i+1].trim();
  const mongo=h.HELPERS.slice(h.HELPERS.indexOf('const lk1MongoMatched ='));
  const admission=read('admission').split('// ADMISSION_STEPS');
  const gateway=hubGatewaySource().split('// HUB_STEPS');
  if(admission.length!==2||gateway.length!==2) throw Error('Admission source sections drift');
  body=replace(body,'const ctx = isObj(msg._subscriptionBooking)',mongo+'\n'+h.COURT_WINDOW+'\n'+buildActiveBookingLimitTransitions().hub.reader+'\n'+gateway[0]+'\n'+splitPrice+'\n'+admission[0]+'\nconst ctx = isObj(msg._subscriptionBooking)');
  body=replace(body,'if (ctx.step === "profile") {',gateway[1]+'\n'+admission[1]+'\nif (ctx.step === "profile") {');
  body=replace(body,'  if (ctx.action === "release") {\n    return prepareUserGet(ctx, "active_bookings"',
    '  if(ctx.padlHubAdmission) {\n    if(ctx.actorClientId!==ctx.padlHubAdmission.providerClientId) return finishError(ctx,409,"Actor mismatch",{code:"BOOKED_OPERATION_ADMISSION_CONFLICT"});\n'
    +'    return prepareUserGet(ctx,"admission_exercise",`/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`);\n  }\n'
    +'  if (ctx.action === "release") {\n    return prepareUserGet(ctx, "active_bookings"');
  const exerciseStart=body.indexOf('if (ctx.step === "exercise") {');
  const exerciseEnd=body.indexOf('\nif (ctx.step ===',exerciseStart+1);
  const exercise=body.slice(exerciseStart,exerciseEnd);
  body=body.slice(0,exerciseStart)+replace(exercise,'  const ownedSubscriptions = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);',h.EXERCISE)+body.slice(exerciseEnd);
  body=replace(body,'  delete ctx.activeBookingsPayload;','  delete ctx.activeBookingsPayload;\n'+h.HISTORY);
  body=replace(body,'ctx.operationKey = `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;',
    'ctx.operationKey = ctx.padlHubAdmission ? `lk1-product-v2:${JSON.stringify([ctx.padlHubAdmission.tenantId,ctx.padlHubAdmission.userId,ctx.operationId])}` : `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;');
  body=replace(body,'  const operation = msg.payload[0];\n  if (operation) {','  const operation = msg.payload[0];\n  if(operation?.admissionOnly && !ctx.padlHubAdmission) return finishError(ctx,409,"Admission cannot continue",{code:"BOOKED_OPERATION_ADMISSION_CONFLICT"});\n  if(ctx.padlHubAdmission && operation) return admissionFinish(ctx,operation);\n  if (operation) {');
  body=replace(body,'    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),',
    '    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),\n'
    +'    ...(ctx.padlHubAdmission ? {admissionOnly:true,padlHubAdmission:admissionBinding(ctx),padlHubAdmissionTarget:ctx.padlHubAdmissionTarget,padlHubAdmissionAudit:ctx.padlHubAdmissionAudit,padlHubOperation:{contractVersion:1,operationId:ctx.operationId,tenantId:ctx.padlHubAdmission.tenantId,userId:ctx.padlHubAdmission.userId,providerMappingId:ctx.padlHubAdmission.providerMappingId,issuer:ctx.padlHubAdmission.issuer,caller:ctx.padlHubAdmission.caller}} : {}),');
  body=replace(body,'if (ctx.step === "operation_insert") {','if (ctx.step === "operation_insert") {\n'
    +'  if(ctx.padlHubAdmission) {ctx.admissionInsertAttempted=true;return lk1Find(ctx,"admission_lookup",{_id:ctx.operationKey});}\n');
  body=replace(body,'const preparePreaccept = (ctx) => {','const preparePreaccept = (ctx) => {\n  if(ctx.padlHubAdmission) return finishError(ctx,409,"Admission cannot continue",{code:"BOOKED_OPERATION_ADMISSION_CONFLICT"});');
  new Function('msg','node','env','global',body);
  const evaluator=read('evaluator');new Function('msg',evaluator);
  const sha256=createHash('sha256').update(body+'\0'+evaluator).digest('hex');
  // Updating this pin is an explicit reviewed change to the executable boundary.

  if(sha256!=='dae5595de367ea4e6a236de2bd0324e91974b494ba9e6b64dcce8f558f8657c9') throw Error('Admission executable source drift');
  return {gateway:body,evaluator,sha256};
}
