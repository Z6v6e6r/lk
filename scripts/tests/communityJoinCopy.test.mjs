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

test("existing member CTA names the community while preserving join and decline actions", () => {
  assert.match(source, /alreadyMember\s*\? "Открыть сообщество"\s*:\s*"Вступить в сообщество"/);
  assert.match(source, /void handleJoin\(\);/);
  assert.match(source, /onClick=\{handleDecline\}/);
  assert.match(source, /submitting === "decline" \? "Переходим\.\.\." : "Отказаться"/);
});

test("load-error fallback still offers the personal cabinet", () => {
  assert.match(source, /onClick=\{handleDecline\}>\s*Перейти в личный кабинет/);
});
