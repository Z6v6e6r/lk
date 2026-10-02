import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { hubGatewaySource, proTrainingExclusionSource } from '../lib/eventPaymentSources.mjs';
import { initializeProTrainingBeforeSteps } from '../lib/proTrainingInitialization.mjs';
import { compose, BOOKING_ID, TARGET, sha256 } from '../patch_live_lk1_pro_training_initialization.mjs';
import { patchBookingBody } from '../patch_live_lk1_pro_training_discount.mjs';
import { PRO_TRAINING_ENERGY_CALL_SITE_DELTAS } from '../patch_live_lk1_pro_training_energy_exclusions_hotfix.mjs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const pro = proTrainingExclusionSource();
const module = pro.slice(pro.indexOf('const PRO_TRAINING_DIRECTION_IDS =')).trimEnd();
const RA = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const ACADEMY = '9eb8a7a4-c195-492a-95e4-3fb82899ac10';
const rule = productId => ({ productId, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 });

// Execute the complete router, not an extracted step or reordered helper closure.
// Compose the repository's real HUB helpers/steps at the production anchors, then
// reproduce the late-module position the installed PRO discount patch retained.
function lateBookingSource() {
  let booking = read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
  const file = text => ts.createSourceFile('fixture.js', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const names = statement => ts.isFunctionDeclaration(statement) ? [statement.name?.text]
    : ts.isVariableStatement(statement) ? statement.declarationList.declarations.map(item => item.name.getText()) : [];
  const declared = new Set(file(booking).statements.flatMap(names));
  const hooks = read('../nodered_lk1_hub_nodes/gateway_hooks.js').split(/^\/\/ HUB_([A-Z]+)\s*$/m);
  const sections = {};
  for (let i = 1; i < hooks.length; i += 2) sections[hooks[i]] = hooks[i + 1].trim();
  const extraHelpers = file(sections.HELPERS).statements.filter(statement => {
    const ids = names(statement);
    if (ids.some(name => declared.has(name))) return false;
    ids.forEach(name => declared.add(name));
    return true;
  }).map(statement => statement.getText()).join('\n');
  const [helpers, steps] = hubGatewaySource().split('// HUB_STEPS');
  booking = booking.replace('const ctx = isObj(msg._subscriptionBooking)',
    extraHelpers + '\n' + helpers.replace(module, '') + '\nconst ctx = isObj(msg._subscriptionBooking)');
  booking = booking.replace('if (ctx.step === "profile") {', steps + '\nif (ctx.step === "profile") {');
  booking = booking.replace('if (ctx.step === "exercise") {', module + '\nif (ctx.step === "exercise") {');
  booking = booking.replace('  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);',
    sections.EXERCISE + '\n  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);');
  new Function('msg', 'node', 'global', booking);
  return booking;
}
const late = lateBookingSource();
const fixed = initializeProTrainingBeforeSteps(late);
const evaluator = read('../nodered_lk1_hub_nodes/evaluator.js');
function execute(source, msg) {
  const rules = { formatVersion: 1, rules: [RA, ACADEMY].map(productId => ({ ...rule(productId),
    planKey: productId === RA ? 'ra' : 'academy', enforceFrom: '2026-09-01' })) };
  return new Function('msg', 'node', 'global', source)(msg, {}, {
    get: name => name === 'subscriptions_lk1_plan_rules' ? rules : undefined,
  });
}
function context(productId = RA) {
  return { step: 'lk1_usage_operations', caller: 'http', tenantKey: 'fixture',
    actorClientId: 'fixture-actor', clientSubscriptionId: 'fixture-sub', exerciseId: 'fixture-exercise',
    operationId: 'fixture-operation', managedAction: 'BOOK_GROUP_TRAINING',
    serviceDate: '2099-09-22', category: 'group_training',
    lk1ProductIdentity: { subscription: { visitsLeft: 40 } },
    lk1: { rule: rule(productId), bookings: [], activeBookings: [], target: {
      resolutionSource: 'SERVER', category: 'GROUP_TRAINING', basePriceMinor: 550000,
      durationMinutes: 60, startsAt: '2099-09-22T08:00:00+03:00', currency: 'RUB',
      priceSource: 'VIVA_EXISTING_TARIFF', directionId: 1001,
    } } };
}
function booking(directionId, id = 'fixture-booking') {
  return { id, clientSubscriptionId: 'fixture-sub', paymentType: 'SUBSCRIPTION',
    exerciseDate: '2099-09-22', exerciseType: { id: 605 }, exerciseDirection: { id: directionId } };
}
function usage(source, history, { proTarget = false, productId = RA, visitsLeft = 40, operations = [] } = {}) {
  const ctx = context(productId);
  ctx.lk1.bookings = history;
  ctx.lk1ProductIdentity.subscription.visitsLeft = visitsLeft;
  if (proTarget) Object.assign(ctx.lk1.target, { proTraining: true, directionId: 5507 });
  const msg = { _subscriptionBooking: ctx, payload: operations };
  const outputs = execute(source, msg);
  assert.equal(outputs[6], msg, JSON.stringify(ctx.result));
  assert.ok(msg._managedSubscriptionPolicyInput);
  const decided = new Function('msg', evaluator)(msg);
  const decision = (decided[0] || decided[1])._managedSubscriptionPolicyDecision;
  return { input: msg._managedSubscriptionPolicyInput, decision };
}

test('the installed order throws even for ordinary group history; moving the module fixes it', () => {
  assert.throws(() => usage(late, [booking(1001)]), /Cannot access 'proTrainingIsRecord' before initialization/);
  const { input } = usage(fixed, [booking(1001)]);
  assert.equal(input.usage.freeFirstEvent.usedEventsToday, 1);
});
test('moving the complete module preserves its bytes, all other code, and strict directives', () => {
  assert.equal(fixed.split(module).length, 2);
  assert.equal(fixed.replace(module, '').trim(), late.replace(module, '').trim());
  assert.equal(initializeProTrainingBeforeSteps(fixed), fixed);
  const strict = initializeProTrainingBeforeSteps('"use strict";\n' + late);
  assert.ok(strict.startsWith('"use strict";'));
  assert.throws(() => initializeProTrainingBeforeSteps(late.replace('const proTrainingNum =', 'const drift =')), /module drift/);
  assert.throws(() => initializeProTrainingBeforeSteps(late + '\n' + module), /module drift/);
  assert.throws(() => initializeProTrainingBeforeSteps(late + '\nfunction isProTrainingExercise() {}'), /declaration drift/);
});

test('the actual discount generator initializes the module before an early return without a private flow', () => {
  const ast = ts.createSourceFile('module.js', module, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  // The preceding Energy generation has the same nine declaration boundaries,
  // but does not yet carry the discount-product list and predicate.
  const legacy = ast.statements.filter(statement => !statement.getText(ast).startsWith('const PRO_TRAINING_DISCOUNT_PRODUCT_IDS')
    && !(ts.isFunctionDeclaration(statement) && statement.name?.text === 'isProTrainingDiscountRule'))
    .map(statement => statement.getText(ast)).join('\n');
  const preimage = `if (msg.step === 'early') return isProTrainingExercise(msg.exercise);
${legacy}
function exerciseGuard() {
${PRO_TRAINING_ENERGY_CALL_SITE_DELTAS[0].after}
  const productRule = lk1Config(ownedSubscriptions, exercise?.studio?.id || exercise?.studioId || null);
}
function quoteGuard() {
  if (configured.legacy) return { legacy: true };
  return {
    directionId: exerciseDirectionId(exercise),
  };
}
function coverage() {
  if (!products || !category) return false;
  const freeFirstCovered = lk1FreeFirstEventCovers();
  if (freeFirstCovered && lk1FreeFirstEventCovers(ctx.lk1.rule.productId,
      lk1OperationCategory(operation))) return true;
  if (freeFirstCovered && lk1FreeFirstEventCovers(ctx.lk1.rule.productId, category,
      exerciseDirectionId(booking.exercise || booking))) return true;
}`;
  assert.throws(() => new Function('msg', preimage)({ step: 'early', exercise: { directionId: 5507 } }),
    /Cannot access 'proTrainingIsRecord' before initialization/);
  const generated = patchBookingBody(preimage);
  assert.equal(generated.split(module).length, 2);
  assert.ok(generated.indexOf(module) < generated.indexOf("if (msg.step === 'early')"));
  const run = new Function('msg', generated);
  assert.equal(run({ step: 'early', exercise: { directionId: 5507 } }), true);
  assert.equal(run({ step: 'early', exercise: { directionId: 1001 } }), false);
});

for (const productId of [RA, ACADEMY]) {
  for (const [label, history, expectedUsed] of [
    ['empty', [], 0], ['ordinary', [booking(1001)], 1],
    ['PRO', [booking(5507)], 0], ['mixed', [booking(5507), booking(1001, 'fixture-booking-2')], 1],
  ]) test(`${productId === RA ? 'RA' : 'Academy'} early usage: ${label} history`, () => {
    const { input, decision } = usage(fixed, history, { productId });
    assert.equal(input.usage.freeFirstEvent.usedEventsToday, expectedUsed);
    assert.equal(decision.benefit.finalPriceMinor, expectedUsed ? 275000 : 0);
    assert.equal(decision.subscriptionVisitCount, expectedUsed ? 0 : 1);
  });
  test(`${productId === RA ? 'RA' : 'Academy'} PRO target keeps 50% discount without a visit`, () => {
    for (const visitsLeft of [0, 40]) {
      const { input, decision } = usage(fixed, [booking(1001)], { productId, proTarget: true, visitsLeft });
      assert.equal(input.usage.freeFirstEvent.covered, false);
      assert.equal(decision.benefit.finalPriceMinor, 275000);
      assert.equal(decision.subscriptionVisitCount, 0);
    }
  });
}

function tariffRecheck(source, productId, directionId) {
  const ctx = context(productId);
  ctx.step = 'lk1_event_tariff';
  ctx.caller = 'split';
  ctx.lk1.fingerprint = 'stale-fixture';
  ctx.lk1TariffRecheck = true;
  const row = { id: ctx.clientSubscriptionId, subscriptionId: ctx.clientSubscriptionId,
    clientId: ctx.actorClientId, productId, purchaseDate: '2026-09-02', status: 'ACTIVE',
    activationDate: '2026-09-02', expirationDate: '2100-01-01', visitsLeft: 40 };
  ctx.lk1ProductIdentity = { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    subscriptionId: ctx.clientSubscriptionId, productId, name: 'Fixture', purchaseDate: row.purchaseDate,
    subscription: row };
  ctx.lk1TariffExercise = { id: ctx.exerciseId, type: { id: 605 }, direction: { id: directionId },
    studio: { id: 'fixture-studio' }, room: { id: 'fixture-room' },
    timeFrom: '2099-09-22T08:00:00+03:00', timeTo: '2099-09-22T09:00:00+03:00',
    availableClientSubscriptions: [row] };
  const url = `https://api.vivacrm.ru/end-user/api/v2/fixture/products/one-times?exerciseId=${ctx.exerciseId}`;
  const msg = { _subscriptionBooking: ctx, statusCode: 200, method: 'GET', url, responseUrl: url,
    payload: [{ id: 'fixture-one-time', cost: 550000, productType: 'SERVICE' }] };
  return { outputs: execute(source, msg), ctx };
}
for (const productId of [RA, ACADEMY]) for (const directionId of [1001, 5507]) {
  test(`early tariff recheck ${productId === RA ? 'RA' : 'Academy'} direction ${directionId}`, () => {
    assert.throws(() => tariffRecheck(late, productId, directionId), /Cannot access 'proTrainingIsRecord' before initialization/);
    const { outputs } = tariffRecheck(fixed, productId, directionId);
    // A stale quote still refuses safely; fixing initialization must not skip revalidation.
    assert.equal(outputs[4].payload.details.code, 'LK1_RULE_PRICE_OR_TARGET_CHANGED_BEFORE_WRITE');
  });
}

test('the production hotfix rejects an unreviewed flow', () => {
  assert.throws(() => compose(Buffer.from('[]')), /live source drift/);
});
const liveSnapshot = process.env.LK_PRO_TRAINING_INITIALIZATION_LIVE_SNAPSHOT;
test('exact installed helper reproduces the incident and the one-node hotfix preserves the graph',
  { skip: !liveSnapshot && 'Requires private exact live snapshot; hermetic regressions above always run' }, () => {
    const raw = fs.readFileSync(liveSnapshot);
    const before = JSON.parse(raw);
    const result = compose(raw);
    const after = JSON.parse(result.candidate);
    const original = before.find(node => node.id === BOOKING_ID).func;
    const patched = after.find(node => node.id === BOOKING_ID).func;
    assert.equal(sha256(patched), TARGET.patchedBooking);
    assert.deepEqual(after.filter((node, i) => JSON.stringify(node) !== JSON.stringify(before[i])).map(node => node.id), [BOOKING_ID]);
    assert.deepEqual(after.map(node => node.id === BOOKING_ID ? { ...node, func: original } : node), before);
    assert.equal(sha256(compose(raw).candidate), sha256(result.candidate));
    assert.throws(() => compose(result.candidate), /live source drift/);
    assert.throws(() => compose(Buffer.concat([raw, Buffer.from(' ')])), /live source drift/);
    for (const productId of [RA, ACADEMY]) {
      for (const directionId of [1001, 5507]) {
        assert.throws(() => tariffRecheck(original, productId, directionId), /Cannot access 'proTrainingIsRecord' before initialization/);
        assert.equal(tariffRecheck(patched, productId, directionId).outputs[4].payload.details.code,
          'LK1_RULE_PRICE_OR_TARGET_CHANGED_BEFORE_WRITE');
      }
      assert.throws(() => usage(original, [booking(1001)], { productId }), /Cannot access 'proTrainingIsRecord' before initialization/);
      for (const history of [[], [booking(1001)], [booking(5507)], [booking(5507), booking(1001, 'fixture-booking-2')]]) {
        usage(patched, history, { productId });
      }
    }
  });
