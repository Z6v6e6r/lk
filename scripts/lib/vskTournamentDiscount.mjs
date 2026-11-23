// Apply only to a reviewed evaluator, preserving immutable historical release sources.
import assert from 'node:assert/strict';
const anchor = '  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {';
const branch = `  } else if (category === "TOURNAMENT"
    && target?.eventId === "732d1932-4133-48c3-aed4-5ad1abf94e79"
    && target?.externalEventTypeId === "viva:direction:6977:type:2349") {
    // This VSK tournament has a monetary benefit, including the first event of the day.
    // Ownership, lifecycle and event scope are still verified by the gateway; only a
    // policy that already includes the 50% tournament benefit qualifies here.
    decision.subscriptionVisitCount = 0;
    if (rule.tournamentDiscountPercent !== 50) {
      block("EVENT_NOT_INCLUDED", "Подписка не включает скидку на этот турнир");
    } else {
      selectedRule = { ruleId: "lk1-vsk-tournament", kind: "PERCENT_DISCOUNT", percentage: 50 };
    }
`;
export function patchVskTournamentEvaluator(source) {
  assert.equal(source.split(anchor).length, 2, 'Evaluator anchor drift');
  assert(!source.includes('lk1-vsk-tournament'), 'Already patched');
  const patched = source.replace(anchor, branch + anchor);
  new Function('msg', 'node', 'global', 'env', patched);
  return patched;
}
