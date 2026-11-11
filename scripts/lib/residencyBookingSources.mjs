import fs from 'node:fs';
const read = name => fs.readFileSync(new URL('../nodered_residency_booking_nodes/'+name+'.js',import.meta.url),'utf8');
export const residencyContextSource = () => fs.readFileSync(new URL('./residencyBookingContext.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
export function residencyReplace(source,before,after) {
  if (source.split(before).length!==2) throw new Error('Residency source anchor drift: '+before.slice(0,90));
  return source.replace(before,()=>after);
}
export function composeResidencyGateway(source) {
  if (source.includes('const residencyIdentity =')) throw new Error('Residency already installed');
  const [helpers,steps]=read('gateway').split('// RESIDENCY_STEPS');
  source=residencyReplace(source,'const ctx = isObj(msg._subscriptionBooking)',residencyContextSource()+'\n'+helpers+'\nconst ctx = isObj(msg._subscriptionBooking)');
  source=residencyReplace(source,'if (ctx.step === "profile") {',steps+'\nif (ctx.step === "profile") {');
  for (const phase of ['exercise','exercise_recheck']) {
    const anchor=`if (ctx.step === "${phase}") {`;
    source=residencyReplace(source,anchor,anchor+`\n  if (residencyIdentity(ctx)) {\n    if (msg.error || !isHttpOk(msg.statusCode)) return lk1Stop(ctx,'RESIDENCY_TARGET_UNAVAILABLE');\n    const pending=residencyEnsure(ctx,unwrapRecord(msg.payload),'${phase}');\n    if (pending) return pending;\n  }`);
  }
  source=residencyReplace(source,'const lk1Config = (owned, stationId) => {',`const lk1Config = (owned, stationId) => {
  if (lk1ResolveProductIdentity(null,owned).productId===RESIDENCY_PRODUCT_ID) {
    try {return {matched:true,rule:validateResidencyBookingContext(ctx.residencyContext,ctx.clientSubscriptionId,Date.now()).rule};}
    catch {return {matched:true,code:'RESIDENCY_BOOKING_CONTEXT_REQUIRED'};}
  }`);
  source=residencyReplace(source,'const lk1Quote = (ctx, exercise, owned) => {',`const lk1Quote = (ctx, exercise, owned) => {
  if (residencyIdentity(ctx)) {
    try {validateResidencyBookingContext(ctx.residencyContext,ctx.clientSubscriptionId,Date.now(),residencyTarget(ctx,exercise),managedActionForTarget({...ctx,category:resolveCategory(exercise)}));}
    catch {return {code:'RESIDENCY_BOOKING_CONTEXT_REQUIRED'};}
  }`);
  source=residencyReplace(source,'action: ctx.managedAction, rule: quote.rule, purchaseDate: quote.purchaseDate,',`action: ctx.managedAction, rule: quote.rule, purchaseDate: quote.purchaseDate,
  residencyBinding: quote.rule?.productId===RESIDENCY_PRODUCT_ID ? residencyStoredBinding(quote,ctx.clientSubscriptionId) : undefined,`);
  source=residencyReplace(source,'rule: configured.rule, purchaseDate: dates.dates[0], target,',`rule: configured.rule, purchaseDate: dates.dates[0], target,
    ...(configured.rule.productId===RESIDENCY_PRODUCT_ID ? {residencyBinding:validateResidencyBookingContext(ctx.residencyContext,ctx.clientSubscriptionId,Date.now()).binding} : {}),`);
  source=residencyReplace(source,'const lk1ReplayIdentityMatches = (ctx, operation, operationId = ctx.operationId) => {',`const lk1ReplayIdentityMatches = (ctx, operation, operationId = ctx.operationId) => {
  if (operation?.lk1?.rule?.productId===RESIDENCY_PRODUCT_ID && !residencyStoredBinding(operation.lk1,ctx.clientSubscriptionId)) return false;`);
  source=residencyReplace(source,'const prepareBookingCreate = (ctx) => {',`const prepareBookingCreate = (ctx) => {
  if (ctx.lk1?.rule?.productId===RESIDENCY_PRODUCT_ID) {
    try {
      const proof=validateResidencyBookingContext(ctx.residencyContext,ctx.clientSubscriptionId,Date.now(),ctx.lk1.target,ctx.managedAction);
      if (ctx.lk1.decision?.subscriptionVisitCount!==0 || !residencyConfig(ctx)) throw Error();
      const current=JSON.parse(lk1Fingerprint(ctx,ctx.lk1));
      if (JSON.stringify(current.residencyBinding)!==JSON.stringify(proof.binding) || lk1Fingerprint(ctx,ctx.lk1)!==ctx.lk1.fingerprint) throw Error();
    } catch {return lk1Stop(ctx,'RESIDENCY_CHANGED_BEFORE_WRITE');}
  }`);
  source=residencyReplace(source,'&& ruleConfigured && ctx.lk1MoneyReadbackPhase', '&& (ruleConfigured || residencyIdentity(ctx)) && ctx.lk1MoneyReadbackPhase');
  // Monetary ownership is independent of Viva's visit-redemption eligibility.
  source=source.replaceAll('["group_training", "tournament"].includes(resolveCategory(exercise))',
    '(["group_training", "tournament"].includes(resolveCategory(exercise)) || residencyIdentity(ctx))');
  source=source.replaceAll('String(ctx.lk1ProductIdentity?.productId || "").trim().toLowerCase() === "37ab3713-4431-4815-96ba-d7ece76a9241"',
    '["37ab3713-4431-4815-96ba-d7ece76a9241",RESIDENCY_PRODUCT_ID].includes(String(ctx.lk1ProductIdentity?.productId || "").trim().toLowerCase())');
  source=residencyReplace(source,"&& resolveCategory(exercise) === 'group_training') return identityMoneyOwned(ctx, rows, exercise);",
    "&& (resolveCategory(exercise) === 'group_training' || residencyIdentity(ctx))) return identityMoneyOwned(ctx, rows, exercise);");
  source=residencyReplace(source,"  const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(row, null) === 'NEW_FIRST_USE_CANDIDATE';",
    "  const firstUse = !residencyIdentity(ctx) && preflightAvailability.resolveSplitSubscriptionLifecycle(row, null) === 'NEW_FIRST_USE_CANDIDATE';");
  source=source.replaceAll('&& !isProTrainingDiscountRule(configured.rule)', '&& configured.rule.productId!==RESIDENCY_PRODUCT_ID && !isProTrainingDiscountRule(configured.rule)');
  source=source.replaceAll('&& isProTrainingDiscountRule(productRule.rule)', '&& (productRule.rule.productId===RESIDENCY_PRODUCT_ID || isProTrainingDiscountRule(productRule.rule))');
  source=source.replaceAll('&& isTopokratyExercise(exercise)\n', '&& isTopokratyExercise(exercise) && !residencyIdentity(ctx)\n');
  source=residencyReplace(source,'    action: ctx.managedAction, lk1Policy: policy,',
    '    action: ctx.managedAction, lk1Policy: policy, residencyContext: ctx.residencyContext,');
  source=source.replace(/ctx\.caller === "http"\s*&&(\s*)\(\["group_training", "tournament"\]/g,
    '(ctx.caller === "http" || residencyIdentity(ctx)) &&$1(["group_training", "tournament"]');
  source=residencyReplace(source, 'if (ctx.caller !== "http" || !(["group_training", "tournament"]',
    'if ((ctx.caller !== "http" && !residencyIdentity(ctx)) || !(["group_training", "tournament"]');
  source=residencyReplace(source, "if (ctx.caller === 'http' && ctx.step === 'lk1_money_owned_subscriptions'",
    "if ((ctx.caller === 'http' || residencyIdentity(ctx)) && ctx.step === 'lk1_money_owned_subscriptions'");
  new Function('msg','node','global','env',source);
  return source;
}
export function composeResidencyEvaluator(source) {
  const guard=`
const residencyInput=msg._managedSubscriptionPolicyInput;
if (residencyInput?.lk1ProductBinding?.policyProductId===RESIDENCY_PRODUCT_ID) {
  try {
    const proof=validateResidencyBookingContext(residencyInput.residencyContext,residencyInput.lk1ProductBinding.clientSubscriptionId,Date.now(),residencyInput.target,residencyInput.action);
    if (Object.keys(residencyInput.lk1Policy).some(k=>residencyInput.lk1Policy[k]!==proof.rule[k])
      || residencyInput.usage?.freeFirstEvent?.covered===true) throw Error();
  } catch {
    msg._managedSubscriptionPolicyDecision={eligible:false,blockers:[{code:'RESIDENCY_BOOKING_CONTEXT_INVALID'}]};
    return [null,msg];
  }
}
`;
  const result=residencyContextSource()+'\n'+guard+'\n'+source;
  new Function('msg',result);return result;
}
export function composeResidencyPreview(source) {
  if (source.includes('const residencyPreviewTarget')) throw new Error('Residency already installed');
  const [helpers,branch]=read('preview').split('// RESIDENCY_PREVIEW_BRANCH');
  source=residencyContextSource()+'\n'+source;
  // Handle this instance's failed read before the generic transport-error guard.
  source=residencyReplace(source,"if (msg.error) return stop('PRICE_PREVIEW_READ_FAILED');",
    helpers+"\nif (msg.error) return stop('PRICE_PREVIEW_READ_FAILED');");
  const anchor="  if (!eventRoute && ['availableStudios', 'availableTypes', 'availableDirections'].some(field => live[field] != null && !Array.isArray(live[field])))";
  source=residencyReplace(source,anchor,branch+'\n'+anchor);
  new Function('msg','node','global','env',source);return source;
}
