import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectUrlCandidates,
  resolvePreferredLkApiBaseUrl,
  resolvePreferredProjectUrl,
  resolveLkApiBaseUrlCandidates,
  resolveLkApiFallbackTimeoutMs,
} from "../../src/utils/lkApiBaseUrls.ts";

function installRuntimeScriptMock(scriptSrc: string) {
  const runtime = globalThis as typeof globalThis & {
    window?: Record<string, unknown>;
    document?: Record<string, unknown>;
  };
  const previousWindow = runtime.window;
  const previousDocument = runtime.document;

  Object.defineProperty(runtime, "window", {
    configurable: true,
    value: {},
  });

  Object.defineProperty(runtime, "document", {
    configurable: true,
    value: {
      currentScript: null,
      scripts: [{ src: scriptSrc }],
    },
  });

  return {
    restore() {
      if (previousWindow === undefined) {
        delete runtime.window;
      } else {
        Object.defineProperty(runtime, "window", {
          configurable: true,
          value: previousWindow,
        });
      }

      if (previousDocument === undefined) {
        delete runtime.document;
      } else {
        Object.defineProperty(runtime, "document", {
          configurable: true,
          value: previousDocument,
        });
      }
    },
  };
}

test("api candidates prefer reserve when active bundle came from reserve", () => {
  const candidates = resolveLkApiBaseUrlCandidates(
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    {
      activeBaseUrl: "https://lk-reserve.89-108-64-209.sslip.io/lk",
      windowBaseUrls: [
        "https://padlhub.su/lk",
        "https://lk-reserve.89-108-64-209.sslip.io/lk",
        "https://padlhub.ru/lk",
      ],
    },
  );

  assert.deepEqual(candidates.slice(0, 2), [
    "https://lk-reserve.89-108-64-209.sslip.io",
    "https://padlhub.su",
  ]);
  assert.equal(candidates.includes("https://padlhub.ru"), false);
});

test("api candidates keep primary first without active reserve bundle", () => {
  const candidates = resolveLkApiBaseUrlCandidates(
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    {
      windowBaseUrls: [
        "https://padlhub.su/lk",
        "https://lk-reserve.89-108-64-209.sslip.io/lk",
        "https://padlhub.ru/lk",
      ],
    },
  );

  assert.deepEqual(candidates.slice(0, 2), [
    "https://padlhub.su",
    "https://lk-reserve.89-108-64-209.sslip.io",
  ]);
  assert.equal(candidates.includes("https://padlhub.ru"), false);
});

test("preferred api base url follows active reserve origin for writes", () => {
  const preferredBaseUrl = resolvePreferredLkApiBaseUrl(
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    {
      activeBaseUrl: "https://lk-reserve.89-108-64-209.sslip.io/lk",
      windowBaseUrls: [
        "https://padlhub.su/lk",
        "https://lk-reserve.89-108-64-209.sslip.io/lk",
        "https://padlhub.ru/lk",
      ],
    },
  );

  assert.equal(preferredBaseUrl, "https://lk-reserve.89-108-64-209.sslip.io");
});

test("preferred api base url stays on primary without active reserve origin", () => {
  const preferredBaseUrl = resolvePreferredLkApiBaseUrl(
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    {
      windowBaseUrls: [
        "https://padlhub.su/lk",
        "https://lk-reserve.89-108-64-209.sslip.io/lk",
      ],
    },
  );

  assert.equal(preferredBaseUrl, "https://padlhub.su");
});

test("preferred api base url falls back to the loaded reserve script origin when globals are absent", () => {
  const mocks = installRuntimeScriptMock("https://lk-reserve.89-108-64-209.sslip.io/lk/games.js?v=123");

  try {
    const preferredBaseUrl = resolvePreferredLkApiBaseUrl(
      "https://padlhub.su/seliger",
      "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    );

    assert.equal(preferredBaseUrl, "https://lk-reserve.89-108-64-209.sslip.io");
  } finally {
    mocks.restore();
  }
});

test("project api candidates rewrite hardcoded phab url to active reserve first", () => {
  const candidates = buildProjectUrlCandidates(
    "https://padlhub.su/api/tournaments?date=2026-06-09",
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    {
      activeBaseUrl: "https://lk-reserve.89-108-64-209.sslip.io/lk",
      windowBaseUrls: [
        "https://padlhub.su/lk",
        "https://lk-reserve.89-108-64-209.sslip.io/lk",
      ],
    },
  );

  assert.deepEqual(candidates.slice(0, 2), [
    "https://lk-reserve.89-108-64-209.sslip.io/api/tournaments?date=2026-06-09",
    "https://padlhub.su/api/tournaments?date=2026-06-09",
  ]);
});

test("preferred project url rewrites hardcoded push endpoint to active reserve", () => {
  const preferredUrl = resolvePreferredProjectUrl(
    "https://padlhub.su/lk/push/register",
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    {
      activeBaseUrl: "https://lk-reserve.89-108-64-209.sslip.io/lk",
      windowBaseUrls: [
        "https://padlhub.su/lk",
        "https://lk-reserve.89-108-64-209.sslip.io/lk",
      ],
    },
  );

  assert.equal(preferredUrl, "https://lk-reserve.89-108-64-209.sslip.io/lk/push/register");
});

test("project candidates keep non-project hosts unchanged", () => {
  const candidates = buildProjectUrlCandidates(
    "https://example.com/api/test",
    "https://padlhub.su/seliger",
    "https://lk-reserve.89-108-64-209.sslip.io/seliger",
  );

  assert.deepEqual(candidates, ["https://example.com/api/test"]);
});

test("serv2 fallback timeout is clamped to practical bounds", () => {
  assert.equal(resolveLkApiFallbackTimeoutMs("200"), 500);
  assert.equal(resolveLkApiFallbackTimeoutMs("2500"), 2500);
  assert.equal(resolveLkApiFallbackTimeoutMs("30000"), 15000);
});
