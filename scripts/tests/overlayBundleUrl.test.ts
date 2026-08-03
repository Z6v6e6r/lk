import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLkAssetBaseUrl,
  resolveOverlayBundleUrl,
  resolveReleaseChannelUrl,
} from "../../src/utils/overlayBundleUrl.ts";

test("release channel URL keeps an explicitly configured URL", () => {
  assert.equal(
    resolveReleaseChannelUrl(
      " https://assets.example.test/custom.js ",
      "https://prod.example.test/default.js",
      "https://dev.example.test/default.js",
      false,
    ),
    "https://assets.example.test/custom.js",
  );
});

test("release channel URL selects the canonical channel fallback", () => {
  assert.equal(
    resolveReleaseChannelUrl(
      undefined,
      "https://prod.example.test/default.js",
      "https://dev.example.test/default.js",
      false,
    ),
    "https://prod.example.test/default.js",
  );
  assert.equal(
    resolveReleaseChannelUrl(
      "",
      "https://prod.example.test/default.js",
      "https://dev.example.test/default.js",
      true,
    ),
    "https://dev.example.test/default.js",
  );
});

test("LK asset base falls back to the canonical production and dev hosts", () => {
  assert.equal(resolveLkAssetBaseUrl(undefined, false), "https://padlhub.su/lk");
  assert.equal(
    resolveLkAssetBaseUrl(undefined, true),
    "https://lk-reserve.89-108-64-209.sslip.io/lk",
  );
});

test("every embedded overlay receives a production and dev fallback", () => {
  for (const bundleName of ["games", "tournaments", "onboarding", "levels-info", "communities"]) {
    assert.equal(
      resolveOverlayBundleUrl(undefined, bundleName, false),
      `https://padlhub.su/lk/${bundleName}.js`,
    );
    assert.equal(
      resolveOverlayBundleUrl(undefined, bundleName, true),
      `https://lk-reserve.89-108-64-209.sslip.io/lk/${bundleName}-dev.js`,
    );
  }
});
