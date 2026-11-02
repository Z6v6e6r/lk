import fs from 'node:fs';
import { monthlyFriendshipCustodyRuntimeSource } from './monthlyFriendshipCustody.mjs';
const read = name => fs.readFileSync(new URL('../nodered_games_nodes/fn_tournament_subscription_' + name + '.js', import.meta.url), 'utf8');
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('MONTHLY_SOURCE_ANCHOR_DRIFT');
  return source.replace(before, after);
};
const prelude = () => monthlyFriendshipCustodyRuntimeSource();
const binding = `global.get('monthly_friendship_custody_binding')?.version === 1 || ctx.monthlyCustodyRequired === true`;
const hold = source => replace(source,
  'const activePending = pendingDeadlineTs != null && pendingDeadlineTs > now;',
  'const activePending = row.monthlyCustodyHold === true || (pendingDeadlineTs != null && pendingDeadlineTs > now);');
export function monthlyCapacitySource() {
  const source = hold(read('purchase_limit'));
  const boundary = 'const vivaTokenRequestBody = buildVivaServiceTokenRequestBody();';
  if (source.split(boundary).length !== 2) throw Error('MONTHLY_CAPACITY_BOUNDARY_DRIFT');
  // Exact existing monthly calendar/counting code; stop before even service-token preparation.
  return 'function monthlyCapacityProbe(msg, global) {\n' + source.split(boundary)[0]
    + '\nreturn { ok: true, context: ctx };\n}\n';
}
export function monthlyFriendshipSource(name) {
  if (name === 'atomic') {
    const helper = fs.readFileSync(new URL('../nodered_monthly_friendship_nodes/fn_monthly_friendship_custody.js', import.meta.url), 'utf8');
    return prelude() + monthlyCapacitySource() + helper + '\n' + replace(read('piter_atomic_router'),
      'const ctx = msg._summerSubscriptionCtx;\nif (!ctx || (!isPiter(ctx) && !isHub(ctx))) {',
      `const ctx = msg._summerSubscriptionCtx;
const monthlyResult = runMonthlyFriendshipCustody({ msg, globalContext: global, capacityProbe: monthlyCapacityProbe,
  observe: annualHistory.observe, admission: subscriptionCounterEpoch.admission });
if (monthlyResult !== undefined) return monthlyResult;
if (!ctx || (!isPiter(ctx) && !isHub(ctx))) {`);
  }
  if (name === 'purchase_router') {
    let source = read(name);
    source = replace(source, 'counterKey === "piter_friendship" || counterKey === "network_friendship"',
      `counterKey === "piter_friendship" || counterKey === "network_friendship" || (counterKey === 'friendship' && ctx.action === 'purchase' && (${binding}))`);
    const marker = 'if (ctx.step === "token_purchase") {';
    source = replace(source, marker, `if (ctx.counterKey === 'friendship' && String(ctx.step).startsWith('monthly_')) return [null,null,null,null,msg];\n${marker}`);
    // Promo preview remains read-only; its one eventual transaction POST shares the same custody.
    source = replace(source, 'return adminRequest(ctx, "POST", "/transactions", ctx.transactionPayload);',
      `if (ctx.counterKey === 'friendship' && (${binding})) {
      const request = adminRequest(ctx, 'POST', '/transactions', ctx.transactionPayload);
      ctx.step = 'piter_reserve_start'; return [null,null,null,null,request[0]];
    }
    return adminRequest(ctx, "POST", "/transactions", ctx.transactionPayload);`);
    source = replace(source, 'ctx.token = msg.payload.access_token;\n  if (ctx.legacyEpochCandidate',
      `ctx.token = msg.payload.access_token;
  if (ctx.monthlyAfterToken === true) { ctx.step = 'monthly_confirm_start'; return [null,null,null,null,msg]; }
  if (ctx.legacyEpochCandidate`);
    return source;
  }
  if (name === 'purchase_limit') {
    let source = hold(read(name));
    source = replace(source, 'const rows = Array.isArray(msg.payload) ? msg.payload : [];',
      `let rows = Array.isArray(msg.payload) ? msg.payload : [];
if (ctx.counterKey === 'friendship' && rows.some(r => r.documentType === monthlyFriendshipCustody.kind)) {
  try {
    const ledgers = rows.filter(r => r.documentType === monthlyFriendshipCustody.kind && r.inventoryId === ctx.inventoryId);
    if (ledgers.length !== 1) throw Error('ledger cardinality');
    rows = monthlyFriendshipCustody.countingRows(rows, ledgers[0]);
    ctx.monthlyCustodyRequired = true;
  } catch { return failMsg(503, 'Покупка требует сверки', { code: 'MONTHLY_FRIENDSHIP_LEDGER_INVALID' }); }
}`);
    return prelude() + source;
  }
  if (name === 'status_response') {
    let source = read(name);
    source = replace(source, 'const docs = rows.filter((item) => item && typeof item === "object");',
      `let docs = rows.filter((item) => item && typeof item === "object");
try {
  for (const ledger of docs.filter(r => r.documentType === monthlyFriendshipCustody.kind)) {
    docs = monthlyFriendshipCustody.countingRows(docs, ledger);
  }
} catch {
  msg.statusCode = 503; msg.payload = { ok: false, code: 'MONTHLY_FRIENDSHIP_LEDGER_INVALID' };
  return [msg,null,null];
}`);
    source = replace(source, 'const isActivePending = isPending && pendingDeadlineTs != null && pendingDeadlineTs > now;',
      'const isActivePending = isPending && (doc.monthlyCustodyHold === true || (pendingDeadlineTs != null && pendingDeadlineTs > now));');
    return prelude() + source;
  }
  if (name === 'confirm_resolve') {
    return replace(read(name), 'const currentStatus = String(record.status || "").trim().toUpperCase();',
      `if (record.monthlyCustody?.version === 1) {
  if (ctx.counterKey !== 'friendship' || !record.monthlyCustody.tenantId || !ctx.clientId || !ctx.transactionId) {
    msg.statusCode = 503; msg.payload = { ok: false, code: 'MONTHLY_FRIENDSHIP_CONFIRM_BINDING_INVALID' };
    return [null,msg,null,null];
  }
  ctx.monthlyScope = { tenant_id: record.monthlyCustody.tenantId, inventoryId: ctx.inventoryId, counterKey: 'friendship' };
  ctx.monthlyAfterToken = true;
}
const currentStatus = String(record.status || "").trim().toUpperCase();`)
      // Existing cached PAID response is not an issuance proof for a monthly-custody row.
      .replace('if (currentStatus === "PAID"', 'if (!ctx.monthlyAfterToken && currentStatus === "PAID"');
  }
  throw Error('MONTHLY_SOURCE_UNKNOWN');
}
