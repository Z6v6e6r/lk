import assert from "node:assert/strict";
import test from "node:test";
import { resolveOverlayBundleUrl } from "../../src/utils/overlayBundleUrl.ts";

test("overlay bundle URL keeps an explicitly configured URL", () => {
  assert.equal(
    resolveOverlayBundleUrl(" https://assets.example.test/tournaments.js ", "tournaments", false),
    "https://assets.example.test/tournaments.js",
  );
});

test("tournaments overlay falls back to the canonical production bundle", () => {
  assert.equal(
    resolveOverlayBundleUrl(undefined, "tournaments", false),
    "https://padlhub.su/lk/tournaments.js",
  );
});

test("tournaments overlay falls back to the canonical dev bundle", () => {
  assert.equal(
    resolveOverlayBundleUrl("", "tournaments", true),
    "https://lk-reserve.89-108-64-209.sslip.io/lk/tournaments-dev.js",
  );
});
