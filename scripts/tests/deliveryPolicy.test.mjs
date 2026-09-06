import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { classifyChange, classifyChanges, classifyRange, requiredOutcome, validateOutcomes } from '../delivery-policy.mjs';

const path = 'src/components/cabinet/BuySubscription.tsx';
const source = readFileSync(path, 'utf8');

test('real subscription presentation receives frontend route; purchase handler cannot', () => {
  const text = />([^<>{}\n]*[А-Яа-я][^<>{}\n]*)</.exec(source);
  assert.ok(text, 'existing visible copy must exist');
  const after = source.replace(text[0], '>Подписка<');
  assert.notEqual(after, source);
  assert.equal(classifyChange({ path, before: source, after }), 'frontend');
  assert.equal(classifyChange({ path, before: source, after: source + '\nfetch("/purchase", { method: "POST" });\n' }), 'business');
  assert.equal(classifyChange({ path: 'scripts/nodered_tournament_participants_nodes/fn_client_release_v2.js', before: 'count: 1', after: 'count: 2' }), 'release');
});

test('attributes cannot erase handlers, conditions, URLs, custom props or syntax errors', () => {
  const before = 'const x = <button className="old" onClick={buy}>Купить</button>;';
  assert.equal(classifyChange({ path, before, after: before.replace('old', 'new') }), 'frontend');
  for (const after of [before.replace('{buy}', '{refund}'), before.replace('button', 'Widget'), before + 'broken {', before.replace('className', 'formAction')]) {
    assert.equal(classifyChange({ path, before, after }), 'business');
  }
  assert.equal(classifyChange({ path, before: '<Action title="buy"/>', after: '<Action title="refund"/>' }), 'business');
  assert.equal(classifyChange({ path: 'src/MyApp.css', before: '', after: '.x{}', mode: '120000' }), 'release');
});

test('loader/release and unknown paths expand; labels cannot affect classification', () => {
  for (const path of ['docs/tilda-loader.html', 'scripts/write-release.mjs', 'src/utils/overlayBundleUrl.ts', '.github/workflows/lk-frontend-delivery.yml', 'unknown.txt']) {
    assert.equal(classifyChange({ path, before: 'a', after: 'b', label: 'FAST' }), 'release');
  }
  assert.equal(classifyChanges([{ path: 'docs/FCM.md' }]).profile, 'docs');
  assert.equal(classifyChanges([{ path: 'src/MyApp.css' }, { path: 'src/utils/paymentSync.ts' }]).frontendEligible, false);
});

test('every applicable check must succeed: failure/cancel/skip/missing never pass', () => {
  const checks = [{ id: 'lint', category: 'app' }, { id: 'custody', category: 'release' }];
  assert.equal(validateOutcomes('frontend', checks, { lint: { outcome: 'success' }, custody: { outcome: 'skipped' } }).ok, true);
  for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(validateOutcomes('frontend', checks, { lint: { outcome }, custody: { outcome: 'skipped' } }).ok, false);
  }
  assert.equal(validateOutcomes('release', checks, { lint: { outcome: 'success' }, custody: { outcome: 'skipped' } }).ok, false);
  assert.throws(() => validateOutcomes('', checks, {}));
});

test('Git accumulation includes earlier business changes, removals and renamed paths', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'lk-range-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = () => { git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  mkdirSync(join(cwd, 'src/utils'), { recursive: true });
  writeFileSync(join(cwd, 'src/MyApp.css'), '.x { color: red; }');
  writeFileSync(join(cwd, 'src/utils/paymentSync.ts'), 'const debit = 1;');
  const installed = commit();
  writeFileSync(join(cwd, 'src/utils/paymentSync.ts'), 'const debit = 2;');
  const business = commit();
  writeFileSync(join(cwd, 'src/MyApp.css'), '.x { color: blue; }');
  const source = commit();
  assert.equal(classifyRange(business, source, { cwd }).frontendEligible, true);
  assert.equal(classifyRange(installed, source, { cwd }).frontendEligible, false);
  git('mv', 'src/utils/paymentSync.ts', 'src/MyApp.css.ts');
  assert.equal(classifyRange(installed, commit(), { cwd }).frontendEligible, false);
  assert.throws(() => classifyRange('unknown', source, { cwd }));
  assert.throws(() => classifyRange(source, installed, { cwd }));
});

test('workflow routes checks explicitly and the final result always evaluates outcomes', () => {
  const workflow = load(readFileSync('.github/workflows/lk1-subscription-enforcement.yml', 'utf8'));
  const steps = workflow.jobs['lk1-exact-head'].steps;
  const final = steps.at(-1);
  assert.equal(final.name, 'Required delivery result');
  assert.equal(final.if, 'always()');
  assert.match(final.env.DELIVERY_STEPS, /toJSON\(steps\)/);
  assert.equal(final.run, 'node scripts/delivery-check-result.mjs');
  const checks = steps.filter(step => step.id?.startsWith('check_'));
  assert.equal(new Set(checks.map(step => step.id)).size, checks.length);
  for (const profile of ['docs', 'frontend', 'business', 'release']) {
    const outcomes = Object.fromEntries(checks.map(step => [step.id, { outcome: requiredOutcome(profile, step.env?.DELIVERY_CATEGORY ?? 'always') ? 'success' : 'skipped' }]));
    assert.equal(validateOutcomes(profile, checks.map(step => ({ id: step.id, category: step.env?.DELIVERY_CATEGORY ?? 'always' })), outcomes).ok, true);
  }
});
