import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { authSessionIdentity, sessionIdentityBinding } from '../../src/utils/authSessionIdentity.ts';

const token = (sub: string, exp = 1) => 'header.' + Buffer.from(JSON.stringify({ sub, iss: 'https://identity.example/clients', azp: 'widget', exp })).toString('base64url') + '.signature';
function sessionHarness() {
  let access = token('actor-A'), mode = 'viva', legacy: string | null = null;
  let bind = sessionIdentityBinding;
  let profileRead = async (_path: string, _options: any) => ({ data: { phone: 'fixture-phone' }, error: null });
  const source = readFileSync(new URL('../../src/components/subscription-storefront/zeroCheckoutSession.ts', import.meta.url), 'utf8').replace(/^import[^\n]*\n/gm, '');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, TENANT_KEY: 'fixture-tenant', request: (...args: [string, any]) => profileRead(...args), authSessionIdentity, sessionIdentityBinding: (...a: Parameters<typeof bind>) => bind(...a),
    resolveConfiguredAuthMode: () => mode, readVivaAccessToken: () => access, readAuthToken: () => legacy || access };
  vm.runInNewContext(output, context);
  return { api: context.exports as typeof import('../../src/components/subscription-storefront/zeroCheckoutSession'),
    setLegacy: (value: string) => { legacy = value; },
    switchAccount: (sub: string) => { access = token(sub); }, rotate: () => { access = token('actor-A', 2); },
    switchProvider: () => { mode = 'legacy'; }, setOpaque: () => { access = 'opaque'; },
    setBinding: (fn: typeof bind) => { bind = fn; }, setProfileRead: (fn: typeof profileRead) => { profileRead = fn; } };
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

test('profile identity uses exact checkout token despite an unrelated legacy credential', async () => {
  const h = sessionHarness(), captured = h.api.checkoutSessionToken();
  h.setProfileRead(async (path, options) => {
    assert.equal(path, '/end-user/api/v1/fixture-tenant/profile');
    assert.equal(options.headers.Authorization, `Bearer ${captured}`);
    assert.equal(options.auth, false); assert.equal(options.dedupe, false); assert.equal(options.retries, 0);
    return { data: { phone: 'exact-actor' }, error: null };
  });
  assert.equal(await h.api.resolveCheckoutPhone(captured), 'exact-actor');
  h.setProfileRead(async () => { h.switchAccount('actor-B'); return { data: { phone: 'stale-actor' }, error: null }; });
  await assert.rejects(h.api.resolveCheckoutPhone(captured), /Аккаунт изменился/);
});

test('direct authenticated transport fails before profile or purchase when legacy credential differs', async () => {
  const h = sessionHarness(); let reads = 0;
  h.setProfileRead(async () => { reads++; return { data: { phone: 'fixture' }, error: null }; });
  h.setLegacy(token('unrelated-actor'));
  await assert.rejects(h.api.resolveCheckoutPhone(h.api.checkoutSessionToken(), true)); assert.equal(reads, 0);
});

test('a legacy credential changed after profile invalidates the immediate dispatch guard', async () => {
  const h = sessionHarness(), captured = h.api.checkoutSessionToken();
  await h.api.resolveCheckoutPhone(captured, true); assert.equal(h.api.checkoutTransportMatches(captured), true);
  h.setLegacy(token('changed-during-quote')); assert.equal(h.api.checkoutTransportMatches(captured), false);
});
