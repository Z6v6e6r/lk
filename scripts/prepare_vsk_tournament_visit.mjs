import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VSK_EVALUATORS } from './prepare_vsk_tournament_discount.mjs';

const VSK_PRODUCT = '94e32355-1c69-462b-9f2a-77f2817cb24c';
const VSK_TOURNAMENT_TYPE = 'viva:direction:6977:type:2349';
const BOOKING_ROUTERS = ['lk_subscription_booking_router_20260804', '6cffa6278ef875e4'];
const PREVIEW_ROUTER = 'lk_subscription_price_preview_20260908_router';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(source, anchor, replacement) {
  assert.equal(source.split(anchor).length, 2, `Expected one matching function anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}

export function patchVskTournamentVisitEvaluator(source) {
  const anchor = '  } else if (category === "GROUP_TRAINING"\n    && isTopokratyTrainingBenefit';
  const branch = `  } else if (category === "TOURNAMENT"
    && target?.externalEventTypeId === "${VSK_TOURNAMENT_TYPE}"
    && input.lk1ProductBinding?.ownedProductId === "${VSK_PRODUCT}"
    && input.lk1ProductBinding?.policyProductId === "${VSK_PRODUCT}") {
    const visitsLeft = usage?.subscriptionVisitsLeft;
    if (decision.aboveActiveLimit) {
      block("ACTIVE_SERVICES_LIMIT_REACHED", "Достигнут лимит активных записей по подписке");
    } else if (dailyVisits > 0) {
      block("VSK_TOURNAMENT_DAILY_VISIT_USED", "Посещение по подписке на эту дату уже использовано");
    } else if (!Number.isSafeInteger(visitsLeft) || visitsLeft < 0) {
      block("VSK_TOURNAMENT_VISIT_BALANCE_UNAVAILABLE", "Не удалось подтвердить остаток посещений");
    } else if (visitsLeft === 0) {
      block("SUBSCRIPTION_VISITS_EXHAUSTED", "В подписке не осталось посещений");
    } else {
      decision.subscriptionVisitCount = 1;
      selectedRule = { ruleId: "lk1-vsk-tournament-visit", kind: "FREE_ENTITLEMENT" };
    }
`;
  return replaceOnce(source, anchor, branch + anchor);
}

function supplyVisitBalance(source) {
  const anchor = '      usedOrReservedVisitsToday: dailyVisits,';
  return replaceOnce(source, anchor, `${anchor}\n      subscriptionVisitsLeft: freeFirstVisitsLeft,`);
}

function patchBookingRouter(source) {
  let patched = supplyVisitBalance(source);
  const finish = 'const lk1Finish = (ctx) => {';
  patched = replaceOnce(patched, finish, `const lk1IsVskTournament = (quote) => (
  quote?.rule?.productId === "${VSK_PRODUCT}"
  && quote.target?.category === "TOURNAMENT"
  && quote.target.externalEventTypeId === "${VSK_TOURNAMENT_TYPE}"
);
const lk1VskTournamentPreviousPayment = (quote) => (
  lk1IsVskTournament(quote)
  && quote.decision
  && (quote.decision.benefit?.finalPriceMinor !== 0 || quote.decision.subscriptionVisitCount !== 1
    || quote.checkout || quote.transactionAttemptedAt || quote.transactionId || quote.transactionIntent)
);
const lk1StopVskTournamentPreviousPayment = (ctx) => finishError(ctx, 409,
  "Предыдущая запись на турнир ВСК требует сверки. Обновите карточку турнира.", {
    code: "VSK_TOURNAMENT_PREVIOUS_PAYMENT_REQUIRES_RECONCILIATION"
  });
${finish}`);
  for (const anchor of [finish, 'const lk1Checkout = (ctx) => {',
    'const preparePreaccept = (ctx) => {', 'const prepareBookingCreate = (ctx) => {']) {
    patched = replaceOnce(patched, anchor, `${anchor}
  if (lk1VskTournamentPreviousPayment(ctx.lk1)) return lk1StopVskTournamentPreviousPayment(ctx);`);
  }
  const sendInvoice = 'if (ctx.step === "lk1_payment_attempt_saved") {';
  return replaceOnce(patched, sendInvoice, `${sendInvoice}
  if (lk1IsVskTournament(ctx.lk1)) return lk1StopVskTournamentPreviousPayment(ctx);`);
}

function patchPreviewRouter(source) {
  let patched = supplyVisitBalance(source);
  const limit = "const LIMIT_DECISION_BLOCKERS = ['ACTIVE_SERVICES_LIMIT_REACHED', 'USAGE_SNAPSHOT_BUCKET_MISMATCH'];";
  patched = replaceOnce(patched, limit, `const LIMIT_DECISION_BLOCKERS = ['ACTIVE_SERVICES_LIMIT_REACHED', 'USAGE_SNAPSHOT_BUCKET_MISMATCH',
  'VSK_TOURNAMENT_DAILY_VISIT_USED', 'SUBSCRIPTION_VISITS_EXHAUSTED'];`);
  const unavailable = "  'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND'];";
  return replaceOnce(patched, unavailable,
    "  'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND', 'VSK_TOURNAMENT_VISIT_BALANCE_UNAVAILABLE'];");
}

export function prepareVskTournamentVisit(raw, reviewedSha256) {
  assert.match(reviewedSha256, /^[a-f0-9]{64}$/);
  assert.equal(sha256(raw), reviewedSha256, 'Live source drift');
  const flow = JSON.parse(raw);
  assert(Array.isArray(flow), 'Expected a disk flow array');
  assert.equal(new Set(flow.map(node => node.id)).size, flow.length, 'Duplicate node ID');
  const patches = new Map([
    ...VSK_EVALUATORS.map(id => [id, patchVskTournamentVisitEvaluator]),
    ...BOOKING_ROUTERS.map(id => [id, patchBookingRouter]),
    [PREVIEW_ROUTER, patchPreviewRouter],
  ]);
  for (const [id, patch] of patches) {
    const node = flow.find(item => item.id === id);
    assert.equal(node?.type, 'function', `Missing function ${id}`);
    assert.equal(typeof node.func, 'string');
    assert(!node.func.includes('lk1-vsk-tournament-visit')
      && !node.func.includes('VSK_TOURNAMENT_VISIT_BALANCE_UNAVAILABLE')
      && !node.func.includes('VSK_TOURNAMENT_PREVIOUS_PAYMENT_REQUIRES_RECONCILIATION'), 'Already patched');
    node.func = patch(node.func);
    new Function('msg', 'node', 'global', 'env', node.func);
  }
  return Buffer.from(JSON.stringify(flow, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, reviewedSha256, output, extra] = process.argv.slice(2);
  assert(source && reviewedSha256 && output && !extra,
    'Usage: node prepare_vsk_tournament_visit.mjs <private-flow> <reviewed-sha256> <new-private-file>');
  const candidate = prepareVskTournamentVisit(readFileSync(source), reviewedSha256);
  writeFileSync(output, candidate, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: reviewedSha256, candidateSha256: sha256(candidate) }));
}
