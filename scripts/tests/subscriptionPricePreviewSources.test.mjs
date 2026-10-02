import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSubscriptionPricePreviewSource, extractSubscriptionPricePreviewSources, subscriptionPreviewUsageRoots } from '../lib/subscriptionPricePreviewSources.mjs';

test('extracts top-level dependency closure in source order without execution', () => {
  const source = `const base = 10;\nconst helper = input => input + base;\nconst unused = () => process.exit(1);\nfunction quote(value) { return helper(value); }`;
  const result = extractSubscriptionPricePreviewSource({ source, label: 'booking', roots: ['quote'] });
  assert.deepEqual(result.names, ['base', 'helper', 'quote']);
  assert.match(result.source, /const base = 10;/);
  assert.doesNotMatch(result.source, /process\.exit/);
});

test('handles cycles and rejects absent or duplicate declarations', () => {
  const cycle = `const left = () => right();\nconst right = () => left();`;
  assert.deepEqual(extractSubscriptionPricePreviewSource({ source: cycle, roots: ['left'] }).names, ['left', 'right']);
  assert.throws(() => extractSubscriptionPricePreviewSource({ source: cycle, roots: ['missing'] }), /missing top-level declaration missing/);
  assert.throws(() => extractSubscriptionPricePreviewSource({ source: 'const one = 1;\nconst one = 2;', roots: ['one'] }), /duplicate top-level declaration one/);
});

test('keeps same declaration names separate between candidate inputs', () => {
  const result = extractSubscriptionPricePreviewSources([
    { name: 'booking-router', source: 'const shared = 1; const booking = () => shared;', roots: ['booking'] },
    { name: 'split-router', source: 'const shared = 2; const split = () => shared;', roots: ['split'] },
  ]);
  assert.match(result[0].source, /shared = 1/);
  assert.match(result[1].source, /shared = 2/);
});

test('does not pull declarations shadowed by parameters, locals, catches, or destructuring', () => {
  const source = [
    'const ctx = () => "top";',
    'const value = () => "top";',
    'function quote(ctx, { value }) {',
    '  const local = ctx + value;',
    '  try { throw 1; } catch (ctx) { return local + ctx; }',
    '}',
  ].join('\n');
  const result = extractSubscriptionPricePreviewSource({ source, roots: ['quote'] });
  assert.deepEqual(result.names, ['quote']);
});

test('rejects invalid JavaScript source before extraction', () => {
  assert.throws(() => extractSubscriptionPricePreviewSource({ source: 'const = ;', roots: ['anything'] }), /source parse diagnostics/);
});


test('allowance extraction carries bare helpers and respects loop-local bindings', () => {
  const source = `const exerciseDirectionId = row => row.directionId;
    const lk1FreeFirstEventCovers = id => id === 'covered';`;
  const usage = `for (const booking of ctx.bookings) {
    if (lk1FreeFirstEventCovers(ctx.product)) msg.direction = exerciseDirectionId(booking);
  }
  return emit(OUTPUT_MANAGED_POLICY);`;
  const roots = subscriptionPreviewUsageRoots(source, usage);
  assert.deepEqual([...roots].sort(), ['exerciseDirectionId', 'lk1FreeFirstEventCovers']);
  const helpers = extractSubscriptionPricePreviewSource({ source, roots }).source;
  const canonical = new Function(`${helpers}; return {${roots.join(',')}};`)();
  const execute = new Function('canonical', 'msg', `const {${roots.join(',')}} = canonical;
    const ctx = msg; const OUTPUT_MANAGED_POLICY = 6; const emit = () => msg; ${usage}`);
  assert.equal(execute(canonical, { product: 'covered', bookings: [{ directionId: 6233 }] }).direction, 6233);
  assert.throws(() => subscriptionPreviewUsageRoots(source, usage.replace('exerciseDirectionId(booking)',
    'missingDirectionHelper(booking)')), /undeclared dependencies: missingDirectionHelper/);
});
