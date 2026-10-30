import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/components/communities/CommunityJoinPage.tsx", import.meta.url),
  "utf8",
);

test("community invitation does not show the redundant cabinet explanation", () => {
  assert.ok(!source.includes("После выбора откроется обычный личный кабинет."));
});

test("existing member CTA opens the exact community while secondary actions remain navigation-only", () => {
  assert.match(source, /redirectToCabinet\(cabinetUrl, community\.id\)/);
  assert.match(source, /void handleJoin\(\);/);
  assert.match(source, /onSecondary=\{handleDecline\}/);
  assert.ok(!source.includes('"Отказаться"'));
});

test("uncertain membership exposes a readback rather than an automatic second join", () => {
  assert.match(source, /visibleState === "error".*visibleState === "pending" \? \(\) => \{ void handleReload\(\); \}/);
  assert.match(source, /allowFallback: false/);
});
