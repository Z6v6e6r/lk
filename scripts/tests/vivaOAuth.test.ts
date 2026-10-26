import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVivaOAuthCallbackUrl,
  buildVivaOAuthReturnUrl,
  clearPendingVivaOAuth,
  readPendingVivaOAuth,
} from "../../src/utils/vivaOAuth.ts";
import { getVivaOAuthStorageKey } from "../../src/utils/authMode.ts";

function installWindowMock(href: string) {
  const sessionStorageMap = new Map<string, string>();
  const url = new URL(href);
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        search: url.search,
        origin: url.origin,
      },
      sessionStorage: {
        getItem(key: string) {
          return sessionStorageMap.has(key) ? sessionStorageMap.get(key) ?? null : null;
        },
        setItem(key: string, value: string) {
          sessionStorageMap.set(key, String(value));
        },
        removeItem(key: string) {
          sessionStorageMap.delete(key);
        },
      },
      history: {
        replaceState() {},
      },
    },
  });

  return {
    sessionStorageMap,
    restore() {
      if (previousWindow === undefined) {
        delete (globalThis as typeof globalThis & { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: previousWindow,
        });
      }
    },
  };
}

test("viva oauth callback url uses cabinet path and preserves channel", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?channel=dev&joinGame=abc");
  try {
    const callbackUrl = new URL(buildVivaOAuthCallbackUrl());
    assert.equal(callbackUrl.origin, "https://padlhub.ru");
    assert.equal(callbackUrl.pathname, "/lk_new");
    assert.equal(callbackUrl.searchParams.get("channel"), "dev");
    assert.equal(callbackUrl.searchParams.get("authMode"), "viva");
  } finally {
    mocks.restore();
  }
});

test("viva oauth return url keeps original route and injects auth mode", () => {
  const mocks = installWindowMock("https://padlhub.ru/game_join?joinGame=abc&channel=dev&authMode=viva");
  try {
    const returnUrl = new URL(buildVivaOAuthReturnUrl());
    assert.equal(returnUrl.pathname, "/game_join");
    assert.equal(returnUrl.searchParams.get("joinGame"), "abc");
    assert.equal(returnUrl.searchParams.get("channel"), "dev");
    assert.equal(returnUrl.searchParams.get("authMode"), "viva");
  } finally {
    mocks.restore();
  }
});

test("viva oauth pending state can be read and cleared", () => {
  const mocks = installWindowMock("https://padlhub.ru/lk_new?authMode=viva");
  try {
    mocks.sessionStorageMap.set(getVivaOAuthStorageKey(), JSON.stringify({
      provider: "vkid",
      state: "state-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://padlhub.ru/lk_new?authMode=viva",
      returnTo: "https://padlhub.ru/game_join?authMode=viva",
    }));

    assert.equal(readPendingVivaOAuth()?.provider, "vkid");
    clearPendingVivaOAuth();
    assert.equal(readPendingVivaOAuth(), null);
  } finally {
    mocks.restore();
  }
});

test('current-page callback stays on the game origin/path and strips query-selected targets and fragments', () => {
  const mocks = installWindowMock('https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html?returnUrl=https://other.invalid&code=old&state=old#old');
  try {
    assert.equal(buildVivaOAuthCallbackUrl('current-page'), 'https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html?authMode=viva');
  } finally { mocks.restore(); }
});

test('stored OAuth callback and return cannot redirect to another origin or embed userinfo', () => {
  const mocks = installWindowMock('https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html');
  try {
    const base = { provider: 'yandex', state: 'fixture-state', codeVerifier: 'fixture-verifier', redirectUri: 'https://padlhub.su/callback', returnTo: 'https://padlhub.su/game' };
    const withUserinfo = new URL('https://padlhub.su/game'); withUserinfo.username = 'fixture-user'; withUserinfo.password = 'fixture-password';
    for (const change of [{ returnTo: 'https://other.invalid/game' }, { redirectUri: 'https://other.invalid/callback' }, { returnTo: withUserinfo.href }]) {
      mocks.sessionStorageMap.set(getVivaOAuthStorageKey(), JSON.stringify({ ...base, ...change })); assert.equal(readPendingVivaOAuth(), null);
    }
    mocks.sessionStorageMap.set(getVivaOAuthStorageKey(), JSON.stringify(base)); assert.equal(readPendingVivaOAuth()?.provider, 'yandex');
  } finally { mocks.restore(); }
});

test('Yandex self-callback records PKCE/state before redirect and keeps code exchange on the exact callback', async () => {
  const { startVivaOAuthRedirect } = await import('../../src/utils/vivaOAuth.ts');
  const { createHash } = await import('node:crypto');
  const mocks = installWindowMock('https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html');
  try {
    let consentStaged = false;
    await startVivaOAuthRedirect('yandex', 'widget', 'iSkq6G', pending => { assert.equal(readPendingVivaOAuth()?.state, pending.state); consentStaged = true; return true; }, 'current-page');
    const url = new URL(window.location.href), pending = readPendingVivaOAuth()!;
    assert.ok(consentStaged); assert.equal(url.searchParams.get('kc_idp_hint'), 'yandex'); assert.equal(url.searchParams.get('scope'), 'openid');
    assert.equal(url.searchParams.get('state'), pending.state); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(pending.codeVerifier).digest('base64url'));
    assert.equal(url.searchParams.get('redirect_uri'), pending.redirectUri); assert.ok(!url.searchParams.has('code_verifier'));
  } finally { mocks.restore(); }
});

test('OAuth never leaves the page if PKCE state storage or consent staging fails', async () => {
  const { startVivaOAuthRedirect } = await import('../../src/utils/vivaOAuth.ts');
  const original = 'https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html';
  const mocks = installWindowMock(original);
  try {
    await assert.rejects(startVivaOAuthRedirect('yandex', 'widget', 'iSkq6G', () => false, 'current-page'), /consent could not be stored/);
    assert.equal(window.location.href, original); assert.equal(readPendingVivaOAuth(), null);
    window.sessionStorage.setItem = () => { throw new Error('Fixture: storage disabled'); };
    await assert.rejects(startVivaOAuthRedirect('yandex', 'widget', 'iSkq6G', undefined, 'current-page'), /session could not be stored/);
    assert.equal(window.location.href, original);
  } finally { mocks.restore(); }
});


test('legacy community invitation code is not an OAuth callback, but real response signals and game callbacks are', async () => {
  const { isVivaOAuthCallbackUrl } = await import('../../src/utils/vivaOAuth.ts');
  assert.equal(isVivaOAuthCallbackUrl('https://padlhub.ru/community_join?code=legacy-community-code'), false);
  assert.equal(isVivaOAuthCallbackUrl('https://padlhub.ru/lk_new?code=fixture-code&state=fixture-state'), true);
  assert.equal(isVivaOAuthCallbackUrl('https://padlhub.su/lk/padel-jump-team-86cdb47d/padel-jump-race.html?code=fixture-code', 'current-page'), true);
});
