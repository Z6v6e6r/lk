import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { authSessionIdentity, sessionIdentityBinding } from '../../src/utils/authSessionIdentity.ts';

const token = (sub: string, exp = 1) => 'header.' + Buffer.from(JSON.stringify({ sub, iss: 'https://identity.example/clients', azp: 'widget', exp })).toString('base64url') + '.signature';
function sessionHarness() {
  let access = token('actor-A'), mode = 'viva';
  let bind = sessionIdentityBinding;
  const source = readFileSync(new URL('../../src/components/subscription-storefront/zeroCheckoutSession.ts', import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, authSessionIdentity, sessionIdentityBinding: (...a: Parameters<typeof bind>) => bind(...a),
    resolveConfiguredAuthMode: () => mode, readVivaAccessToken: () => access, readAuthToken: () => access };
  vm.runInNewContext(output, context);
  return { api: context.exports as typeof import('../../src/components/subscription-storefront/zeroCheckoutSession'),
    switchAccount: (sub: string) => { access = token(sub); }, rotate: () => { access = token('actor-A', 2); },
    switchProvider: () => { mode = 'legacy'; }, setOpaque: () => { access = 'opaque'; },
    setBinding: (fn: typeof bind) => { bind = fn; } };
}
const id = '00000000-0000-4000-8000-000000000001';

test('the account captured at the card click is checked before claim even when storage changed before mount', async () => {
  const h = sessionHarness(), initialIdentity = h.api.checkoutSessionIdentity();
  h.switchAccount('actor-B');
  await assert.rejects(h.api.verifyFastCheckoutSession({ id, initialIdentity }, null), /Аккаунт изменился/);
});
test('verified OAuth continuation binds the exact provider/account; same-subject token rotation remains compatible', async () => {
  const h = sessionHarness(), identity = h.api.checkoutSessionIdentity()!;
  const sessionBinding = await sessionIdentityBinding(id, identity);
  h.rotate();
  assert.equal(await h.api.verifyFastCheckoutSession({ id, initialIdentity: null, sessionBinding }, null), identity);
  h.switchAccount('actor-B');
  await assert.rejects(h.api.verifyFastCheckoutSession({ id, initialIdentity: null, sessionBinding }, null));
  const other = sessionHarness(); other.switchProvider();
  await assert.rejects(other.api.verifyFastCheckoutSession({ id, initialIdentity: null, sessionBinding }, null));
});
test('interactive SMS proof anchors the provider response, not whatever account storage contains later', async () => {
  const h = sessionHarness(), interactive = h.api.checkoutSessionIdentity(); h.switchAccount('actor-B');
  await assert.rejects(h.api.verifyFastCheckoutSession({ id, initialIdentity: null }, interactive));
  await assert.rejects(h.api.verifyFastCheckoutSession({ id, initialIdentity: null }, null));
  h.setOpaque(); await assert.rejects(h.api.verifyFastCheckoutSession({ id, initialIdentity: interactive }, interactive));
});
test('account drift during asynchronous fingerprint verification is rejected before claim', async () => {
  const h = sessionHarness(), identity = h.api.checkoutSessionIdentity()!;
  const sessionBinding = await sessionIdentityBinding(id, identity);
  let release!: (s: string) => void;
  h.setBinding(() => new Promise<string>(resolve => { release = resolve; }));
  const pending = h.api.verifyFastCheckoutSession({ id, initialIdentity: null, sessionBinding }, null);
  h.switchAccount('actor-B'); release(sessionBinding);
  await assert.rejects(pending);
});
