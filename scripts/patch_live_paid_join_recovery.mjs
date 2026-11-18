import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const route = '67ba0da85846345a';
const router = '8f7bd5b482fe9763';
const prepare = 'e92e68bf3f08a70c';
const mongoTemplate = 'c47fed2ca27576f4';
const accepted = {
  [router]: '3eb2421d126f797f464429b2f0c92561d87e176b273172efc1ff1be56bfb9181',
  [prepare]: '4ee34f6fcbb7735f21504bc601afe2ec9c3b7fb936b8ec2218e95205b6067e85',
  [mongoTemplate]: 'a9fc44bb9dc0ddc16c9c8f47fca08cc64360069d7ff764e5fba1293b328f599f',
};
const dbDispatch = 'paid_split_join_db_dispatch_v1';
const journal = 'paid_split_join_journal_v1';
const games = 'paid_split_join_projection_v1';
const catchDb = 'paid_split_join_db_catch_v1';
const ids = [dbDispatch, journal, games, catchDb];
const sha = (body) => createHash('sha256').update(body).digest('hex');
const helper = readFileSync(new URL('./nodered_split_join_recovery_nodes/checkout.js', import.meta.url), 'utf8');

function splice(body, anchor, replacement, expected = 1) {
  if (body.split(anchor).length !== expected + 1) throw Error('Unexpected split checkout hook: ' + anchor);
  return body.replaceAll(anchor, replacement);
}

export function composePaidJoinRouter(body, dbOutput) {
  if (!Number.isInteger(dbOutput) || dbOutput < 5 || dbOutput > 8) throw Error('Unexpected router outputs');
  body = splice(body, 'const continueSplitAfterToken = (ctx) => {', `const continueSplitAfterToken = (ctx) => {
  if (ctx.action === "join" && resolvePaymentMode(ctx.paymentMode) === "one_time"
    && !ctx.paidJoinAuthComplete
    && paidJoinEnabledForGame(ctx.gameId)) return paidJoinBegin(ctx);`);
  body = splice(body, '\n  ctx.step = "create_booking";\n  return adminRequest(', `
  if (ctx.paidJoin) {
    if (bookingPaymentType !== "ON_PLACE" || !(ctx.shareAmount > 0)) return paidJoinPending();
    return paidJoinClaim(ctx, payload);
  }
  ctx.step = "create_booking";
  return adminRequest(`);
  body = splice(body, '\n  ctx.step = "available_products";\n  return adminRequest(ctx, "POST", "/products/available/by-booking", {', `
  if (ctx.paidJoin) return paidJoinAfterBooking(ctx);
  ctx.step = "available_products";
  return adminRequest(ctx, "POST", "/products/available/by-booking", {`);
  body = splice(body, '\n  return adminRequest(ctx, "POST", "/transactions", transactionPayload);', `
  if (ctx.paidJoin) {
    if (ctx.selectedPaymentMode !== "one_time" || !(ctx.shareAmountMinor > 0)) return paidJoinPending();
    return paidJoinBeforeTransaction(ctx);
  }
  return adminRequest(ctx, "POST", "/transactions", transactionPayload);`);
  body = splice(body, '\n  if (ctx.step === "transaction") {', `
  if (ctx.paidJoin && ["create_booking", "available_products", "transaction", "transaction_lookup"].includes(ctx.step)) {
    return paidJoinPending();
  }
  if (ctx.step === "transaction") {`);
  body = splice(body, '\n  msg.payload = responsePayload;\n  return [null, msg, msg];', `
  if (ctx.paidJoin) return paidJoinRegisterCheckout(ctx, responsePayload);
  msg.payload = responsePayload;
  return [null, msg, msg];`, 2);
  body = splice(body, 'const fail = (status, error, details) => {', `const fail = (status, error, details) => {
  if (msg._splitCtx?.paidJoin || String(msg._splitCtx?.step ?? "").startsWith("paid_join_")) {
    const code = typeof details?.code === "string" && /^SPLIT_[A-Z0-9_]+$/.test(details.code)
      ? details.code : "SPLIT_JOIN_CHECKOUT_PENDING";
    msg.statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 409;
    msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    msg.payload = { error: code === "SPLIT_JOIN_AUTH_REQUIRED" || code === "SPLIT_JOIN_ACTOR_MISMATCH"
      ? error : "Проверяем предыдущую попытку оплаты. Обновите карточку игры чуть позже.", details: { code } };
    return [null, msg];
  }`);
  body = splice(body, 'const ctx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : null;', `
const PAID_JOIN_DB_OUTPUT = ${dbOutput};
${helper}
const ctx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : null;
if (ctx && String(ctx.step).startsWith("paid_join_")) return paidJoinReadState(ctx);`);
  new Function('msg', 'node', 'global', 'flow', 'env', body);
  return body;
}

export function composePaidJoinPrepare(body) {
  const anchor = '  gameId: toStr(msg._splitJoinGameId),';
  const result = splice(body, anchor, `${anchor}
  paidJoinTenant: game.tenantKey ?? null,`);
  new Function('msg', 'node', 'global', 'flow', 'env', result);
  return result;
}

export function buildPaidJoinRecoveryCandidate(flow) {
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('Invalid flow');
  const nodes = new Map(flow.map(n => [n.id, n]));
  const r = nodes.get(router);
  const p = nodes.get(prepare);
  const mongo = nodes.get(mongoTemplate);
  if (!r || !p || !mongo || r.type !== 'function' || p.type !== 'function'
    || nodes.get(route)?.url !== '/lk/games/:gameId/split/join'
    || r.outputs !== 5 || r.wires.length !== r.outputs || p.z !== r.z || mongo.z !== r.z
    || mongo.type !== 'mongodb4' || mongo.collection !== 'lk_games'
    || nodes.get(mongo.clientNode)?.type !== 'mongodb4-client' || ids.some(id => nodes.has(id))) {
    throw Error('Paid split JOIN graph contract drift');
  }
  for (const [id, hash] of Object.entries(accepted)) {
    if (sha(JSON.stringify(nodes.get(id))) !== hash) throw Error('Paid split JOIN node drift: ' + id);
  }
  const dbNode = (id, name, collection, y) => ({
    ...mongo, id, name, collection, operation: '', x: 950, y, maxTimeMS: '0', wires: [[router]],
  });
  const reply = [
    ...flow.map(n => n.id === router
      ? { ...r, func: composePaidJoinRouter(r.func, r.outputs), outputs: r.outputs + 1,
          wires: [...r.wires, [dbDispatch]] }
      : n.id === prepare ? { ...p, func: composePaidJoinPrepare(p.func) } : n),
    {
      id: dbDispatch, type: 'switch', z: r.z, name: 'Route private paid JOIN storage',
      property: '_paidJoinCollection', propertyType: 'msg',
      rules: [{ t: 'eq', v: 'journal', vt: 'str' }, { t: 'eq', v: 'games', vt: 'str' }],
      checkall: 'false', repair: false, outputs: 2, x: 700, y: 3680, wires: [[journal], [games]],
    },
    dbNode(journal, 'Read or advance paid JOIN journal', 'lk_paid_split_join_checkouts', 3640),
    dbNode(games, 'Read or publish exact paid JOIN', 'lk_games', 3720),
    { id: catchDb, type: 'catch', z: r.z, name: 'Treat paid JOIN storage errors as pending',
      scope: [journal, games], uncaught: false, x: 700, y: 3760, wires: [[router]] },
  ];
  return reply;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [workspace, output, extra] = process.argv.slice(2);
  if (!workspace || !output || extra || !path.isAbsolute(output) || path.dirname(path.resolve(output)) !== path.resolve(workspace)) {
    throw Error('Usage: <verified private live workspace> <new candidate path inside workspace>');
  }
  const verified = verifyWorkspace(workspace, { quiet: true });
  const candidate = buildPaidJoinRecoveryCandidate(verified.source);
  writeFileSync(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ changed: [router, prepare], added: ids, candidateNodes: candidate.length }));
}
