import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");

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
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`Cannot extract function body for: ${marker}`);
}

test("normalizes Viva pricing preview amounts in minor units", () => {
  const normalizePreview = new Function(
    "pickNumber",
    `return (${extractFunctionBlock("function normalizeTournamentVivaTransactionPreview")
      .replace(/:\s*unknown/g, "")
      .replace(/:\s*TournamentVivaTransactionPreview \| null/g, "")});`,
  )((value: Record<string, unknown>, keys: string[]) => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    }
    return null;
  }) as (value: unknown) => {
    sumMinor: number;
    discountMinor: number;
    toPayMinor: number;
  } | null;

  assert.deepEqual(normalizePreview({
    sumKopecks: 550_000,
    discountKopecks: 451_000,
    toPayKopecks: 99_000,
  }), {
    sumMinor: 550_000,
    discountMinor: 451_000,
    toPayMinor: 99_000,
    raw: {
      sumKopecks: 550_000,
      discountKopecks: 451_000,
      toPayKopecks: 99_000,
    },
  });
  assert.equal(normalizePreview({ discountKopecks: 451_000 }), null);
});

test("promo preview is read-only, authenticated, and never retried", () => {
  const block = extractFunctionBlock("export async function apiPreviewTournamentVivaTransaction");
  assert.match(block, /\/end-user\/api\/v1\/\$\{TENANT_KEY\}\/transactions\/preview/);
  assert.match(block, /method: "POST"/);
  assert.match(block, /auth: true/);
  assert.match(block, /retries: 0/);
  assert.match(block, /buildTournamentVivaTransactionPayload\(params, null, null\)/);
  assert.match(block, /params\.product\.source !== "one-time"/);
});

test("transaction creation is single-shot and reconciles an ambiguous response read-only", () => {
  const block = extractFunctionBlock("export async function apiCreateTournamentVivaTransaction");
  assert.match(block, /retries: 0/);
  assert.doesNotMatch(block, /retries: 1/);
  assert.match(block, /outcomeMayBeUnknown/);
  assert.match(block, /pollTournamentVivaPaymentResolution\(params\.exerciseId, null\)/);
  assert.match(block, /payment_watcher_after_ambiguous_create/);
  assert.match(block, /outcome: "UNKNOWN"/);
  assert.match(block, /Не повторяйте оплату/);
});
