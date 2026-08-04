import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function extractFunctionBlock(marker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);

  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Cannot find body for: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  assert.fail(`Cannot extract function body for: ${marker}`);
}

function toRunnableFunctionExpression(marker: string) {
  const block = extractFunctionBlock(marker);
  const bodyStart = block.indexOf("{");
  assert.ok(bodyStart >= 0, `Cannot find runtime body for: ${marker}`);

  const rawSignature = block.slice(0, bodyStart);
  const signatureEnd = rawSignature.lastIndexOf(")");
  assert.ok(signatureEnd >= 0, `Cannot find signature end for: ${marker}`);

  const signature = `${rawSignature
    .slice(0, signatureEnd + 1)
    .replace(/:\s*[^,)={]+/g, "")}${rawSignature
      .slice(signatureEnd + 1)
      .replace(/\s*:\s*[\s\S]*$/, "")}`;

  return `(${signature}${block.slice(bodyStart)})`;
}

test("split payment payload keeps client subscription id separate from optional subscription template id", () => {
  const buildPayload = new Function(
    `return ${toRunnableFunctionExpression("function buildPadelSplitPaymentPayload")};`,
  )() as (params: Record<string, unknown>) => Record<string, unknown>;

  const payload = buildPayload({
    date: "2026-06-03",
    fromTime: "18:00",
    toTime: "19:00",
    studioId: "studio-1",
    roomId: "room-1",
    shareCount: 4,
    shareAmount: 2500,
    clientSubscriptionId: "client-sport",
    subscriptionId: null,
  });

  assert.equal(payload.clientSubscriptionId, "client-sport");
  assert.equal(payload.subscriptionId, null);
});

test("split payment payload passes distinct subscription id without mirroring client subscription id", () => {
  const buildPayload = new Function(
    `return ${toRunnableFunctionExpression("function buildPadelSplitPaymentPayload")};`,
  )() as (params: Record<string, unknown>) => Record<string, unknown>;

  const payload = buildPayload({
    date: "2026-06-03",
    fromTime: "18:00",
    toTime: "19:00",
    studioId: "studio-1",
    roomId: "room-1",
    shareCount: 4,
    shareAmount: 2500,
    clientSubscriptionId: "client-sport",
    subscriptionId: "product-sport",
  });

  assert.equal(payload.clientSubscriptionId, "client-sport");
  assert.equal(payload.subscriptionId, "product-sport");
});

test("split subscription requests authenticate and send a stable CORS-compatible operationId", () => {
  const requestHelper = extractFunctionBlock("function buildPadelSplitSubscriptionRequest");
  const createFunction = extractFunctionBlock("export async function apiCreatePadelSplitGamePayment");
  const joinFunction = extractFunctionBlock("export async function apiCreatePadelSplitParticipantPayment");

  assert.match(requestHelper, /paymentMode !== "subscription"/);
  assert.match(requestHelper, /operationId=/);
  assert.match(requestHelper, /auth:\s*true as const/);
  assert.doesNotMatch(requestHelper, /Idempotency-Key/);
  assert.match(requestHelper, /buildPadelSplitIdempotencyKey/);
  for (const sourceBlock of [createFunction, joinFunction]) {
    assert.match(sourceBlock, /buildPadelSplitSubscriptionRequest/);
    assert.doesNotMatch(sourceBlock, /auth:\s*true/);
  }
});

test("split callers treat PENDING_CONFIRMATION as an error instead of creating a local game", () => {
  const pendingHelper = extractFunctionBlock("function resolvePadelSplitPendingError");
  const createFunction = extractFunctionBlock("export async function apiCreatePadelSplitGamePayment");
  const joinFunction = extractFunctionBlock("export async function apiCreatePadelSplitParticipantPayment");

  assert.match(pendingHelper, /PENDING_CONFIRMATION/);
  for (const sourceBlock of [createFunction, joinFunction]) {
    assert.match(sourceBlock, /resolvePadelSplitPendingError/);
    assert.match(sourceBlock, /data: null as PadelSplitPaymentResult \| null/);
  }
});
