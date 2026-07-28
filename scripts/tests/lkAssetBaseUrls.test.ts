import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLkAssetFileCandidates,
  buildLkAssetUrlCandidates,
  resolvePreferredLkAssetUrl,
} from "../../src/utils/lkAssetBaseUrls.ts";

function installWindowMock(origin: string, baseUrls?: string[], activeBaseUrl?: string) {
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin,
        href: `${origin}/lk_dev`,
        hostname: new URL(origin).hostname,
      },
      __LK_BASE_URLS__: baseUrls,
      __LK_ACTIVE_BASE_URL__: activeBaseUrl,
    },
  });

  return {
    restore() {
      if (previousWindow === undefined) {
        delete (globalThis as typeof globalThis & { window?: unknown }).window;
        return;
      }

      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    },
  };
}

function installRuntimeScriptMock(scriptSrc: string) {
  const runtime = globalThis as typeof globalThis & {
    window?: Record<string, unknown>;
    document?: Record<string, unknown>;
  };
  const previousWindow = runtime.window;
  const previousDocument = runtime.document;

  Object.defineProperty(runtime, "window", {
    configurable: true,
    value: {
      location: {
        origin: "https://padlhub.ru",
        href: "https://padlhub.ru/game_create",
        hostname: "padlhub.ru",
      },
    },
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

test("remote widget candidates prefer active reserve before hardcoded primary", () => {
  const mocks = installWindowMock("https://padlhub.ru", [
    "https://lk-reserve.89-108-64-209.sslip.io/lk",
    "https://padlhub.su/lk",
  ], "https://lk-reserve.89-108-64-209.sslip.io/lk");

  try {
    const candidates = buildLkAssetUrlCandidates("https://padlhub.su/lk/games-dev.js");

    assert.deepEqual(candidates.slice(0, 2), [
      "https://lk-reserve.89-108-64-209.sslip.io/lk/games-dev.js",
      "https://padlhub.su/lk/games-dev.js",
    ]);
  } finally {
    mocks.restore();
  }
});

test("remote widget candidates preserve loader base url order without active base", () => {
  const mocks = installWindowMock("https://padlhub.ru", [
    "https://padlhub.su/lk",
    "https://lk-reserve.89-108-64-209.sslip.io/lk",
  ]);

  try {
    const candidates = buildLkAssetUrlCandidates("https://padlhub.su/lk/games-dev.js");

    assert.deepEqual(candidates.slice(0, 2), [
      "https://padlhub.su/lk/games-dev.js",
      "https://lk-reserve.89-108-64-209.sslip.io/lk/games-dev.js",
    ]);
  } finally {
    mocks.restore();
  }
});

test("explicit prod loader base url stays single-host without project-wide fallbacks", () => {
  const mocks = installWindowMock("https://padlhub.ru", [
    "https://padlhub.su/lk",
  ]);

  try {
    const candidates = buildLkAssetFileCandidates("release.json", []);

    assert.deepEqual(candidates, [
      "https://padlhub.su/lk/release.json",
    ]);
  } finally {
    mocks.restore();
  }
});

test("explicit dev loader base url stays single-host without cross-channel fallback", () => {
  const mocks = installWindowMock("https://padlhub.ru", [
    "https://lk-reserve.89-108-64-209.sslip.io/lk",
  ]);

  try {
    const candidates = buildLkAssetFileCandidates("release-dev.json", []);

    assert.deepEqual(candidates, [
      "https://lk-reserve.89-108-64-209.sslip.io/lk/release-dev.json",
    ]);
  } finally {
    mocks.restore();
  }
});

test("release candidates keep reserve first when current bundle already came from reserve", () => {
  const mocks = installWindowMock("https://padlhub.ru", [
    "https://padlhub.su/lk",
    "https://lk-reserve.89-108-64-209.sslip.io/lk",
  ]);

  try {
    const candidates = buildLkAssetFileCandidates(
      "release-dev.json",
      ["https://lk-reserve.89-108-64-209.sslip.io/lk"],
    );

    assert.deepEqual(candidates.slice(0, 2), [
      "https://lk-reserve.89-108-64-209.sslip.io/lk/release-dev.json",
      "https://padlhub.su/lk/release-dev.json",
    ]);
  } finally {
    mocks.restore();
  }
});

test("preferred asset url rewrites hardcoded lk asset to active reserve first", () => {
  const mocks = installWindowMock("https://padlhub.ru", [
    "https://padlhub.su/lk",
    "https://lk-reserve.89-108-64-209.sslip.io/lk",
  ], "https://lk-reserve.89-108-64-209.sslip.io/lk");

  try {
    const assetUrl = resolvePreferredLkAssetUrl("https://padlhub.su/lk/assets/resend.png");

    assert.equal(assetUrl, "https://lk-reserve.89-108-64-209.sslip.io/lk/assets/resend.png");
  } finally {
    mocks.restore();
  }
});

test("preferred asset url falls back to the loaded reserve script origin when globals are absent", () => {
  const mocks = installRuntimeScriptMock("https://lk-reserve.89-108-64-209.sslip.io/lk/games.js?v=123");

  try {
    const assetUrl = resolvePreferredLkAssetUrl("https://padlhub.su/lk/assets/resend.png");

    assert.equal(assetUrl, "https://lk-reserve.89-108-64-209.sslip.io/lk/assets/resend.png");
  } finally {
    mocks.restore();
  }
});
